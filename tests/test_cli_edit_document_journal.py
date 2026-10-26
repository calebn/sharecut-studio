from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import ChapterMarker, EditDecision, EditDecisionType, save_project
from podcast_mcp.project.merge import project_merge_data
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from test_bleed_restore_commands import restore_project as restore_project
from test_edit_modes import episode as episode


def test_add_chapter_cli_saves_one_document_command(tmp_path):
    runner = CliRunner()
    workspace = tmp_path / "episode"
    initialized = runner.invoke(app, ["episode", "init", "--dir", str(workspace)])
    assert initialized.exit_code == 0, initialized.output
    path = workspace / "episode.project.json"
    assert DocumentSyncService.open(path).store.commands_after(0) == []

    result = runner.invoke(
        app,
        ["edit", "add-chapter", "--project", str(path), "--at-time", "1.5", "--title", "Intro"],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"time": 1.5, "title": "Intro", "image_url": None}
    saved = ProjectWorkspace.open(path).project
    assert [(chapter.time, chapter.title) for chapter in saved.chapters] == [(1.5, "Intro")]
    assert [entry.label for entry in saved.history.entries] == ["initial", "after add chapter"]
    rows = DocumentSyncService.open(path).store.commands_after(0)
    assert [row["type"] for row in rows] == ["AddChapter"]
    assert rows[0]["server_seq"] == 1


@pytest.fixture
def edit_project(episode):
    ws = ProjectWorkspace.open(episode)
    ws.project.chapters = [
        ChapterMarker(time=1, title="Intro"),
        ChapterMarker(time=2, title="Intro"),
    ]
    ws.project.edit_decisions = [
        EditDecision(
            id="pending",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1,
            end=1.2,
            reason="filler:um",
            applied=False,
            review_required=True,
        )
    ]
    save_project(ws.project, ws.path)
    ws.record_snapshot("fixture")
    return ws.path


def _invoke(path, args):
    return CliRunner().invoke(app, ["edit", *args, "--project", str(path)])


def _rows(path):
    return DocumentSyncService.open(path).store.commands_after(0)


@pytest.mark.parametrize(
    "args",
    [
        ["cut-range", "--track", "host", "--start", "2", "--end", "3", "--no-inaudible-opt"],
        ["cut-text", "--query", "hello", "--no-inaudible-opt"],
        ["cut-utterance", "--index", "0", "--no-inaudible-opt"],
        ["approve", "--ids", "pending", "--override-audio-checks"],
        ["reject", "--ids", "pending"],
        ["strip-silence", "--track", "guest", "--min-duration", "1"],
        ["ripple-delete", "--start", "2", "--end", "3", "--override-audio-checks"],
        ["ripple-delete", "--query", "hello", "--override-audio-checks"],
        ["move", "--from-start", "2", "--from-end", "3", "--to", "5"],
        ["move", "--from-query", "hello", "--to-after", "world"],
        ["move-clips", "--clips-json", '[{"clip_id":"g1","timeline_start":21,"track_id":"guest"}]'],
        ["insert-gap", "--at", "5", "--duration", "0.2"],
        ["fade-joins", "--track", "host", "--fade-ms", "10"],
        ["fade-joins", "--track", "host"],
        ["crossfade-joins", "--track", "host", "--fade-ms", "10"],
        ["set-clip-join", "--left", "h1", "--right", "h2", "--mode", "cut"],
        [
            "trim-clip",
            "--clip",
            "h2",
            "--edge",
            "out",
            "--source-sec",
            "19",
            "--override-audio-checks",
        ],
        ["remove-chapter", "--title", "Intro"],
        ["shorten-gaps", "--max-gap", "0.35", "--override-audio-checks"],
        ["reconcile-transcript"],
        ["reconcile-transcript", "--apply"],
    ],
    ids=lambda args: " ".join(args),
)
def test_changed_service_cli_publishes_once(edit_project, args):
    before = project_merge_data(ProjectWorkspace.open(edit_project).project)
    result = _invoke(edit_project, args)
    assert result.exit_code == 0, result.output
    after = project_merge_data(ProjectWorkspace.open(edit_project).project)
    assert before != after
    assert [row["type"] for row in _rows(edit_project)] == ["ExternalMutate"]


