"""Inserting a saved segment into an episode."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.ffmpeg import resolve_ffmpeg
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import ChapterMarker, EditDecision
from podcast_mcp.project.io import RETIRED_PROJECT_FILENAME
from podcast_mcp.segments.model import (
    SEGMENT_JSON,
    MediaEntry,
    SegmentClip,
    SegmentFile,
    segment_id_for,
    segment_json,
)
from podcast_mcp.segments.store import SegmentStore, sha256_file
from podcast_mcp.services.collaboration import capabilities_for_role
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand

runner = CliRunner()


def _flac(out: Path, seconds: float) -> Path:
    subprocess.run(
        [
            resolve_ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=330:duration={seconds}",
            "-ar",
            "48000",
            "-ac",
            "1",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
    return out


def _save(
    tmp_path: Path,
    name: str,
    *,
    role: str = "intro",
    fader_db: float = -3.0,
    lanes: tuple[int, ...] = (0,),
    chapter_title: str | None = None,
) -> SegmentFile:
    """A real two second FLAC per lane, saved into the (test-isolated) default library."""
    folder = tmp_path / f"build-{segment_id_for(name)}"
    folder.mkdir()
    clips, media = [], {}
    for index, lane in enumerate(lanes, start=1):
        audio = f"clip-{index:02d}.flac"
        path = _flac(folder / audio, 2.0)
        clips.append(
            SegmentClip(audio=audio, offset_sec=0.0, duration_sec=2.0, fade_in_ms=15, lane=lane)
        )
        media[audio] = MediaEntry(sha256=sha256_file(path), bytes=path.stat().st_size)
    segment = SegmentFile(
        id=segment_id_for(name),
        name=name,
        kind="intro",
        role=TrackRole(role),
        fader_db=fader_db,
        chapter_title=chapter_title,
        clips=clips,
        media=media,
    )
    (folder / SEGMENT_JSON).write_text(segment_json(segment), encoding="utf-8")
    result = SegmentStore().add(folder)
    return SegmentStore().get(result.id, result.version)


@pytest.fixture
def project(tmp_path: Path, ten_second_silence_wav: Path) -> str:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    proj = load_project(Path(path))
    shutil.copyfile(ten_second_silence_wav, Path(path).parent / "raw" / "host.wav")
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
        Track(
            id="jingles",
            label="Jingles",
            role=TrackRole.INTRO,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
    ]
    proj.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=6.0, source_end=10.0, timeline_start=4.0),
    ]
    proj.chapters = [ChapterMarker(time=6.0, title="Later")]
    save_project(proj, Path(path))
    return path


def _layout(path: str) -> list[tuple[str, str, float, float]]:
    return sorted(
        (
            c.track_id,
            c.segment_ref.segment_id if c.segment_ref else "-",
            c.timeline_start,
            c.timeline_end,
        )
        for c in load_project(Path(path)).clips
    )


def _insert(path: str, segment_id: str, at: float, *extra: str):
    return runner.invoke(app, ["segment", "insert", path, segment_id, "--at", str(at), *extra])


def test_insert_opens_time_and_places_the_segment_with_a_reference(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "Warm Intro", chapter_title="Welcome")

    result = _insert(project, segment.id, 4.0, "--json")

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["operation"] == "insert_segment"
    loaded = load_project(Path(project))
    by_id = {c.id: c for c in loaded.clips}
    assert by_id["c1"].timeline_end == 4.0
    assert by_id["c2"].timeline_start == pytest.approx(6.0)
    placed = [c for c in loaded.clips if c.segment_ref]
    assert len(placed) == 1
    clip = placed[0]
    # Lane 0 of a non-dialogue segment lands on the project's track of that role.
    assert (clip.track_id, clip.timeline_start, clip.timeline_end) == ("jingles", 4.0, 6.0)
    assert (clip.fade_in_ms, clip.source_start, clip.source_end) == (15, 0.0, 2.0)
    assert clip.segment_ref.segment_id == segment.id
    assert clip.segment_ref.version == 1
    assert clip.segment_ref.content_sha256 == segment.content_sha256
    source = loaded.source_by_id(clip.source_id)
    assert source is not None
    copied = Path(project).parent / source.path
    assert sha256_file(copied) == segment.media["clip-01.flac"].sha256
    assert loaded.timeline.duration_sec == pytest.approx(10.0)
    # Later chapters move with the content; the segment's own chapter marks the start.
    assert [(c.time, c.title) for c in loaded.chapters] == [(4.0, "Welcome"), (8.0, "Later")]
    assert [r["type"] for r in DocumentSyncService.open(project).store.commands_after(0)] == [
        "InsertSegment"
    ]


def test_insert_is_one_undo_step_and_redo_puts_it_back(tmp_path: Path, project: str) -> None:
    segment = _save(tmp_path, "Warm Intro", role="dialogue", lanes=(0, 1))
    before = _layout(project)
    tracks_before = [t.id for t in load_project(Path(project)).tracks]

    assert _insert(project, segment.id, 2.0).exit_code == 0
    after = _layout(project)
    assert after != before

    assert runner.invoke(app, ["undo", "--project", project]).exit_code == 0
    assert _layout(project) == before
    assert [t.id for t in load_project(Path(project)).tracks] == tracks_before

    assert runner.invoke(app, ["redo", "--project", project]).exit_code == 0
    assert _layout(project) == after


def test_tampered_library_audio_is_refused_and_nothing_changes(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "Warm Intro")
    before = _layout(project)
    audio = SegmentStore().path(segment.id, 1) / "clip-01.flac"
    audio.write_bytes(audio.read_bytes()[:-8] + b"tampered")

    result = _insert(project, segment.id, 4.0)

    assert result.exit_code == 1
    assert "segment_hash_mismatch" in result.output
    assert _layout(project) == before
    assert not list((Path(project).parent / "raw").glob("segment-*"))


def test_audio_changed_while_copying_is_refused(
    tmp_path: Path, project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The hash is checked on the project's copy, not only on the library file."""
    from podcast_mcp.services.document import segment_insert

    segment = _save(tmp_path, "Warm Intro")
    real_copy = shutil.copyfile

    def corrupting_copy(src, dst, **kwargs):
        real_copy(src, dst, **kwargs)
        Path(dst).write_bytes(Path(dst).read_bytes() + b"x")
        return dst

    monkeypatch.setattr(segment_insert.shutil, "copyfile", corrupting_copy)
    result = _insert(project, segment.id, 4.0)
    assert result.exit_code == 1
    assert "segment_hash_mismatch" in result.output
    assert not list((Path(project).parent / "raw").glob("segment-*"))
    assert not list((Path(project).parent / "raw").glob(".segment-*"))


