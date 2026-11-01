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
    # A number that is not finite never reaches the edit: the payload refuses it.
    assert ("finite number" if at in ("nan", "inf") else "segment_position_out_of_range") in (
        result.output
    )
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