@pytest.mark.parametrize(
    "args",
    [
        ["fade-joins", "--track", "host", "--dry-run"],
        ["crossfade-joins", "--track", "host", "--dry-run"],
        ["reconcile-transcript", "--dry-run"],
        ["reconcile-transcript", "--dry-run", "--apply"],
        ["apply-bleed-mute", "--track", "host", "--dry-run"],
        ["mute-off-speaker", "--track", "host", "--dry-run"],
        ["align-retained-bleed", "--track", "host", "--dry-run"],
        ["suppress-bleed", "--track", "host", "--dry-run"],
    ],
    ids=lambda args: " ".join(args),
)
def test_explicit_cli_preview_saves_nothing(edit_project, args):
    before = edit_project.read_bytes()
    result = _invoke(edit_project, args)
    assert result.exit_code == 0, result.output
    assert edit_project.read_bytes() == before
    assert _rows(edit_project) == []


@pytest.mark.parametrize(
    "args,stdout",
    [
        (["remove-chapter", "--title", "Absent"], None),
        (["trim-clip", "--clip", "h2", "--edge", "out", "--source-sec", "20"], None),
        (["shorten-gaps", "--max-gap", "100"], None),
    ],
)
def test_unchanged_cli_apply_has_no_external_row(edit_project, args, stdout):
    before = project_merge_data(ProjectWorkspace.open(edit_project).project)
    result = _invoke(edit_project, args)
    assert result.exit_code == 0, result.output
    if stdout is not None:
        assert stdout in result.stdout
    assert project_merge_data(ProjectWorkspace.open(edit_project).project) == before
    assert _rows(edit_project) == []


@pytest.fixture(autouse=True)
def _recording_secret(monkeypatch):
    from types import SimpleNamespace

    registry = SimpleNamespace(recording_key_secret=lambda: b"test recording key" * 2)
    monkeypatch.setattr(
        "podcast_mcp.services.document.timeline.get_share_registry", lambda: registry
    )


@pytest.fixture(autouse=True)
def _external_samples_match_saved_project(monkeypatch):
    from podcast_mcp.services.document_sync import external_apply

    def sample(project):
        saved = ProjectWorkspace.open(project.workspace_path()).project
        result = project_merge_data(project)
        assert result == project_merge_data(saved)
        return result

    monkeypatch.setattr(external_apply, "project_merge_data", sample)


@pytest.mark.parametrize("initialized", [False, True])
@pytest.mark.parametrize("command", ["approve", "apply-suggested"])
def test_zero_accepted_cli_hold_publishes_changed_visible_history(episode, initialized, command):
    from podcast_mcp.gui.assembler import build_project_view

    ws = ProjectWorkspace.open(episode)
    ws.project.edit_decisions = [
        EditDecision(
            id="held",
            track_id="host",
            start=10,
            end=11,
            reason="filler:um",
            review_required=True,
            applied=False,
        )
    ]
    save_project(ws.project, ws.path)
    if initialized:
        ws.record_snapshot("fixture")
    before = {p: build_project_view(ws.path, projection=p).history for p in ("full", "shell")}
    rows_before = _rows(ws.path)
    result = _invoke(ws.path, [command, "--ids", "held"])
    assert result.exit_code == (1 if command == "approve" else 0), result.output
    assert ("Approved 0 edit(s)." if command == "approve" else "Applied nothing") in result.stdout
    saved = ProjectWorkspace.open(ws.path).project
    assert [d.id for d in saved.edit_decisions] == ["held"]
    after = {p: build_project_view(ws.path, projection=p).history for p in ("full", "shell")}
    if initialized and command == "approve":
        assert after == before
        assert _rows(ws.path) == rows_before
    else:
        assert all(after[p] != before[p] for p in before)
        assert [row["type"] for row in _rows(ws.path)] == ["ExternalMutate"]
    if command == "apply-suggested":
        assert saved.edit_decisions[0].cut_speech is not None


def test_no_text_matches_only_publishes_when_saved_lookup_state_changes(edit_project):
    args = ["cut-text", "--query", "absent phrase", "--no-inaudible-opt"]
    first = _invoke(edit_project, args)
    assert first.exit_code == 0, first.output
    assert first.stdout == "Created 0 cut(s)\n"
    saved = project_merge_data(ProjectWorkspace.open(edit_project).project)
    assert [row["type"] for row in _rows(edit_project)] == ["ExternalMutate"]
    second = _invoke(edit_project, args)
    assert second.exit_code == 0, second.output
    assert second.stdout == first.stdout
    assert project_merge_data(ProjectWorkspace.open(edit_project).project) == saved
    assert len(_rows(edit_project)) == 1