def test_a_layout_longer_than_a_day_is_refused(tmp_path: Path, project: str) -> None:
    segment = _save(tmp_path, "Warm Intro")
    before = _layout(project)
    manifest = SegmentStore().path(segment.id, 1) / SEGMENT_JSON
    crafted = json.loads(manifest.read_text(encoding="utf-8"))
    crafted["clips"][0]["offset_sec"] = 1e300
    manifest.write_text(json.dumps(crafted), encoding="utf-8")

    result = _insert(project, segment.id, 4.0)

    assert result.exit_code == 1
    assert "segment_media_invalid" in result.output
    assert _layout(project) == before
    assert not list((Path(project).parent / "raw").glob("segment-*"))


@pytest.mark.parametrize(
    ("field", "value"),
    [("fade_in_ms", 10**400), ("fade_out_ms", 4_000_000), ("duration_sec", 1e-320)],
)
def test_a_crafted_fade_or_sliver_is_refused_before_any_copy(
    tmp_path: Path, project: str, field: str, value: float
) -> None:
    segment = _save(tmp_path, "Warm Intro")
    before = _layout(project)
    manifest = SegmentStore().path(segment.id, 1) / SEGMENT_JSON
    crafted = json.loads(manifest.read_text(encoding="utf-8"))
    crafted["clips"][0][field] = value
    manifest.write_text(json.dumps(crafted), encoding="utf-8")

    result = _insert(project, segment.id, 4.0)

    assert result.exit_code == 1
    assert "segment_media_invalid" in result.output
    assert _layout(project) == before
    assert not list((Path(project).parent / "raw").glob("segment-*"))


def test_missing_segment_and_version_are_refused(tmp_path: Path, project: str) -> None:
    segment = _save(tmp_path, "Warm Intro")
    before = _layout(project)

    unknown = _insert(project, "nothing-12345678", 1.0)
    assert unknown.exit_code == 1 and "segment_unknown" in unknown.output

    no_version = _insert(project, segment.id, 1.0, "--version", "7")
    assert no_version.exit_code == 1 and "segment_unknown" in no_version.output
    assert _layout(project) == before


