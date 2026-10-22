from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pytest
from mcp.client import Client
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.off_speaker_mute import OffSpeakerPlan
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import timeline
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.jobs import run_audio_edit
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import (
    render_cancel_scope,
    render_lock,
)
from test_bleed_alignment_surfaces import _workspace

BUSY = "another render of this project is in progress; try again when it finishes"
WINDOW = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5}
CALLS = {
    "apply_transcript_gate_tool": WINDOW,
    "align_retained_bleed_tool": WINDOW,
    "mute_off_speaker_tool": {"track_id": "uncertain"},
}
PREVIEW_ARGS = {
    "apply_transcript_gate_tool": {**WINDOW, "dry_run": True},
    "align_retained_bleed_tool": {**WINDOW, "apply": False},
    "mute_off_speaker_tool": {"track_id": "uncertain", "dry_run": True},
}
APPLY_PARAMS = [
    pytest.param(name, args, id=name_id)
    for (name, args), name_id in zip(PREVIEW_ARGS.items(), ["gate", "align", "off"], strict=True)
]


@pytest.fixture(autouse=True)
def _off_speaker_plan():
    plan = OffSpeakerPlan(
        track_id="uncertain",
        regions=[{"start": 0.1, "end": 0.9, "duration": 0.8, "audible_sec": 0.8}],
    )
    with patch("podcast_mcp.edits.off_speaker_mute.plan_off_speaker_mutes", return_value=plan):
        yield


async def _call(name: str, path: Path, **args):
    async with Client(mcp_server.mcp) as client:
        return await client.call_tool(name, {"project_path": str(path), **args})


async def _reply(name: str, path: Path, **args) -> dict:
    result = await _call(name, path, **args)
    assert result.is_error is False
    return json.loads(result.content[0].text)


def _types(path: Path) -> list[str]:
    return [row["type"] for row in DocumentSyncService.open(path).store.commands_after(0)]


def _invalidations(path: Path) -> list[tuple[str, list[str]]]:
    project = ProjectWorkspace.open(path).project
    return [(inv.reason, inv.track_ids) for inv in project.render.invalidations]


def _state(path: Path) -> dict:
    return ProjectWorkspace.open(path).project.model_dump(mode="json")


def _geometry(path: Path) -> list[tuple]:
    clips = ProjectWorkspace.open(path).project.clips
    return sorted((c.track_id, c.source_start, c.source_end, c.timeline_start) for c in clips)


def _layout(path: Path) -> dict:
    project = ProjectWorkspace.open(path).project
    return {
        "clips": [clip.model_dump(mode="json") for clip in project.clips],
        "tracks": [track.model_dump(mode="json") for track in project.tracks],
        "alignments": [
            d.model_dump(mode="json") for d in project.editorial.retained_bleed_alignments
        ],
    }


@contextmanager
def _render_lock_held_elsewhere(ws: ProjectWorkspace) -> Iterator[None]:
    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        with render_lock(ws.project):
            held.set()
            release.wait(20)

    holder = threading.Thread(target=hold)
    holder.start()
    assert held.wait(5)
    try:
        yield
    finally:
        release.set()
        holder.join(5)