def test_partial_approval_publishes_once_and_preserves_cli_override(episode):
    from podcast_mcp.cli.cut_speech import cli_actor

    ws = ProjectWorkspace.open(episode)
    ws.project.edit_decisions = [
        EditDecision(
            id="held",
            track_id="host",
            start=10,
            end=11,
            reason="filler:um",
            applied=False,
            review_required=True,
        ),
        EditDecision(
            id="accepted",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=2,
            end=3,
            reason="manual",
            applied=False,
            review_required=True,
        ),
    ]
    save_project(ws.project, ws.path)
    result = _invoke(ws.path, ["approve", "--all"])
    assert result.exit_code == 0, result.output
    assert "Approved 1 edit(s)." in result.stdout
    assert "Held held:" in result.stderr
    assert [row["type"] for row in _rows(ws.path)] == ["ExternalMutate"]
    saved = ProjectWorkspace.open(ws.path).project
    assert [d.id for d in saved.edit_decisions] == ["held"]
    override = _invoke(ws.path, ["approve", "--ids", "held", "--override-audio-checks"])
    assert override.exit_code == 0, override.output
    saved = ProjectWorkspace.open(ws.path).project
    stamp = saved.editorial.edit_log[-1].params["audio_check_override"]
    assert stamp["actor"] == cli_actor()
    assert stamp["surface"] == "cli"
    assert saved.history.entries[-1].params["audio_check_override"] == stamp
    assert len(_rows(ws.path)) == 2


@pytest.mark.parametrize(
    "args",
    [
        ["ripple-delete", "--start", "10", "--end", "11", "--no-inaudible-opt"],
        ["ripple-delete", "--query", "so the plan", "--no-inaudible-opt"],
        ["trim-clip", "--clip", "h2", "--edge", "out", "--source-sec", "10.5"],
        ["shorten-gaps", "--max-gap", "0.35", "--no-inaudible-opt"],
    ],
)
def test_guarded_cli_hold_preserves_saved_state_and_journal(episode, args):
    before = project_merge_data(ProjectWorkspace.open(episode).project)
    result = _invoke(episode, args)
    assert result.exit_code == 1, result.output
    assert "--override-audio-checks" in result.stderr
    assert project_merge_data(ProjectWorkspace.open(episode).project) == before
    assert _rows(episode) == []


@pytest.mark.parametrize(
    "args,code",
    [
        (
            [
                "move-clips",
                "--clips-json",
                '[{"clip_id":"absent","timeline_start":1,"track_id":"host"}]',
            ],
            "clip_not_found",
        ),
        (
            ["set-clip-join", "--left", "h1", "--right", "h2", "--mode", "bad"],
            "not a valid ClipJoinMode",
        ),
        (["trim-clip", "--clip", "absent", "--edge", "out", "--source-sec", "1"], "clip_not_found"),
        (
            ["cut-range", "--track", "absent", "--start", "1", "--end", "2", "--no-inaudible-opt"],
            "cut_scope_changed",
        ),
    ],
)
def test_invalid_cli_apply_keeps_error_and_has_no_row(edit_project, args, code):
    before = edit_project.read_bytes()
    result = _invoke(edit_project, args)
    assert result.exit_code == 1, result.output
    assert code in result.stderr
    assert edit_project.read_bytes() == before
    assert _rows(edit_project) == []