@pytest.mark.parametrize("at", ["-1", "10.5", "nan", "inf"])
def test_a_position_off_the_timeline_is_refused(tmp_path: Path, project: str, at: str) -> None:
    segment = _save(tmp_path, "Warm Intro")
    before = _layout(project)

    result = _insert(project, segment.id, float(at))

    assert result.exit_code == 1
    assert "segment_position_out_of_range" in result.output
    assert _layout(project) == before


def test_the_start_and_the_end_of_the_timeline_are_valid_positions(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "Warm Intro")
    assert _insert(project, segment.id, 0.0).exit_code == 0
    assert _insert(project, segment.id, 10.0).exit_code == 0
    placed = sorted(
        (c.timeline_start, c.timeline_end)
        for c in load_project(Path(project)).clips
        if c.segment_ref
    )
    assert placed == [(0.0, 2.0), (10.0, 12.0)]


def test_inserting_the_same_segment_twice_stores_its_audio_once(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "Warm Intro")
    assert _insert(project, segment.id, 0.0).exit_code == 0
    assert _insert(project, segment.id, 6.0).exit_code == 0
    loaded = load_project(Path(project))
    assert len(list((Path(project).parent / "raw").glob("segment-*"))) == 1
    assert len([s for s in loaded.sources if s.id.startswith("seg_")]) == 1
    assert not list((Path(project).parent / "raw").glob(".segment-*"))


def test_a_dialogue_segment_gets_its_own_track_with_the_segment_level(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "Sponsor Read", role="dialogue", fader_db=-6.0)
    assert _insert(project, segment.id, 4.0).exit_code == 0
    loaded = load_project(Path(project))
    new = [t for t in loaded.tracks if t.id not in ("host", "jingles")]
    assert [(t.role, t.fader_db, t.label) for t in new] == [
        (TrackRole.DIALOGUE, -6.0, "Sponsor Read")
    ]
    # A dialogue track is in every ripple, so the speakers stay in sync.
    host = {c.id: c.timeline_start for c in loaded.clips if c.track_id == "host"}
    assert host["c2"] == pytest.approx(6.0)


def test_each_lane_gets_its_own_track_and_a_new_role_makes_a_track(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "Bed And Voice", role="music", lanes=(0, 1))
    assert _insert(project, segment.id, 4.0).exit_code == 0
    loaded = load_project(Path(project))
    placed = {c.track_id: c for c in loaded.clips if c.segment_ref}
    assert len(placed) == 2
    music = [t for t in loaded.tracks if t.role is TrackRole.MUSIC]
    assert [t.id for t in music] == sorted(placed)
    assert all(t.fader_db == -3.0 for t in music)
    assert all(c.timeline_start == 4.0 for c in placed.values())
    # The music tracks are edited tracks, so they open the time too and stay aligned.
    assert load_project(Path(project)).timeline.duration_sec == pytest.approx(10.0)


def test_a_pending_decision_after_the_point_moves_with_the_content(
    tmp_path: Path, project: str
) -> None:
    proj = load_project(Path(project))
    proj.editorial.edit_decisions = [
        EditDecision(
            id="later", track_id="host", start=5.0, end=5.5, applied=False, timebase="timeline"
        ),
        EditDecision(
            id="earlier", track_id="host", start=1.0, end=1.5, applied=False, timebase="timeline"
        ),
    ]
    save_project(proj, Path(project))
    segment = _save(tmp_path, "Warm Intro")

    assert _insert(project, segment.id, 4.0).exit_code == 0

    moved = {d.id: (d.start, d.end) for d in load_project(Path(project)).editorial.edit_decisions}
    assert moved == {"later": (7.0, 7.5), "earlier": (1.0, 1.5)}


def test_a_stale_file_at_the_raw_name_is_never_trusted(tmp_path: Path, project: str) -> None:
    segment = _save(tmp_path, "Warm Intro")
    digest = segment.media["clip-01.flac"].sha256
    stale = Path(project).parent / "raw" / f"segment-{digest}.flac"
    stale.write_bytes(b"not the audio")

    assert _insert(project, segment.id, 4.0).exit_code == 0

    assert sha256_file(stale) == digest
    source = next(s for s in load_project(Path(project)).sources if s.id.startswith("seg_"))
    assert source.duration_sec == pytest.approx(2.0, abs=0.1)
    assert source.path == f"raw/segment-{digest}.flac"