@pytest.mark.asyncio
async def test_align_tool_reply_shape_for_preview_apply_and_repeat(tmp_path):
    ws = _workspace(tmp_path)
    preview = await _reply("align_retained_bleed_tool", ws.path, **WINDOW, apply=False)
    assert list(preview) == ["proposed_count", "proposals", "skipped"]
    assert preview["proposed_count"] == 1
    assert preview["skipped"] == []
    proposal = preview["proposals"][0]
    assert list(proposal) == [
        "decision_id",
        "direct_track_id",
        "bleed_track_id",
        "clip_id",
        "source_id",
        "source_start",
        "source_end",
        "phrase_source_start",
        "phrase_source_end",
        "previous_timeline_start",
        "timeline_start",
        "offset_sec",
        "provenance",
        "validation_windows",
        "max_residual_ms",
        "reference_track_ids",
        "media_key",
    ]
    assert (proposal["direct_track_id"], proposal["bleed_track_id"]) == ("direct", "uncertain")
    assert (proposal["timeline_start"], proposal["offset_sec"]) == (1.03, -0.15)
    applied = await _reply("align_retained_bleed_tool", ws.path, **WINDOW)
    assert list(applied) == ["applied_count", "alignments", "skipped"]
    assert applied["applied_count"] == 1
    assert applied["skipped"] == []
    alignment = applied["alignments"][0]
    assert list(alignment) == [
        "decision_id",
        "direct_track_id",
        "bleed_track_id",
        "source_id",
        "source_start",
        "source_end",
        "previous_timeline_start",
        "timeline_start",
        "offset_sec",
    ]
    assert alignment["decision_id"] == proposal["decision_id"]
    repeated = await _reply("align_retained_bleed_tool", ws.path, **WINDOW)
    assert repeated == {"applied_count": 0, "alignments": [], "skipped": []}
    after = await _reply("align_retained_bleed_tool", ws.path, **WINDOW, apply=False)
    assert after == {"proposed_count": 0, "proposals": [], "skipped": []}


@pytest.mark.asyncio
async def test_gate_tool_reply_shape_for_preview_apply_and_repeat(tmp_path):
    ws = _workspace(tmp_path)
    stem = str(ws.project.artifacts_dir() / "tracks" / "uncertain.wav")
    preview = await _reply("apply_transcript_gate_tool", ws.path, **WINDOW, dry_run=True)
    assert preview["dry_run"] is True
    assert (preview["candidate_count"], preview["applied_count"]) == (1, 0)
    assert preview["applied"] == []
    assert preview["alignment"]["proposed_count"] == 1
    assert list(preview["candidates"][0]) == [
        "track_id",
        "stem_path",
        "window_start",
        "window_end",
        "interval_count",
        "word_count",
        "suppressed_words",
        "duration_sec",
        "attenuation_count",
        "attenuation_spans",
        "bleed_reduction",
        "bleed_bed_db",
        "gate_reasons",
        "room_tone_fill",
        "room_tone_fill_reason",
    ]
    assert preview["candidates"][0]["stem_path"] == stem
    assert preview == await _reply("apply_transcript_gate_tool", ws.path, **WINDOW, apply=False)
    applied = await _reply("apply_transcript_gate_tool", ws.path, **WINDOW)
    assert list(applied) == [
        "dry_run",
        "candidate_count",
        "candidates",
        "applied_count",
        "applied",
        "skipped",
        "speaker_errors",
        "review_candidate_count",
        "review_candidates",
        "review_exclusions",
        "review_reasons",
        "review_truncated",
        "review_exclusions_truncated",
        "alignment",
    ]
    assert applied["dry_run"] is False
    assert (applied["candidate_count"], applied["applied_count"]) == (1, 1)
    assert applied["applied"][0]["track_id"] == "uncertain"
    assert applied["alignment"]["applied_count"] == 1
    assert list(applied["alignment"]) == ["applied_count", "alignments", "skipped"]
    repeated = await _reply("apply_transcript_gate_tool", ws.path, **WINDOW)
    assert (repeated["dry_run"], repeated["candidate_count"], repeated["applied_count"]) == (
        False,
        0,
        0,
    )
    assert repeated["skipped"] == [
        {
            "track_id": "uncertain",
            "reason": "stem_not_fresh",
            "expected_duration_sec": 6.0,
            "stem_duration_sec": 6.0,
        }
    ]
    assert "alignment" not in repeated


@pytest.mark.asyncio
async def test_gate_tool_without_alignment_has_no_alignment_key(tmp_path):
    ws = _workspace(tmp_path)
    applied = await _reply(
        "apply_transcript_gate_tool", ws.path, **WINDOW, align_retained_bleed=False
    )
    assert applied["applied_count"] == 1
    assert "alignment" not in applied
    assert ProjectWorkspace.open(ws.path).project.editorial.retained_bleed_alignments == []