READ_COMMANDS = [
    ["inspect-clip-bleed", "--clip", "h1", "--track", "host"],
    ["search", "--query", "hello"],
    ["held"],
    ["list"],
    ["impact"],
    ["transcript"],
    ["preview-cut", "--track", "host", "--start", "2", "--end", "3"],
    ["suggest-handoff-cut", "--track", "host", "--keep-left-end", "2", "--keep-right-start", "3"],
    ["join-quality", "--track", "host", "--join", "8"],
    ["join-sweep", "--track", "host"],
    ["join-label", "--track", "host", "--join", "8", "--verdict", "pass"],
    ["join-train"],
    ["copy-segment", "--start", "2", "--end", "3"],
    ["list-chapters"],
    ["list-clips"],
    ["list-applied"],
    ["render-status"],
    ["analyze-cleanup", "--track", "host"],
    ["audio-diagnostics", "--track", "host", "--start", "0", "--end", "1"],
    ["recommend-fades", "--track", "host"],
    ["low-audibility", "--track", "host"],
    ["gate-overreach", "--track", "host"],
    ["audibility-map", "--track", "host"],
    ["flagged-words", "--track", "host"],
    ["reconciliation-status"],
    ["bleed-words", "--track", "host"],
    ["overlap-duplicates"],
]


@pytest.mark.parametrize("args", READ_COMMANDS, ids=lambda args: args[0])
def test_read_and_artifact_cli_commands_do_not_journal(edit_project, args):
    if args[0] == "join-train":
        labeled = _invoke(
            edit_project, ["join-label", "--track", "host", "--join", "8", "--verdict", "pass"]
        )
        assert labeled.exit_code == 0, labeled.output
    before = edit_project.read_bytes()
    result = _invoke(edit_project, args)
    assert result.exit_code == 0, result.output
    assert edit_project.read_bytes() == before
    assert _rows(edit_project) == []


@pytest.mark.parametrize("command", ["propose-edits", "apply-edits", "edit-context"])
def test_adjacent_cli_aliases_keep_the_same_notification_contract(edit_project, command):
    if command == "apply-edits":
        ws = ProjectWorkspace.open(edit_project)
        ws.project.edit_decisions[0].review_required = False
        ws.project.edit_decisions[0].type = EditDecisionType.MUTE
        ws.save()
    before = project_merge_data(ProjectWorkspace.open(edit_project).project)
    result = CliRunner().invoke(app, [command, "--project", str(edit_project)])
    assert result.exit_code == 0, result.output
    after = project_merge_data(ProjectWorkspace.open(edit_project).project)
    assert [row["type"] for row in _rows(edit_project)] == (
        [] if before == after else ["ExternalMutate"]
    )
    if command == "edit-context":
        assert before == after


@pytest.mark.parametrize(
    "args,command_type",
    [
        (["delete-clips", "--ids", "h1", "--mode", "gap"], "DeleteClip"),
        (
            ["propose-range-cut", "--start", "2", "--end", "3", "--tracks", "host"],
            "EditSelectedRange",
        ),
        (["roll-join", "--left", "h1", "--right", "h2", "--delta-sec", "0.1"], "RollClipJoin"),
        (["suppress-low-audibility", "--track", "host"], "SuppressLowAudibility"),
        (["suppress-bleed", "--track", "host"], "SuppressBleed"),
        (["apply-bleed-mute", "--track", "host"], "ExternalMutate"),
        (["mute-off-speaker", "--track", "host"], "ExternalMutate"),
        (["align-retained-bleed", "--track", "host"], "ExternalMutate"),
    ],
)
def test_existing_cli_owners_still_publish_exactly_once(edit_project, args, command_type):
    result = _invoke(edit_project, args)
    assert result.exit_code == 0, result.output
    assert [row["type"] for row in _rows(edit_project)] == [command_type]


def test_cli_copy_paste_keeps_one_typed_owner(edit_project):
    clipboard = _invoke(edit_project, ["copy-segment", "--start", "2", "--end", "3"])
    assert clipboard.exit_code == 0, clipboard.output
    path = edit_project.parent / "clipboard.json"
    path.write_text(clipboard.stdout)
    result = _invoke(
        edit_project, ["paste-segment", "--at", "5", "--clipboard", str(path), "--mode", "gap"]
    )
    assert result.exit_code == 0, result.output
    assert [row["type"] for row in _rows(edit_project)] == ["PasteSegment"]