def test_an_editor_share_cannot_insert_a_segment(tmp_path: Path, project: str) -> None:
    from podcast_mcp.services.document_sync import DocumentSyncService

    segment = _save(tmp_path, "Warm Intro")
    before = _layout(project)
    command = DocumentCommand(
        type="InsertSegment",
        payload={"segment_id": segment.id, "at": 4.0},
        client_id="guest",
        client_seq=None,
        role="guest",
    )
    with pytest.raises(PermissionError, match="InsertSegment"):
        DocumentSyncService.open(project).submit(
            command, capabilities=capabilities_for_role("editor")
        )
    assert _layout(project) == before


def test_a_dialogue_segment_named_like_a_speaker_does_not_join_that_speaker(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "host", role="dialogue")
    assert _insert(project, segment.id, 4.0).exit_code == 0
    loaded = load_project(Path(project))
    new = [t for t in loaded.tracks if t.id not in ("host", "jingles")]
    assert len(new) == 1
    assert new[0].speaker == "host (segment)" and new[0].label == "host (segment)"
    assert [t.speaker for t in loaded.tracks if t.id == "host"] == ["Host"]


def test_an_old_clip_has_no_segment_ref_key_on_disk(project: str) -> None:
    text = Path(project).read_text(encoding="utf-8")
    assert "segment_ref" not in text