@pytest.mark.asyncio
async def test_off_speaker_tool_reply_shape_for_preview_apply_and_repeat(tmp_path):
    ws = _workspace(tmp_path)
    summary = [
        "track_id",
        "region_count",
        "muted_sec",
        "audible_muted_sec",
        "quiet_muted_sec",
        "own_word_overlap_sec",
        "kept_uncorrelated_sec",
        "leak_ratio_db",
        "kept_own_word_sec",
        "kept_own_energy_sec",
        "already_quiet_sec",
        "refusal",
        "still_audible_sec",
        "still_audible_copy_sec",
        "judged_words",
        "kept_gaps",
        "regions",
    ]
    preview = await _reply("mute_off_speaker_tool", ws.path, track_id="uncertain", apply=False)
    assert list(preview) == ["dry_run", *summary]
    assert preview["dry_run"] is True
    assert (preview["region_count"], preview["muted_sec"]) == (1, 0.8)
    assert preview == await _reply(
        "mute_off_speaker_tool", ws.path, track_id="uncertain", dry_run=True
    )
    applied = await _reply("mute_off_speaker_tool", ws.path, track_id="uncertain")
    assert list(applied) == [
        "dry_run",
        *summary,
        "applied_count",
        "applied_sec",
        "held_count",
        "held_sec",
        "held",
    ]
    assert applied["dry_run"] is False
    assert (applied["applied_count"], applied["applied_sec"], applied["held"]) == (1, 0.8, [])
    repeated = await _reply("mute_off_speaker_tool", ws.path, track_id="uncertain")
    assert (repeated["applied_count"], repeated["applied_sec"]) == (0, 0)
    assert repeated["region_count"] == 1
    clip = ProjectWorkspace.open(ws.path).project.clips[1]
    assert [(r.start_s, r.end_s) for r in clip.off_speaker_mute_regions] == [(0.1, 0.9)]


@pytest.mark.asyncio
async def test_off_speaker_tool_with_no_regions_returns_the_plan_summary_only(tmp_path):
    ws = _workspace(tmp_path)
    empty = OffSpeakerPlan(track_id="uncertain", regions=[], refusal="no_peer_speech")
    with patch("podcast_mcp.edits.off_speaker_mute.plan_off_speaker_mutes", return_value=empty):
        out = await _reply("mute_off_speaker_tool", ws.path, track_id="uncertain")
    assert out["dry_run"] is False
    assert out["region_count"] == 0
    assert out["refusal"] == "no_peer_speech"
    assert "applied_count" not in out
    assert _types(ws.path) == ["ExternalMutate"]
    assert _invalidations(ws.path) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("name,preview_args", APPLY_PARAMS)
async def test_tools_journal_one_external_mutate_row_per_apply_and_none_for_previews(
    tmp_path, name, preview_args
):
    ws = _workspace(tmp_path)
    assert _types(ws.path) == []
    await _reply(name, ws.path, **preview_args)
    assert _types(ws.path) == []
    await _reply(name, ws.path, **CALLS[name])
    assert _types(ws.path) == ["ExternalMutate"]
    await _reply(name, ws.path, **CALLS[name])
    assert _types(ws.path) == ["ExternalMutate"] * 2