def test_cli_change_is_observed_by_another_process_watcher(tmp_path):
    import subprocess
    import sys

    ws = ProjectWorkspace.create(tmp_path / "episode")
    watcher = DocumentSyncService.open(ws.path)
    script = """
import sys
from types import SimpleNamespace
from typer.testing import CliRunner
from podcast_mcp.cli.main import app
from podcast_mcp.services.document import timeline
registry = SimpleNamespace(recording_key_secret=lambda: b"test recording key" * 2)
timeline.get_share_registry = lambda: registry
result = CliRunner().invoke(app, sys.argv[1:])
print(result.stdout)
assert result.exit_code == 0, result.output
"""
    for args, command, seq in [
        (["add-chapter", "--at-time", "1", "--title", "Intro"], "AddChapter", 1),
        (["remove-chapter", "--title", "Intro"], "ExternalMutate", 2),
    ]:
        child = subprocess.run(
            [sys.executable, "-c", script, "edit", *args, "--project", str(ws.path)],
            text=True,
            capture_output=True,
            timeout=30,
        )
        assert child.returncode == 0, child.stderr
        event = watcher.publish_cross_process_head(after=seq - 1)
        assert event is not None
        assert event["server_seq"] == seq
        assert event["command"]["type"] == command
        assert len(ProjectWorkspace.open(ws.path).project.chapters) == (1 if seq == 1 else 0)
    assert [row["type"] for row in _rows(ws.path)] == ["AddChapter", "ExternalMutate"]


def test_restore_cli_uses_one_typed_owner(restore_project):
    inspection = _invoke(
        restore_project, ["inspect-clip-bleed", "--clip", "selected", "--track", "host"]
    )
    assert inspection.exit_code == 0, inspection.output
    target = json.loads(inspection.stdout)["regions"][0]["target"]
    path = restore_project.parent / "target.json"
    path.write_text(json.dumps(target))
    args = ["restore-clip-bleed", "--target", str(path), "--command-id", "cli-journal-retry"]
    applied = _invoke(restore_project, args)
    assert applied.exit_code == 0, applied.output
    assert [row["type"] for row in _rows(restore_project)] == ["RestoreClipBleed"]
    retried = _invoke(restore_project, args)
    assert retried.exit_code == 0, retried.output
    assert len(_rows(restore_project)) == 1


def test_alignment_choice_cli_uses_one_typed_owner(tmp_path):
    from test_bleed_alignment_surfaces import _workspace

    ws = _workspace(tmp_path)
    options = ["--track", "uncertain", "--start", "0.8", "--end", "3.5"]
    preview = _invoke(ws.path, ["align-retained-bleed", *options, "--dry-run"])
    assert preview.exit_code == 0, preview.output
    decision = json.loads(preview.stdout)["proposals"][0]["decision_id"]
    result = _invoke(
        ws.path, ["bleed-alignment-choice", *options, "--decision", decision, "--mode", "declined"]
    )
    assert result.exit_code == 0, result.output
    assert [row["type"] for row in _rows(ws.path)] == ["SetBleedAlignmentMode"]


def test_suggested_leave_and_revise_are_one_row_per_committed_batch(edit_project):
    result = _invoke(
        edit_project, ["apply-suggested", "--ids", "pending", "--override", "pending=leave"]
    )
    assert result.exit_code == 0, result.output
    assert "1 leave" in result.stdout
    assert [row["type"] for row in _rows(edit_project)] == ["ExternalMutate"]
    before = project_merge_data(ProjectWorkspace.open(edit_project).project)
    refused = _invoke(edit_project, ["apply-suggested", "--revise", "--ids", "pending"])
    assert refused.exit_code == 1
    assert "revise_takes_no_ids" in refused.stderr
    assert project_merge_data(ProjectWorkspace.open(edit_project).project) == before
    assert len(_rows(edit_project)) == 1
    revised = _invoke(edit_project, ["apply-suggested", "--revise", "--override", "pending=leave"])
    assert revised.exit_code == 0, revised.output
    assert len(_rows(edit_project)) == 2
    saved = ProjectWorkspace.open(edit_project).project
    assert saved.history.entries[-1].operation == "apply_suggested_actions"


