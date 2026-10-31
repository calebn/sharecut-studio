"""Cutting a segment out of a project's timeline, with real audio."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import Clip, EpisodeProject, Track, save_project
from podcast_mcp.models.episode import ClipJoinMode, MediaAsset, TrackRole
from podcast_mcp.segments.capture import (
    capture_segment,
    guess_kind,
    parse_range,
    save_segment,
)
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError


@pytest.fixture
def workspace(tmp_workspace: Path, sample_wav: Path) -> ProjectWorkspace:
    raw = tmp_workspace / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("episode", str(tmp_workspace))
    project.ensure_dirs()
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/host.wav"),
            fader_db=-4.0,
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=10.0,
            fade_in_ms=20,
            fade_out_ms=30,
            join_in_mode=ClipJoinMode.CROSSFADE,
        ),
        Clip(id="c2", track_id="host", source_start=1.0, source_end=1.5, timeline_start=13.0),
        Clip(id="late", track_id="host", source_start=0.0, source_end=1.0, timeline_start=500.0),
    ]
    return ProjectWorkspace.open(save_project(project))


def _duration(path: Path) -> float:
    return FFmpegEngine().probe(path).duration_sec


def test_two_clips_become_a_segment_with_relative_offsets(
    workspace: ProjectWorkspace, tmp_path: Path
) -> None:
    out = tmp_path / "cut"
    segment = capture_segment(
        workspace, name="Warm Intro", directory=out, clip_ids=["c2", "c1"], kind="sting"
    )

    assert segment.kind == "sting"
    assert segment.role is TrackRole.MUSIC
    assert segment.fader_db == -4.0
    assert [(c.offset_sec, c.duration_sec) for c in segment.clips] == [(0.0, 1.0), (3.0, 0.5)]
    first = segment.clips[0]
    assert (first.fade_in_ms, first.fade_out_ms, first.join_in_mode) == (
        20,
        30,
        ClipJoinMode.CROSSFADE,
    )
    assert {c.lane for c in segment.clips} == {0}
    assert segment.duration_sec == 3.5
    assert (out / "segment.json").is_file()
    for clip, expected in zip(segment.clips, (1.0, 0.5), strict=True):
        assert clip.audio.endswith(".flac")
        assert _duration(out / clip.audio) == pytest.approx(expected, abs=0.05)
        assert segment.media[clip.audio].bytes == (out / clip.audio).stat().st_size


def test_a_range_trims_the_clips_it_overlaps(workspace: ProjectWorkspace, tmp_path: Path) -> None:
    segment = capture_segment(
        workspace, name="Opening", directory=tmp_path / "cut", time_range=(10.5, 13.25)
    )

    assert [(c.offset_sec, c.duration_sec) for c in segment.clips] == [(0.0, 0.5), (2.5, 0.25)]
    assert _duration(tmp_path / "cut" / segment.clips[0].audio) == pytest.approx(0.5, abs=0.05)


def test_the_role_can_be_overridden(workspace: ProjectWorkspace, tmp_path: Path) -> None:
    segment = capture_segment(
        workspace, name="Ad", directory=tmp_path / "cut", clip_ids=["c1"], role=TrackRole.SFX
    )
    assert segment.role is TrackRole.SFX


def test_the_kind_is_guessed_from_where_the_selection_sits(
    workspace: ProjectWorkspace, tmp_path: Path
) -> None:
    first = capture_segment(workspace, name="A", directory=tmp_path / "a", clip_ids=["c1"])
    last = capture_segment(workspace, name="B", directory=tmp_path / "b", clip_ids=["late"])
    assert first.kind == "intro"
    assert last.kind == "outro"
    assert guess_kind(300.0, 310.0, 3600.0) == "other"


@pytest.mark.parametrize(
    "arguments",
    [
        {"clip_ids": ["c1"], "time_range": (0.0, 5.0)},
        {},
        {"clip_ids": ["nope"]},
        {"time_range": (100.0, 200.0)},
        {"time_range": (5.0, 5.0)},
    ],
)
def test_a_bad_selection_is_refused(
    workspace: ProjectWorkspace, tmp_path: Path, arguments: dict
) -> None:
    with pytest.raises(CodedValueError) as raised:
        capture_segment(workspace, name="X", directory=tmp_path / "cut", **arguments)
    assert raised.value.code.startswith("segment_")


def test_saving_captures_into_the_library_once(workspace: ProjectWorkspace, tmp_path: Path) -> None:
    store = SegmentStore(tmp_path / "lib")
    first = save_segment(workspace, store, name="Warm Intro", clip_ids=["c1"])
    again = save_segment(workspace, store, name="Warm Intro", clip_ids=["c1"])

    assert first.status == "added"
    assert again.status == "unchanged"
    assert store.get(first.id).clips[0].duration_sec == 1.0


@pytest.mark.parametrize(
    ("text", "expected"),
    [("0:00-0:22", (0.0, 22.0)), ("90-1:30:00", (90.0, 5400.0)), ("1:02.5-2:00", (62.5, 120.0))],
)
def test_ranges_parse(text: str, expected: tuple[float, float]) -> None:
    assert parse_range(text) == expected


@pytest.mark.parametrize("text", ["0:22", "a-b", "1:2:3:4-5", "-"])
def test_bad_ranges_are_refused(text: str) -> None:
    with pytest.raises(CodedValueError) as raised:
        parse_range(text)
    assert raised.value.code == "segment_range_invalid"


def test_a_range_cut_mid_clip_carries_no_fade_at_the_cut(
    workspace: ProjectWorkspace, tmp_path: Path
) -> None:
    segment = capture_segment(
        workspace, name="Opening", directory=tmp_path / "cut", time_range=(10.5, 13.25)
    )
    first, second = segment.clips
    assert (first.fade_in_ms, first.join_in_mode) == (0, ClipJoinMode.FADE)
    assert first.fade_out_ms == 30  # the clip's own end is inside the range
    assert second.fade_in_ms == 0 and second.fade_out_ms == 0  # cut at its end


def test_a_range_covering_whole_clips_keeps_their_fades(
    workspace: ProjectWorkspace, tmp_path: Path
) -> None:
    segment = capture_segment(
        workspace, name="Opening", directory=tmp_path / "cut", time_range=(9.0, 14.0)
    )
    assert (segment.clips[0].fade_in_ms, segment.clips[0].fade_out_ms) == (20, 30)
    assert segment.clips[0].join_in_mode is ClipJoinMode.CROSSFADE


def test_a_clip_too_short_to_cut_is_refused(workspace: ProjectWorkspace, tmp_path: Path) -> None:
    with pytest.raises(CodedValueError) as raised:
        capture_segment(
            workspace, name="Sliver", directory=tmp_path / "cut", time_range=(10.0, 10.000001)
        )
    assert raised.value.code == "segment_clip_too_short"


def test_a_bad_name_is_refused_before_any_audio_is_cut(
    workspace: ProjectWorkspace, tmp_path: Path
) -> None:
    out = tmp_path / "cut"
    with pytest.raises(CodedValueError) as raised:
        capture_segment(workspace, name="!!!", directory=out, clip_ids=["c1"])
    assert raised.value.code == "segment_name_invalid"
    assert not out.exists()


def test_overlapping_clips_on_one_track_get_separate_lanes(
    workspace: ProjectWorkspace, tmp_path: Path
) -> None:
    workspace.project.clips.append(
        Clip(id="over", track_id="host", source_start=0.0, source_end=1.0, timeline_start=10.5)
    )
    segment = capture_segment(
        workspace, name="Overlap", directory=tmp_path / "cut", clip_ids=["c1", "over", "c2"]
    )
    lanes = {c.audio: c.lane for c in segment.clips}
    assert len(set(lanes.values())) == 2
    assert segment.clips[0].lane != segment.clips[1].lane
    assert segment.clips[2].lane == segment.clips[0].lane


@pytest.mark.parametrize(
    "update",
    [
        {"off_speaker_mute_regions": [{"start_s": 0.1, "end_s": 0.2}]},
        {"mute_regions": [{"start_s": 0.1, "end_s": 0.2, "fill": {"start_s": 5.0, "end_s": 6.0}}]},
    ],
)
def test_clips_the_capture_cannot_render_faithfully_are_refused(
    workspace: ProjectWorkspace, tmp_path: Path, update: dict[str, object]
) -> None:
    clip = workspace.project.clips[0]
    workspace.project.clips[0] = Clip.model_validate({**clip.model_dump(mode="json"), **update})
    with pytest.raises(CodedValueError) as raised:
        capture_segment(workspace, name="Nope", directory=tmp_path / "cut", clip_ids=["c1"])
    assert raised.value.code == "segment_render_unsupported"


def test_ignored_words_are_muted_in_the_captured_audio(
    workspace: ProjectWorkspace, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.models.episode import ClipMuteRegion

    seen: list[object] = []
    real = FFmpegEngine.extract_segment

    def spy(self: FFmpegEngine, *args: object, **kwargs: object) -> object:
        seen.append(kwargs.get("mute_spans"))
        return real(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(FFmpegEngine, "extract_segment", spy)
    monkeypatch.setattr(
        "podcast_mcp.engines.mute_regions.IgnoredWordRegions.for_clip",
        lambda self, clip: [ClipMuteRegion(start_s=0.2, end_s=0.3)],
    )
    capture_segment(workspace, name="Ignored", directory=tmp_path / "cut", clip_ids=["c1"])
    assert seen and seen[0]


@pytest.mark.parametrize(
    "update",
    [
        {"off_speaker_mute_regions": [{"start_s": 0.8, "end_s": 0.9}]},
        {"bleed_restore": {"source_sha256": "a" * 64, "regions": [{"start_s": 0.8, "end_s": 0.9}]}},
    ],
)
def test_a_range_ignores_unrenderable_regions_outside_it(
    workspace: ProjectWorkspace, tmp_path: Path, update: dict[str, object]
) -> None:
    clip = workspace.project.clips[0]
    workspace.project.clips[0] = Clip.model_validate({**clip.model_dump(mode="json"), **update})
    # The region sits at source 0.8-0.9 (timeline 10.8-10.9); the range ends at 10.5.
    segment = capture_segment(
        workspace, name="Early", directory=tmp_path / "cut", time_range=(10.0, 10.5)
    )
    assert segment.duration_sec == pytest.approx(0.5)
    with pytest.raises(CodedValueError) as raised:
        capture_segment(
            workspace, name="Late", directory=tmp_path / "cut2", time_range=(10.0, 10.85)
        )
    assert raised.value.code == "segment_render_unsupported"