@pytest.mark.asyncio
@pytest.mark.parametrize("name,preview_args", APPLY_PARAMS)
async def test_tool_functions_called_directly_journal_once_for_apply_only(
    tmp_path, name, preview_args
):
    ws = _workspace(tmp_path)
    getattr(timeline, name)(str(ws.path), **{**CALLS[name], **preview_args})
    assert _types(ws.path) == []
    getattr(timeline, name)(str(ws.path), **CALLS[name])
    assert _types(ws.path) == ["ExternalMutate"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,expected",
    [
        pytest.param("align_retained_bleed_tool", [("cut", ["direct"])], id="align"),
        pytest.param(
            "apply_transcript_gate_tool",
            [("cut", ["direct"]), ("other", ["uncertain"])],
            id="gate",
        ),
        pytest.param("mute_off_speaker_tool", [("cut", ["uncertain"])], id="off"),
    ],
)
async def test_apply_records_the_render_invalidation_and_preview_records_none(
    tmp_path, name, expected
):
    ws = _workspace(tmp_path)
    before = _state(ws.path)
    await _reply(name, ws.path, **PREVIEW_ARGS[name])
    assert _invalidations(ws.path) == []
    assert _state(ws.path) == before
    await _reply(name, ws.path, **CALLS[name])
    assert _invalidations(ws.path) == expected
    await _reply(name, ws.path, **CALLS[name])
    assert _invalidations(ws.path) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("name,_args", APPLY_PARAMS)
async def test_previews_leave_project_history_and_files_untouched(tmp_path, name, _args):
    ws = _workspace(tmp_path)
    ws.record_snapshot("baseline")
    status = HistoryService(ws).status()
    before = ws.path.read_bytes()
    await _reply(name, ws.path, **_args)
    assert ws.path.read_bytes() == before
    assert HistoryService(ProjectWorkspace.open(ws.path)).status() == status


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,label",
    [
        pytest.param("align_retained_bleed_tool", "after retained bleed alignment", id="align"),
        pytest.param("apply_transcript_gate_tool", "after apply bleed mute", id="gate"),
        pytest.param("mute_off_speaker_tool", "after mute off speaker", id="off"),
    ],
)
async def test_apply_is_one_history_step_and_one_undo_restores_the_project(tmp_path, name, label):
    ws = _workspace(tmp_path)
    ws.record_snapshot("baseline")
    base = HistoryService(ws).status()
    before_layout = _layout(ws.path)
    await _reply(name, ws.path, **CALLS[name])
    after_layout = _layout(ws.path)
    assert after_layout != before_layout
    status = HistoryService(ProjectWorkspace.open(ws.path)).status()
    assert status["current_label"] == label
    assert status["total"] == base["total"] + 1
    assert status["can_undo"] is True
    HistoryService(ProjectWorkspace.open(ws.path)).undo()
    undone = HistoryService(ProjectWorkspace.open(ws.path)).status()
    assert undone["current_label"] == "baseline"
    assert undone["can_redo"] is True
    assert _layout(ws.path) == before_layout
    HistoryService(ProjectWorkspace.open(ws.path)).redo()
    assert _layout(ws.path) == after_layout


@pytest.mark.asyncio
async def test_repeat_apply_adds_no_history_step_for_align_and_off_speaker(tmp_path):
    for name in ("align_retained_bleed_tool", "mute_off_speaker_tool"):
        ws = _workspace(tmp_path / name)
        await _reply(name, ws.path, **CALLS[name])
        status = HistoryService(ProjectWorkspace.open(ws.path)).status()
        await _reply(name, ws.path, **CALLS[name])
        assert HistoryService(ProjectWorkspace.open(ws.path)).status() == status


@pytest.mark.asyncio
@pytest.mark.parametrize("name", list(CALLS))
async def test_render_lock_held_elsewhere_refuses_with_project_busy_and_changes_nothing(
    tmp_path, name
):
    ws = _workspace(tmp_path)
    before = _state(ws.path)
    with (
        _render_lock_held_elsewhere(ws),
        patch.object(timeline, "REQUEST_RENDER_LOCK_TIMEOUT_SEC", 0.2),
    ):
        result = await _call(name, ws.path, **CALLS[name])
    assert result.is_error is True
    assert result.structured_content == {"ok": False, "error": BUSY, "error_code": "project_busy"}
    assert [part.text for part in result.content] == [BUSY]
    assert _state(ws.path) == before
    assert _types(ws.path) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("name", list(CALLS))