def test_decode_leaves_document_database_writable_in_another_process(edit_project, monkeypatch):
    import subprocess
    import sys

    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.services.document_sync import document_db_path

    db = document_db_path(ProjectWorkspace.open(edit_project).project)
    DocumentSyncService.open(edit_project).store.commands_after(0)
    decode = FFmpegEngine.decode_full_f32
    probes = []

    def checked_decode(self, *args, **kwargs):
        if not probes:
            probe = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    """
import sqlite3, sys
with sqlite3.connect(sys.argv[1], timeout=0) as db:
    db.execute("BEGIN IMMEDIATE")
    db.rollback()
print("writer acquired")
""",
                    str(db),
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            assert probe.returncode == 0, probe.stderr
            assert probe.stdout.strip() == "writer acquired"
            probes.append(probe.stdout.strip())
        return decode(self, *args, **kwargs)

    monkeypatch.setattr(FFmpegEngine, "decode_full_f32", checked_decode)
    result = _invoke(edit_project, ["strip-silence", "--track", "guest", "--min-duration", "1"])
    assert result.exit_code == 0, result.output
    assert probes == ["writer acquired"]
    assert [row["type"] for row in _rows(edit_project)] == ["ExternalMutate"]


def test_every_registered_edit_command_has_a_documented_journal_owner():
    from pathlib import Path

    from podcast_mcp.cli.edit import edit_app

    registered = {command.name for command in edit_app.registered_commands}
    doc = (Path(__file__).parents[1] / "docs" / "session-sync.md").read_text()
    table = doc.split("| CLI edit command | Journal owner | Contract |", 1)[1].split("\n\n", 1)[0]
    documented = {line.split("`", 2)[1] for line in table.splitlines() if line.startswith("| `")}
    assert documented == registered
    assert len(registered) == 57


def test_add_chapter_with_fresh_stems_does_not_decode_under_submit(edit_project, monkeypatch):
    import wave

    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.play_audit import stem_is_fresh, write_stem_hash
    from podcast_mcp.util.tracks import stem_path

    ws = ProjectWorkspace.open(edit_project)
    for track in ws.project.tracks:
        source = ws.project.workspace_path() / track.media.path
        stem = stem_path(ws.project, track.id)
        stem.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(source), "rb") as original:
            with wave.open(str(stem), "wb") as output:
                output.setparams(original.getparams())
                output.writeframes(original.readframes(20 * original.getframerate()))
        write_stem_hash(ws.project, track.id, defaults=ws.effective_config())
        assert stem_is_fresh(ws.project, track.id, defaults=ws.effective_config())
    ws.save()
    decoded = []
    decode = FFmpegEngine.decode_full_f32

    def observe(self, *args, **kwargs):
        decoded.append(args)
        return decode(self, *args, **kwargs)

    monkeypatch.setattr(FFmpegEngine, "decode_full_f32", observe)
    result = _invoke(edit_project, ["add-chapter", "--at-time", "3", "--title", "Topic"])
    assert result.exit_code == 0, result.output
    assert decoded == []
    assert [row["type"] for row in _rows(edit_project)] == ["AddChapter"]


def test_text_cut_all_reports_every_created_decision(edit_project):
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance

    ws = ProjectWorkspace.open(edit_project)
    ws.project.transcripts = []
    ws.project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                text="filler",
                start=2 + index * 2,
                end=2.2 + index * 2,
            )
            for index in range(7)
        ]
    )
    ws.save()
    result = _invoke(edit_project, ["cut-text", "--query", "filler", "--all", "--no-inaudible-opt"])
    assert result.exit_code == 0, result.output
    assert result.stdout == "Created 7 cut(s)\n"
    saved = ProjectWorkspace.open(edit_project).project
    assert len(saved.edit_decisions) == 8
    assert [row["type"] for row in _rows(edit_project)] == ["ExternalMutate"]


def test_external_cli_change_keeps_one_undo_step(edit_project):
    from podcast_mcp.services.document import HistoryService

    before = ProjectWorkspace.open(edit_project).project
    geometry = [(c.id, c.timeline_start, c.source_start, c.source_end) for c in before.clips]
    history_count = len(before.history.entries)
    result = _invoke(edit_project, ["insert-gap", "--at", "5", "--duration", "1"])
    assert result.exit_code == 0, result.output
    saved = ProjectWorkspace.open(edit_project).project
    assert len(saved.history.entries) == history_count + 1
    assert saved.history.entries[-1].operation == "insert_gap"
    assert saved.history.entries[-1].params == {"at_time": 5, "duration_sec": 1}
    HistoryService(ProjectWorkspace.open(edit_project)).undo()
    restored = ProjectWorkspace.open(edit_project).project
    assert [
        (c.id, c.timeline_start, c.source_start, c.source_end) for c in restored.clips
    ] == geometry