def test_insert_at_start_and_end_resolve_to_the_timeline_edges(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "Warm Intro")

    assert _insert(project, segment.id, 0, "--json").exit_code == 0
    result = runner.invoke(app, ["segment", "insert", project, segment.id, "--at", "end", "--json"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["at"] == pytest.approx(10.0)
    placed = sorted(
        (c.timeline_start, c.timeline_end)
        for c in load_project(Path(project)).clips
        if c.segment_ref
    )
    assert placed == [(0.0, 2.0), (10.0, 12.0)]

    started = runner.invoke(
        app, ["segment", "insert", project, segment.id, "--at", " Start ", "--json"]
    )
    assert started.exit_code == 0, started.output
    assert json.loads(started.output)["at"] == 0.0


@pytest.mark.parametrize("at", ["middle", "-1", "99"])
def test_insert_refuses_a_position_that_is_not_on_the_timeline(
    tmp_path: Path, project: str, at: str
) -> None:
    segment = _save(tmp_path, "Warm Intro")
    before = _layout(project)

    result = runner.invoke(app, ["segment", "insert", project, segment.id, "--at", at])

    assert result.exit_code != 0
    assert "segment_position_out_of_range" in result.output
    assert _layout(project) == before


def test_dry_run_reports_what_moves_and_changes_nothing(tmp_path: Path, project: str) -> None:
    segment = _save(tmp_path, "Warm Intro", chapter_title="Welcome", role="dialogue", lanes=(0, 1))
    before_bytes = Path(project).read_bytes()
    raw_files = sorted(p.name for p in (Path(project).parent / "raw").iterdir())

    result = runner.invoke(
        app, ["segment", "insert", project, segment.id, "--at", "4", "--dry-run", "--json"]
    )

    assert result.exit_code == 0, result.output
    report = json.loads(result.output)
    assert report["dry_run"] is True
    assert report["duration_sec"] == pytest.approx(2.0)
    assert report["timeline_duration_before_sec"] == pytest.approx(8.0)
    assert report["timeline_duration_after_sec"] == pytest.approx(10.0)
    assert report["clips_moved"] == 1
    assert report["chapters_moved"] == [{"title": "Later", "from": 6.0, "to": 8.0}]
    assert report["chapter_added"] == "Welcome"
    assert len(report["tracks_added"]) == 2
    assert Path(project).read_bytes() == before_bytes
    assert sorted(p.name for p in (Path(project).parent / "raw").iterdir()) == raw_files
    assert DocumentSyncService.open(project).store.commands_after(0) == []

    text = runner.invoke(
        app, ["segment", "insert", project, segment.id, "--at", "end", "--dry-run"]
    )
    assert text.exit_code == 0, text.output
    assert "Nothing was changed" in text.output


def test_dry_run_refuses_what_a_real_insert_refuses(tmp_path: Path, project: str) -> None:
    segment = _save(tmp_path, "Warm Intro")

    result = runner.invoke(
        app, ["segment", "insert", project, segment.id, "--at", "50", "--dry-run"]
    )
    assert result.exit_code != 0
    assert "segment_position_out_of_range" in result.output

    missing = runner.invoke(
        app, ["segment", "insert", project, "nope-00000000", "--at", "1", "--dry-run"]
    )
    assert missing.exit_code != 0
    assert "segment_unknown" in missing.output


def test_host_mcp_tools_list_show_save_and_insert(tmp_path: Path, project: str) -> None:
    from podcast_mcp.mcp.tools import segments as tools

    assert json.loads(tools.segment_list_tool()) == []
    clip = load_project(Path(project)).clips[0]
    saved = json.loads(
        tools.segment_save_tool(project, "Cold Open", clip_ids=[clip.id], kind="intro")
    )
    assert saved["status"] == "added"
    again = json.loads(tools.segment_save_tool(project, "Cold Open", time_range="0:00-0:04"))
    assert again["id"] == saved["id"]

    rows = json.loads(tools.segment_list_tool())
    assert [r["id"] for r in rows] == [saved["id"]]
    shown = json.loads(tools.segment_show_tool(saved["id"]))
    assert shown["name"] == "Cold Open"
    assert shown["versions"] == [saved["version"]]

    before = _layout(project)
    preview = json.loads(tools.segment_insert_tool(project, saved["id"], "end", dry_run=True))
    assert preview["dry_run"] is True
    assert _layout(project) == before

    result = json.loads(tools.segment_insert_tool(project, saved["id"], "start"))
    assert result["operation"] == "insert_segment"
    assert result["at"] == 0.0
    placed = [c for c in load_project(Path(project)).clips if c.segment_ref]
    assert len(placed) == 1 and placed[0].timeline_start == 0.0
    assert [r["type"] for r in DocumentSyncService.open(project).store.commands_after(0)] == [
        "InsertSegment"
    ]

    assert runner.invoke(app, ["undo", "--project", project]).exit_code == 0
    assert _layout(project) == before

    numeric = json.loads(tools.segment_insert_tool(project, saved["id"], 4.0))
    assert numeric["at"] == 4.0


def test_host_mcp_segment_tools_refuse_with_codes(tmp_path: Path, project: str) -> None:
    from podcast_mcp.mcp.tools import segments as tools
    from podcast_mcp.util.coded_error import CodedValueError

    with pytest.raises(CodedValueError) as unknown:
        tools.segment_show_tool("nope-00000000")
    assert unknown.value.code == "segment_unknown"
    with pytest.raises(CodedValueError) as selection:
        tools.segment_save_tool(project, "X")
    assert selection.value.code == "segment_selection_invalid"
    segment = _save(tmp_path, "Warm Intro")
    with pytest.raises(CodedValueError) as where:
        tools.segment_insert_tool(project, segment.id, 99.0)
    assert where.value.code == "segment_position_out_of_range"


def test_segment_tools_are_registered_for_the_host_and_absent_for_guests() -> None:
    import asyncio

    from podcast_mcp.services.remote_mcp.allowlist import ALL_GUEST_TOOLS
    from podcast_mcp.services.remote_mcp.tools import TOOL_HANDLERS

    names = {
        "segment_list_tool",
        "segment_show_tool",
        "segment_save_tool",
        "segment_insert_tool",
    }
    registered = {t.name for t in asyncio.run(mcp_server.mcp.list_tools())}
    assert names <= registered
    assert names.isdisjoint(ALL_GUEST_TOOLS)
    assert names.isdisjoint(TOOL_HANDLERS)
    assert not any("segment" in name for name in ALL_GUEST_TOOLS if "chapter" not in name)


def test_the_journal_names_the_version_that_went_in(tmp_path: Path, project: str) -> None:
    first = _save(tmp_path, "Warm Intro")
    assert _insert(project, first.id, 0).exit_code == 0
    second_dir = tmp_path / "second"
    second_dir.mkdir()
    # Same name, other audio: the next version.
    audio = _flac(second_dir / "clip-01.flac", 2.5)
    newer = first.model_copy(
        update={
            "clips": [first.clips[0].model_copy(update={"duration_sec": 2.5})],
            "media": {
                "clip-01.flac": MediaEntry(sha256=sha256_file(audio), bytes=audio.stat().st_size)
            },
        }
    )
    (second_dir / SEGMENT_JSON).write_text(segment_json(newer), encoding="utf-8")
    assert SegmentStore().add(second_dir).version == 2

    stored = DocumentSyncService.open(project).store.commands_after(0)
    assert stored[0]["payload"]["version"] == 1
    inserted = json.loads(
        runner.invoke(app, ["segment", "insert", project, first.id, "--at", "end", "--json"]).output
    )
    assert inserted["segment_version"] == 2
    again = DocumentSyncService.open(project).store.commands_after(0)
    assert [c["payload"]["version"] for c in again] == [1, 2]
    assert again[1]["payload"]["at"] == "end"


def test_end_is_resolved_under_the_lock_not_from_a_snapshot(tmp_path: Path, project: str) -> None:
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import insert_saved_segment

    segment = _save(tmp_path, "Warm Intro")
    stale = ProjectWorkspace.open(project)
    # Another writer appends 3 s after the workspace was opened.
    other = ProjectWorkspace.open(project)

    def _append(p) -> None:
        p.clips.append(
            Clip(id="c3", track_id="host", source_start=0.0, source_end=3.0, timeline_start=8.0)
        )

    other.mutate("before append", "after append", _append)
    result = insert_saved_segment(stale, segment.id, "end")

    assert result.at == pytest.approx(11.0)
    placed = [c for c in load_project(Path(project)).clips if c.segment_ref]
    assert placed[0].timeline_start == pytest.approx(11.0)


@pytest.mark.parametrize("version", ["0", "-2"])
def test_a_bad_version_has_the_same_code_on_both_paths(
    tmp_path: Path, project: str, version: str
) -> None:
    segment = _save(tmp_path, "Warm Intro")
    for extra in ([], ["--dry-run"]):
        result = runner.invoke(
            app,
            ["segment", "insert", project, segment.id, "--at", "1", "--version", version, *extra],
        )
        assert result.exit_code != 0
        assert "segment_version_invalid" in result.output, result.output
    from podcast_mcp.services.document_sync.payloads import validate_payload
    from podcast_mcp.util.coded_error import CodedValueError

    for bad in (0, True, "2", 1.5):
        with pytest.raises(CodedValueError) as raised:
            validate_payload("InsertSegment", {"segment_id": "x", "at": 1.0, "version": bad})
        assert raised.value.code == "segment_version_invalid"


@pytest.mark.parametrize("at", ["End", " START ", "soon", "1_0", "0x10", "nan", True, None])
def test_the_mcp_position_goes_through_the_one_parser(
    tmp_path: Path, project: str, at: object
) -> None:
    from podcast_mcp.mcp.tools import segments as tools
    from podcast_mcp.util.coded_error import CodedValueError

    segment = _save(tmp_path, "Warm Intro")
    before = _layout(project)
    if isinstance(at, str) and at.strip().casefold() in ("end", "start"):
        out = json.loads(tools.segment_insert_tool(project, segment.id, at, dry_run=True))
        assert out["at"] == (8.0 if at.strip().casefold() == "end" else 0.0)
        return
    with pytest.raises(CodedValueError) as raised:
        tools.segment_insert_tool(project, segment.id, at)  # type: ignore[arg-type]
    assert raised.value.code == "segment_position_out_of_range"
    assert _layout(project) == before


def test_the_mcp_schema_takes_text_for_at() -> None:
    import asyncio

    tool = next(
        t for t in asyncio.run(mcp_server.mcp.list_tools()) if t.name == "segment_insert_tool"
    )
    kinds = {opt.get("type") for opt in tool.input_schema["properties"]["at"]["anyOf"]}
    assert "string" in kinds and "enum" not in json.dumps(tool.input_schema["properties"]["at"])


def test_dry_run_probes_the_audio_and_refuses_what_the_insert_refuses(
    tmp_path: Path, project: str
) -> None:
    segment = _save(tmp_path, "Warm Intro")
    folder = SegmentStore().path(segment.id)
    # The layout says 2 s but the stored file is 1 s long (hash and size recorded to match).
    short = _flac(tmp_path / "short.flac", 1.0)
    (folder / "clip-01.flac").write_bytes(short.read_bytes())
    stored = json.loads((folder / SEGMENT_JSON).read_text(encoding="utf-8"))
    stored["media"]["clip-01.flac"] = {"sha256": sha256_file(short), "bytes": short.stat().st_size}
    (folder / SEGMENT_JSON).write_text(json.dumps(stored), encoding="utf-8")

    dry = runner.invoke(app, ["segment", "insert", project, segment.id, "--at", "1", "--dry-run"])
    real = _insert(project, segment.id, 1)

    assert dry.exit_code != 0 and real.exit_code != 0
    assert "segment_media_invalid" in dry.output
    assert "segment_media_invalid" in real.output


def test_read_paths_do_not_rename_a_legacy_project_file(tmp_path: Path, project: str) -> None:
    from podcast_mcp.mcp.tools import segments as tools

    segment = _save(tmp_path, "Warm Intro")
    entry = Path(project)
    retired = entry.with_name(RETIRED_PROJECT_FILENAME)
    entry.rename(retired)

    dry = runner.invoke(
        app, ["segment", "insert", str(retired), segment.id, "--at", "end", "--dry-run"]
    )
    assert dry.exit_code == 0, dry.output
    assert retired.exists() and not entry.exists()
    json.loads(tools.segment_insert_tool(str(retired), segment.id, "end", dry_run=True))
    clip = load_project(retired).clips[0]
    tools.segment_save_tool(str(retired), "Cold Open", clip_ids=[clip.id])
    assert retired.exists() and not entry.exists()


def _preview_wire(segment_id: str, **moved: object) -> dict[str, object]:
    return {
        "dry_run": True,
        "segment_id": segment_id,
        "segment_version": 1,
        "at": 4.0,
        "duration_sec": 2.0,
        "timeline_duration_before_sec": 8.0,
        "timeline_duration_after_sec": 10.0,
        "clips_moved": 1,
        "clips_added": 2,
        "clips_from_segment": 2,
        "chapters_moved": [{"title": "Later", "from": 6.0, "to": 8.0}],
        "chapter_added": "Welcome",
        "comments_moved": [],
        "pending_edits_moved": 0,
        "tracks_added": ["warm_intro", "warm_intro_2"],
        "tracks": {"0": "warm_intro", "1": "warm_intro_2"},
        **moved,
    }


def test_the_insert_reports_print_the_same_bytes_as_before(tmp_path: Path, project: str) -> None:
    from podcast_mcp.mcp.tools import segments as tools

    segment = _save(tmp_path, "Warm Intro", chapter_title="Welcome", role="dialogue", lanes=(0, 1))
    plain = _save(tmp_path, "Plain Sting")

    preview = tools.segment_insert_tool(project, segment.id, 4.0, dry_run=True)
    assert preview == json.dumps(_preview_wire(segment.id), indent=2)

    no_chapter = tools.segment_insert_tool(project, plain.id, "end", dry_run=True)
    assert no_chapter == json.dumps(
        _preview_wire(
            plain.id,
            at=8.0,
            clips_moved=0,
            clips_added=1,
            clips_from_segment=1,
            chapters_moved=[],
            chapter_added=None,
            tracks_added=[],
            tracks={"0": "jingles"},
        ),
        indent=2,
    )

    inserted = tools.segment_insert_tool(project, segment.id, 4.0)
    assert inserted == json.dumps(
        {
            "dry_run": False,
            "segment_id": segment.id,
            "segment_version": 1,
            "at": 4.0,
            "duration_sec": 2.0,
            "operation": "insert_segment",
            "affected_tracks": ["host", "warm_intro", "warm_intro_2"],
            "clip_count": 4,
            "timeline_duration_sec": 10.0,
            "tracks": {"0": "warm_intro", "1": "warm_intro_2"},
        },
        indent=2,
    )
    cli = runner.invoke(app, ["segment", "insert", project, plain.id, "--at", "end", "--json"])
    assert cli.exit_code == 0, cli.output
    assert list(json.loads(cli.output)) == list(json.loads(inserted))


def test_the_journal_keeps_the_handler_result_in_its_order(tmp_path: Path, project: str) -> None:
    segment = _save(tmp_path, "Plain Sting")
    command = DocumentCommand(
        type="InsertSegment",
        payload={"segment_id": segment.id, "at": 2.0},
        client_id="gui",
        client_seq=None,
        role="owner",
    )

    reply = DocumentSyncService.open(project).submit(command)

    expected = {
        "operation": "insert_segment",
        "affected_tracks": ["host", "jingles"],
        "clip_count": 4,
        "timeline_duration_sec": 10.0,
        "segment_id": segment.id,
        "segment_version": 1,
        "at": 2.0,
        "duration_sec": 2.0,
        "tracks": {"0": "jingles"},
    }
    result = reply["command"]["payload"]["result"]
    assert json.dumps(result) == json.dumps(expected)
    stored = DocumentSyncService.open(project).store.commands_after(0)
    assert json.dumps(stored[0]["payload"]["result"]) == json.dumps(expected)


@pytest.mark.parametrize("dry_run", [True, False])
def test_a_refused_insert_keeps_its_code_on_every_path(
    tmp_path: Path, project: str, dry_run: bool
) -> None:
    from podcast_mcp.mcp.tools import segments as tools
    from podcast_mcp.util.coded_error import CodedValueError

    segment = _save(tmp_path, "Plain Sting")
    flags = ["--dry-run"] if dry_run else []

    with pytest.raises(CodedValueError) as refused:
        tools.segment_insert_tool(project, segment.id, 500.0, dry_run=dry_run)
    cli = runner.invoke(app, ["segment", "insert", project, segment.id, "--at", "500", *flags])

    assert refused.value.code == "segment_position_out_of_range"
    assert cli.exit_code == 1
    assert "(code segment_position_out_of_range)" in cli.output


def test_the_insert_results_are_typed_and_refuse_unknown_keys(tmp_path: Path, project: str) -> None:
    from pydantic import ValidationError

    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import (
        SegmentInsertApplied,
        SegmentInsertPreview,
        insert_saved_segment,
        preview_segment_insert,
    )

    segment = _save(tmp_path, "Warm Intro", chapter_title="Welcome", role="dialogue", lanes=(0, 1))
    ws = ProjectWorkspace.open(project)

    preview = preview_segment_insert(ws, segment.id, 4.0)
    applied = insert_saved_segment(ws, segment.id, 4.0)

    assert isinstance(preview, SegmentInsertPreview)
    assert preview.chapters_moved[0].to == 8.0
    assert isinstance(applied, SegmentInsertApplied)
    assert applied.tracks == {"0": "warm_intro", "1": "warm_intro_2"}
    assert preview.model_dump()["chapters_moved"] == [{"title": "Later", "from": 6.0, "to": 8.0}]
    with pytest.raises(ValidationError):
        SegmentInsertPreview.model_validate({**preview.model_dump(by_alias=False), "surprise": 1})
    with pytest.raises(ValidationError):
        SegmentInsertApplied.model_validate({**applied.model_dump(), "surprise": 1})


def test_a_moved_comment_prints_the_same_bytes_as_before(tmp_path: Path, project: str) -> None:
    from podcast_mcp.mcp.tools import segments as tools
    from podcast_mcp.models.episode import TimelineComment

    proj = load_project(Path(project))
    proj.review.comments = [
        TimelineComment(
            id="cm1", body="tighten", author="Ana", created_at="2026-11-01", timeline_start=6.0
        )
    ]
    save_project(proj, Path(project))
    segment = _save(tmp_path, "Warm Intro", chapter_title="Welcome", role="dialogue", lanes=(0, 1))

    preview = tools.segment_insert_tool(project, segment.id, 4.0, dry_run=True)
    inserted = tools.segment_insert_tool(project, segment.id, 4.0)

    moved = [{"id": "cm1", "from": 6.0, "to": 8.0}]
    assert preview == json.dumps(_preview_wire(segment.id, comments_moved=moved), indent=2)
    assert inserted == json.dumps(
        {
            "dry_run": False,
            "segment_id": segment.id,
            "segment_version": 1,
            "at": 4.0,
            "duration_sec": 2.0,
            "operation": "insert_segment",
            "affected_tracks": ["host", "warm_intro", "warm_intro_2"],
            "clip_count": 4,
            "timeline_duration_sec": 10.0,
            "tracks": {"0": "warm_intro", "1": "warm_intro_2"},
        },
        indent=2,
    )
    assert load_project(Path(project)).review.comments[0].timeline_start == 8.0


def test_a_retried_insert_returns_the_stored_result_and_inserts_once(
    tmp_path: Path, project: str
) -> None:
    from podcast_mcp.services.document import SegmentInsertApplied

    segment = _save(tmp_path, "Plain Sting")
    command = DocumentCommand(
        type="InsertSegment",
        payload={"segment_id": segment.id, "at": 2.0},
        client_id="gui",
        client_seq=None,
        role="owner",
    )
    first = DocumentSyncService.open(project).submit(command)
    after_first = _layout(project)

    retry = DocumentSyncService.open(project).submit(command)

    stored = first["command"]["payload"]["result"]
    assert json.dumps(retry["command"]["payload"]["result"]) == json.dumps(stored)
    assert _layout(project) == after_first
    assert json.dumps(SegmentInsertApplied.model_validate(stored).journal()) == json.dumps(stored)