async def test_previews_do_not_wait_for_the_render_lock(tmp_path, name):
    ws = _workspace(tmp_path)
    with (
        _render_lock_held_elsewhere(ws),
        patch.object(timeline, "REQUEST_RENDER_LOCK_TIMEOUT_SEC", 0.2),
    ):
        result = await _call(name, ws.path, **PREVIEW_ARGS[name])
    assert result.is_error is False


@pytest.mark.parametrize("name", list(CALLS))
def test_cancel_while_waiting_for_the_render_lock_raises_cancelled_progress(tmp_path, name):
    ws = _workspace(tmp_path)
    before = _state(ws.path)
    with _render_lock_held_elsewhere(ws):
        with render_cancel_scope(lambda: True):
            with pytest.raises(
                CancelledProgress, match="cancelled while waiting for another render"
            ):
                getattr(timeline, name)(str(ws.path), **CALLS[name])
    assert _state(ws.path) == before


@pytest.mark.asyncio
async def test_off_speaker_tool_refusals_carry_their_codes(tmp_path):
    ws = _workspace(tmp_path)
    unknown = await _call("mute_off_speaker_tool", ws.path, track_id="nope")
    assert unknown.is_error is True
    assert unknown.structured_content == {
        "ok": False,
        "error": "unknown track_id: 'nope'",
        "error_code": "track_not_found",
    }
    missing = await _call("mute_off_speaker_tool", ws.path)
    assert missing.structured_content == {
        "ok": False,
        "error": "track_id or speaker is required",
        "error_code": "missing_argument",
    }
    assert _types(ws.path) == []


def test_run_audio_edit_does_not_journal_when_the_service_raises():
    with (
        patch("podcast_mcp.services.jobs.audio_edits.AnalysisService") as service,
        patch("podcast_mcp.services.document_sync.after_agent_mutation") as journal,
    ):
        service.return_value.mute_off_speaker.side_effect = RuntimeError("boom")
        with pytest.raises(RuntimeError):
            run_audio_edit(object(), "mute_off_speaker", {}, lock_timeout=1.0)
    journal.assert_not_called()


def test_run_audio_edit_journals_exactly_once_on_success():
    ws = object()
    with (
        patch("podcast_mcp.services.jobs.audio_edits.AnalysisService") as service,
        patch("podcast_mcp.services.document_sync.after_agent_mutation") as journal,
    ):
        service.return_value.mute_off_speaker.return_value = {"applied": True}
        result = run_audio_edit(ws, "mute_off_speaker", {"track_id": "t"}, lock_timeout=2.0)
    assert result == {"applied": True}
    service.return_value.mute_off_speaker.assert_called_once_with(
        track_id="t", apply=True, lock_timeout=2.0
    )
    journal.assert_called_once_with(ws)


@pytest.mark.parametrize("op", ["apply_plan", "preview_bleed_mute", "__class__", ""])
def test_run_audio_edit_rejects_any_other_op(op):
    with (
        patch("podcast_mcp.services.jobs.audio_edits.AnalysisService") as service,
        patch("podcast_mcp.services.document_sync.after_agent_mutation") as journal,
    ):
        with pytest.raises(CodedValueError, match="unsupported audio edit op") as raised:
            run_audio_edit(object(), op, {}, lock_timeout=1.0)  # type: ignore[arg-type]
    assert raised.value.code == "unsupported_audio_edit_op"
    service.assert_not_called()
    journal.assert_not_called()


def _cli(path: Path, *args: str):
    return CliRunner().invoke(app, ["edit", args[0], "--project", str(path), *args[1:]])


@pytest.mark.parametrize(
    "command,preview_flag",
    [
        pytest.param("align-retained-bleed", "--dry-run", id="align"),
        pytest.param("apply-bleed-mute", "--dry-run", id="gate"),
        pytest.param("mute-off-speaker", "--dry-run", id="off"),
    ],
)
def test_cli_previews_print_json_and_change_nothing(tmp_path, command, preview_flag):
    ws = _workspace(tmp_path)
    before = _state(ws.path)
    scope = ["--track", "uncertain"]
    result = _cli(ws.path, command, *scope, preview_flag)
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)
    assert result.output == json.dumps(json.loads(result.output), indent=2) + "\n"
    assert _state(ws.path) == before
    assert _types(ws.path) == []
    assert _invalidations(ws.path) == []


