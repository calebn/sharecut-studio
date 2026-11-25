"""A segment lane (a media-less track whose clips carry a segment_ref) is rendered and mixed."""

from __future__ import annotations

import array
import json
import subprocess
import wave
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.play_audit import (
    mix_gains,
    mix_render_hash,
    premix_is_stale,
    premix_path,
    premix_stale_vs_mix,
    read_premix_hash,
    stem_is_fresh,
)
from podcast_mcp.engines.waveform_media import _project_candidates
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval, SegmentRef
from podcast_mcp.pipeline import steps
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import PlayService
from podcast_mcp.services.media.bounce import (
    _BOUNCEABLE_ROLES,
    BounceRequest,
    BounceService,
    _bounceable_tracks,
)
from podcast_mcp.util.binaries import resolve_ffmpeg
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.tracks import track_has_audio, tracks_with_audio
from test_segments_insert import _insert, _save
from test_segments_insert import project as seeded_episode  # noqa: F401

runner = CliRunner()


@pytest.fixture
def episode_path(seeded_episode: str) -> str:  # noqa: F811
    return seeded_episode


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def _pcm(path: Path) -> array.array:
    decoded = subprocess.run(
        [
            resolve_ffmpeg(),
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            "48000",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    samples = array.array("h")
    samples.frombytes(decoded.stdout)
    return samples


def _peak(path: Path, start: float, end: float) -> int:
    samples = _pcm(path)
    window = samples[int(start * 48000) : int(end * 48000)]
    return max((abs(s) for s in window), default=0)


def _duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def _lane_project(
    path: str, tmp_path: Path, *, role: str = "music", at: float = 7.0, own_lane: bool = True
) -> EpisodeProject:
    """The host alone (8 s of silence), then a 2 s sine segment inserted at ``at``."""
    proj = load_project(Path(path))
    proj.tracks = [t for t in proj.tracks if t.id == "host"]
    save_project(proj, Path(path))
    segment = _save(tmp_path, "Bed", role=role, fader_db=0.0)
    flags = ["--own-lane"] if own_lane else []
    result = _insert(path, segment.id, at, *flags)
    assert result.exit_code == 0, result.output
    return load_project(Path(path))


def _lane_id(proj: EpisodeProject) -> str:
    return next(c.track_id for c in proj.clips if c.segment_ref is not None)


def _mix(proj: EpisodeProject) -> str:
    defaults = load_defaults()
    steps.assemble_timeline(proj, defaults)
    return steps.mix_with_music(proj, defaults)


def _stem(proj: EpisodeProject, track_id: str) -> Path:
    return proj.artifacts_dir() / "tracks" / f"{track_id}.wav"


def test_track_has_audio_covers_media_segment_clips_and_nothing_else() -> None:
    proj = EpisodeProject.create("t", "/tmp/never-written")
    ref = SegmentRef(segment_id="s", version=1, content_sha256="0" * 64)
    proj.tracks = [
        Track(id="media", label="M", media=MediaAsset(path="raw/a.wav")),
        Track(id="lane", label="L", role=TrackRole.MUSIC),
        Track(id="empty", label="E", role=TrackRole.MUSIC),
        Track(id="dragged", label="D", role=TrackRole.MUSIC),
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="lane",
            source_id="src",
            source_start=0,
            source_end=1,
            timeline_start=0,
            segment_ref=ref,
        ),
        Clip(
            id="c2",
            track_id="dragged",
            source_id="src",
            source_start=0,
            source_end=1,
            timeline_start=0,
        ),
    ]
    flags = {t.id: track_has_audio(proj, t) for t in proj.tracks}
    assert flags == {"media": True, "lane": True, "empty": False, "dragged": False}
    assert tracks_with_audio(proj) == {"media", "lane"}


def test_a_segment_lane_gets_a_stem_with_the_clip_offset_fade_and_length(
    episode_path: str, tmp_path: Path
) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    clip = next(c for c in proj.clips if c.track_id == lane)

    steps.assemble_timeline(proj, load_defaults())

    stem = _stem(proj, lane)
    assert lane in json.loads((proj.artifacts_dir() / "track_outputs.json").read_text())
    assert _duration(stem) == pytest.approx(clip.timeline_end, abs=0.05)
    assert _duration(stem) <= clip.timeline_end + 0.05
    assert _peak(stem, 0.0, clip.timeline_start - 0.1) == 0
    assert _peak(stem, clip.timeline_start + 0.2, clip.timeline_end - 0.1) > 1000
    assert _peak(stem, clip.timeline_start, clip.timeline_start + 0.001) < 400


def test_the_premix_includes_the_lane_and_outlasts_the_dialogue(
    episode_path: str, tmp_path: Path
) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    dialogue_end = max(c.timeline_end for c in proj.clips if c.track_id == "host")

    summary = _mix(proj)

    premix = premix_path(proj)
    assert summary == "2 tracks mixed, 0 music envelopes"
    assert lane in mix_gains(proj)
    assert _duration(premix) > dialogue_end + 0.5
    assert _peak(premix, 8.2, 8.8) > 1000
    assert _peak(premix, 0.0, 6.5) == 0


def test_fader_and_mute_change_the_premix_hash_and_a_second_mix_is_reused(
    episode_path: str, tmp_path: Path
) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    defaults = load_defaults()
    _mix(proj)
    first = read_premix_hash(proj)

    assert steps.mix_with_music(proj, defaults) == "reused premix.wav"

    proj.track_by_id(lane).fader_db = -6.0
    assert premix_is_stale(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    second = read_premix_hash(proj)
    assert second != first
    assert stem_is_fresh(proj, lane, defaults=defaults)

    proj.track_by_id(lane).muted = True
    assert premix_is_stale(proj, defaults)
    assert lane not in mix_gains(proj)
    steps.assemble_timeline(proj, defaults)
    assert stem_is_fresh(proj, lane, defaults=defaults)
    steps.mix_with_music(proj, defaults)
    assert read_premix_hash(proj) not in {first, second}
    assert _peak(premix_path(proj), 8.2, 8.8) == 0


def test_an_envelope_on_the_lane_is_baked_into_its_stem(episode_path: str, tmp_path: Path) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    defaults = load_defaults()
    steps.assemble_timeline(proj, defaults)
    assert _peak(_stem(proj, lane), 8.2, 8.8) > 1000

    proj.automation_envelopes.append(
        AutomationEnvelope(
            track_id=lane,
            points=[
                AutomationPoint(id="p0", time=0.0, value=0.0),
                AutomationPoint(id="p1", time=100.0, value=0.0),
            ],
        )
    )
    steps.assemble_timeline(proj, defaults)

    assert _peak(_stem(proj, lane), 8.2, 8.8) == 0


def test_bounce_by_track_id_and_all_tracks_include_the_lane(
    episode_path: str, tmp_path: Path
) -> None:
    _lane_project(episode_path, tmp_path)
    ws = ProjectWorkspace.open(Path(episode_path))
    lane = _lane_id(ws.project)

    (only,) = BounceService(ws).bounce(BounceRequest(track_ids=[lane], formats=["wav"]))
    assert _peak(only, 8.2, 8.8) > 1000
    assert _peak(only, 0.0, 6.5) == 0

    (everything,) = BounceService(ws).bounce(BounceRequest(formats=["wav"]))
    assert _duration(everything) > 8.5
    assert _peak(everything, 8.2, 8.8) > 1000


def test_role_sets_cover_every_track_role(episode_path: str, tmp_path: Path) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = proj.track_by_id(_lane_id(proj))
    assert lane is not None
    assert set(_BOUNCEABLE_ROLES) == set(TrackRole)
    for role in TrackRole:
        lane.role = role
        assert _bounceable_tracks(proj, {lane.id}) == [lane], role


@pytest.mark.parametrize(
    "role", [TrackRole.DIALOGUE, TrackRole.MUSIC, TrackRole.INTRO, TrackRole.OUTRO, TrackRole.SFX]
)
def test_a_lane_of_every_rendered_role_gets_a_stem(
    episode_path: str, tmp_path: Path, role: TrackRole
) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    proj.track_by_id(lane).role = role
    steps.assemble_timeline(proj, load_defaults())
    assert _stem(proj, lane).is_file()


def test_range_audio_and_window_mix_hear_a_segment_only_interval(
    episode_path: str, tmp_path: Path
) -> None:
    _lane_project(episode_path, tmp_path)
    ws = ProjectWorkspace.open(Path(episode_path))
    lane = _lane_id(ws.project)
    spans = [RangeInterval(start=8.2, end=8.8)]
    from podcast_mcp.edits.range_target import range_geometry, range_media_seal
    from podcast_mcp.services.media import render_range_audio

    target = ExactRangeTarget(
        intervals=spans,
        track_ids=[lane],
        clips=range_geometry(ws.project, spans, [lane]),
        media_seals={lane: range_media_seal(ws.project, lane)},
    )
    out = tmp_path / "range.wav"
    render_range_audio(ws.project, target, out, defaults=ws.effective_config())
    assert _peak(out, 0.0, 0.5) > 1000

    window = tmp_path / "window.wav"
    PlayService(ws)._render_mix_window(ws.project, 8.2, 8.8, window, trim_db=0.0)
    assert _peak(window, 0.0, 0.5) > 1000


def test_insert_mix_undo_mix_redo_mix(episode_path: str, tmp_path: Path) -> None:
    proj = load_project(Path(episode_path))
    proj.tracks = [t for t in proj.tracks if t.id == "host"]
    save_project(proj, Path(episode_path))
    _mix(load_project(Path(episode_path)))
    bare = read_premix_hash(load_project(Path(episode_path)))

    segment = _save(tmp_path, "Bed", role="music", fader_db=0.0)
    assert _insert(episode_path, segment.id, 7.0, "--own-lane").exit_code == 0
    inserted = load_project(Path(episode_path))
    _mix(inserted)
    with_lane = read_premix_hash(inserted)
    long_premix = _duration(premix_path(inserted))
    assert with_lane != bare

    assert runner.invoke(app, ["undo", "--project", episode_path]).exit_code == 0
    undone = load_project(Path(episode_path))
    _mix(undone)
    assert read_premix_hash(undone) == bare
    assert _duration(premix_path(undone)) < long_premix - 0.5

    assert runner.invoke(app, ["redo", "--project", episode_path]).exit_code == 0
    redone = load_project(Path(episode_path))
    lane = _lane_id(redone)
    stamp = _stem(redone, lane).stat().st_mtime_ns
    _mix(redone)
    assert read_premix_hash(redone) == with_lane
    assert _stem(redone, lane).stat().st_mtime_ns == stamp
    assert _duration(premix_path(redone)) == pytest.approx(long_premix, abs=0.05)


def test_a_bare_mix_after_an_insert_with_a_stale_track_outputs_file_mixes_the_lane(
    episode_path: str, tmp_path: Path
) -> None:
    proj = load_project(Path(episode_path))
    proj.tracks = [t for t in proj.tracks if t.id == "host"]
    save_project(proj, Path(episode_path))
    steps.assemble_timeline(load_project(Path(episode_path)), load_defaults())
    segment = _save(tmp_path, "Bed", role="music", fader_db=0.0)
    assert _insert(episode_path, segment.id, 7.0, "--own-lane").exit_code == 0
    inserted = load_project(Path(episode_path))
    lane = _lane_id(inserted)
    assert lane not in json.loads((inserted.artifacts_dir() / "track_outputs.json").read_text())

    steps.mix_with_music(inserted, load_defaults())

    assert lane in json.loads((inserted.artifacts_dir() / "track_outputs.json").read_text())
    assert _peak(premix_path(inserted), 8.2, 8.8) > 1000
    assert not premix_is_stale(inserted, load_defaults())


def test_a_lane_that_cannot_be_stemmed_is_named_when_mixing(
    episode_path: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    steps.assemble_timeline(proj, load_defaults())
    outputs = proj.artifacts_dir() / "track_outputs.json"
    outputs.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(steps, "assemble_timeline", lambda *_a, **_k: None)

    with pytest.raises(CodedValueError, match=lane) as caught:
        steps.mix_with_music(proj, load_defaults())
    assert caught.value.code == "stem_missing"


def test_a_ripple_dialogue_segment_lane_is_mixed(episode_path: str, tmp_path: Path) -> None:
    proj = _lane_project(episode_path, tmp_path, role="dialogue", at=4.0, own_lane=False)
    lane = _lane_id(proj)
    assert lane != "host"
    assert proj.track_by_id(lane).media is None

    _mix(proj)

    assert lane in mix_gains(proj)
    assert _peak(premix_path(proj), 4.2, 5.8) > 1000


def test_a_lane_whose_source_is_gone_is_named_in_the_error(
    episode_path: str, tmp_path: Path
) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    clip = next(c for c in proj.clips if c.track_id == lane)
    source = proj.source_by_id(clip.source_id)
    (proj.workspace_path() / source.path).unlink()

    with pytest.raises(CodedValueError, match=lane) as caught:
        steps.assemble_timeline(proj, load_defaults())
    assert caught.value.code == "segment_source_missing"


def test_a_media_less_lane_with_a_dangling_source_id_but_no_segment_ref_stays_skipped(
    episode_path: str, tmp_path: Path
) -> None:
    proj = _lane_project(episode_path, tmp_path)
    proj.tracks.append(Track(id="ghost", label="Ghost", role=TrackRole.MUSIC))
    proj.clips.append(
        Clip(
            id="gc",
            track_id="ghost",
            source_id="nowhere",
            source_start=0,
            source_end=1,
            timeline_start=0,
        )
    )
    steps.assemble_timeline(proj, load_defaults())
    assert "ghost" not in mix_gains(proj)
    assert not _stem(proj, "ghost").exists()


def test_the_hashless_premix_check_sees_a_lane_fader(episode_path: str, tmp_path: Path) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    defaults = load_defaults()
    _mix(proj)
    (proj.artifacts_dir() / "premix.hash").unlink()
    assert premix_stale_vs_mix(proj, defaults) is False
    proj.track_by_id(lane).fader_db = -2.0
    assert premix_stale_vs_mix(proj, defaults) is True


def test_the_waveform_candidates_include_a_segment_stem(episode_path: str, tmp_path: Path) -> None:
    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    refs = {c.ref for c in _project_candidates(proj) if c is not None}
    assert f"stem:{lane}" in refs


def test_share_range_audio_refuses_while_the_lane_stem_is_stale(
    episode_path: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services import collaboration
    from podcast_mcp.services.collaboration import share

    proj = _lane_project(episode_path, tmp_path)
    lane = _lane_id(proj)
    _mix(proj)
    ws = ProjectWorkspace.open(Path(episode_path))
    monkeypatch.setattr(share, "require_share_cap", lambda *_a, **_k: ({}, ws))
    monkeypatch.setattr(share, "share_daw_audio_path", lambda *_a, **_k: premix_path(proj))
    spans = [RangeInterval(start=8.2, end=8.8)]
    from podcast_mcp.edits.range_target import range_geometry, range_media_seal

    target = ExactRangeTarget(
        intervals=spans,
        track_ids=[lane],
        clips=range_geometry(ws.project, spans, [lane]),
        media_seals={lane: range_media_seal(ws.project, lane)},
    )
    fresh = collaboration.share_selected_range_audio("tok", target)
    assert _peak(fresh, 0.0, 0.5) > 1000

    clip = next(c for c in ws.project.clips if c.track_id == lane)
    with ws.transaction() as live:
        next(c for c in live.clips if c.id == clip.id).timeline_start += 0.5
    with pytest.raises(CodedValueError) as caught:
        collaboration.share_selected_range_audio("tok", target)
    assert caught.value.code == "mix_out_of_date"


def test_a_project_without_segment_lanes_mixes_exactly_as_before(
    minimal_project: Path, sample_wav: Path, tmp_workspace: Path
) -> None:
    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host", label="Host", role=TrackRole.DIALOGUE, media=MediaAsset(path="raw/host.wav")
        ),
        Track(id="ghost", label="Ghost", role=TrackRole.MUSIC),
    ]
    proj.clips = [Clip(id="c", track_id="host", source_start=0, source_end=2, timeline_start=0)]
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    defaults = load_defaults()

    _mix(proj)

    assert mix_gains(proj) == {"host": 0.0}
    assert sorted(json.loads((proj.artifacts_dir() / "track_outputs.json").read_text())) == ["host"]
    assert read_premix_hash(proj) == mix_render_hash({"host": 0.0}, -1.0, defaults=defaults)