@pytest.mark.asyncio
async def test_cli_align_matches_the_tool_reply_and_journals_one_row(tmp_path):
    cli_ws = _workspace(tmp_path / "cli")
    tool_ws = _workspace(tmp_path / "tool")
    options = ["--track", "uncertain", "--start", "0.8", "--end", "3.5"]
    preview = _cli(cli_ws.path, "align-retained-bleed", *options, "--dry-run")
    assert json.loads(preview.output) == await _reply(
        "align_retained_bleed_tool", tool_ws.path, **WINDOW, apply=False
    )
    applied = _cli(cli_ws.path, "align-retained-bleed", *options)
    assert applied.exit_code == 0, applied.output
    assert json.loads(applied.output) == await _reply(
        "align_retained_bleed_tool", tool_ws.path, **WINDOW
    )
    assert _types(cli_ws.path) == ["ExternalMutate"]
    assert _types(tool_ws.path) == ["ExternalMutate"]
    assert _invalidations(cli_ws.path) == _invalidations(tool_ws.path) == [("cut", ["direct"])]
    assert _geometry(cli_ws.path) == _geometry(tool_ws.path)


@pytest.mark.asyncio
async def test_cli_apply_bleed_mute_matches_the_tool_reply_and_journals_one_row(tmp_path):
    cli_ws = _workspace(tmp_path / "cli")
    tool_ws = _workspace(tmp_path / "tool")
    options = ["--track", "uncertain", "--start", "0.8", "--end", "3.5"]
    applied = _cli(cli_ws.path, "apply-bleed-mute", *options)
    assert applied.exit_code == 0, applied.output
    from_tool = await _reply("apply_transcript_gate_tool", tool_ws.path, **WINDOW)
    from_cli = json.loads(applied.output.replace(str(cli_ws.path.parent), str(tool_ws.path.parent)))
    for reply in (from_cli, from_tool):
        for candidate in reply["review_candidates"]:
            del candidate["target"]["media_seals"]
    assert from_cli == from_tool
    assert _types(cli_ws.path) == _types(tool_ws.path) == ["ExternalMutate"]
    assert _invalidations(cli_ws.path) == _invalidations(tool_ws.path)
    no_align = _cli(cli_ws.path, "apply-bleed-mute", "--no-align-retained-bleed", "--dry-run")
    assert no_align.exit_code == 0, no_align.output
    assert "alignment" not in json.loads(no_align.output)


@pytest.mark.asyncio
async def test_cli_mute_off_speaker_matches_the_tool_reply_and_journals_one_row(tmp_path):
    cli_ws = _workspace(tmp_path / "cli")
    tool_ws = _workspace(tmp_path / "tool")
    applied = _cli(cli_ws.path, "mute-off-speaker", "--track", "uncertain")
    assert applied.exit_code == 0, applied.output
    assert json.loads(applied.output) == await _reply(
        "mute_off_speaker_tool", tool_ws.path, track_id="uncertain"
    )
    assert _types(cli_ws.path) == ["ExternalMutate"]
    assert _invalidations(cli_ws.path) == _invalidations(tool_ws.path) == [("cut", ["uncertain"])]


def test_cli_mute_off_speaker_refuses_an_unknown_track_with_its_code(tmp_path):
    ws = _workspace(tmp_path)
    result = _cli(ws.path, "mute-off-speaker", "--track", "nope", "--dry-run")
    assert result.exit_code == 1
    assert (
        "Error: unknown track_id: 'nope' (code track_not_found) "
        "(set PODCAST_DEBUG=1 for the traceback)"
    ) in result.output
    assert _types(ws.path) == []
