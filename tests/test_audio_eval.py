from __future__ import annotations

import shutil
import types
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.engines import audio_audit, audio_eval, timeline_render
from podcast_mcp.engines.audio import (
    At,
    CrossfadeAudio,
    MaskAudio,
    MixAudio,
    MuteEnvelope,
    OffSpeakerAudio,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    duration,
    postorder,
)
from podcast_mcp.engines.audio_eval import evaluate_audio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline, unfiltered_track_audio
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    ClipJoinMode,
    ClipMuteRegion,
    EpisodeProject,
    ProcessingChain,
    ProcessingEffect,
    load_project,
)

FIXTURE = Path(__file__).parent / "fixtures" / "lab_tighten" / "caleb_um_pause"
RATE = 8000
FADE, CROSSFADE = ClipJoinMode.FADE, ClipJoinMode.CROSSFADE
SAMPLE_TOLERANCE = 1e-3
FRAME_DB_TOLERANCE = 0.05
LIVE_FLOOR_DB = -70.0

# (source_start, source_end, timeline_start, fade_in_ms, fade_out_ms, join_in_mode)
CLIP_LAYOUTS = {
    "fade joins": [
        (0, 3, 0, 15, 25, FADE),
        (3.4, 8, 3, 15, 25, FADE),
        (8.5, 12, 7.6, 15, 25, FADE),
    ],
    "crossfade joins": [
        (0, 3, 0, 40, 40, FADE),
        (3.4, 8, 3, 40, 40, CROSSFADE),
        (8.5, 12, 7.6, 40, 60, CROSSFADE),
    ],
    "pads": [(0, 3, 0, 15, 25, FADE), (3.4, 8, 4.2, 15, 25, FADE), (8.5, 12, 10.1, 15, 25, FADE)],
    "mixed joins and pads": [
        (0, 3, 0, 15, 25, FADE),
        (3.4, 8, 3, 40, 40, CROSSFADE),
        (8.5, 12, 7.6, 30, 30, FADE),
        (13, 16.3, 10.9, 20, 20, FADE),
        (16.3, 19, 15.0, 50, 50, CROSSFADE),
    ],
}


def _ffmpeg_or_skip() -> None:
    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")


def _project(tmp_path: Path, layout: str) -> EpisodeProject:
    workspace = tmp_path / "project"
    shutil.copytree(FIXTURE, workspace)
    project = load_project(workspace / "episode.project.json")
    project.timeline.clips = [c for c in project.clips if c.track_id != "caleb"] + [
        Clip(
            id=f"c{i}",
            track_id="caleb",
            source_start=start,
            source_end=end,
            timeline_start=at,
            fade_in_ms=fade_in,
            fade_out_ms=fade_out,
            join_in_mode=mode,
        )
        for i, (start, end, at, fade_in, fade_out, mode) in enumerate(CLIP_LAYOUTS[layout])
    ]
    return project


def _frame_db(samples: np.ndarray) -> np.ndarray:
    frame = RATE // 10
    frames = samples[: samples.size // frame * frame].reshape(-1, frame)
    return 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)


@pytest.mark.parametrize("layout", CLIP_LAYOUTS)
def test_evaluation_matches_the_ffmpeg_render(layout: str, tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, layout)
    track = project.track_by_id("caleb")
    defaults = load_defaults()
    rendered_path = tmp_path / "render.wav"
    render_track_from_timeline(project, track, rendered_path, defaults)
    rendered = load_mono_full(rendered_path)

    audio, curve = unfiltered_track_audio(project, track, defaults)
    evaluated = evaluate_audio(audio, crossfade_curve=curve, load_source=load_mono_full)

    assert evaluated is not None
    assert abs(evaluated.size - rendered.size) <= 3
    common = min(evaluated.size, rendered.size)
    assert np.abs(evaluated[:common] - rendered[:common]).max() < SAMPLE_TOLERANCE
    reference, candidate = _frame_db(rendered[:common]), _frame_db(evaluated[:common])
    live = reference > LIVE_FLOOR_DB
    assert live.sum() > 10
    assert np.abs(reference - candidate)[live].max() < FRAME_DB_TOLERANCE


def test_edge_fades_and_crossfade_are_linear_ramps() -> None:
    ones = np.ones(RATE * 4, dtype=np.float32)
    both = SourceAudio(Path("a"), 0.0, 1.0, fade_in_sec=0.1, fade_out_sec=0.1)
    left = SourceAudio(Path("a"), 0.0, 1.0)
    right = SourceAudio(Path("a"), 1.0, 2.0)

    faded = evaluate_audio(both, crossfade_curve="tri", load_source=lambda _: ones)
    joined = evaluate_audio(
        CrossfadeAudio(left, right, 0.25), crossfade_curve="tri", load_source=lambda _: ones
    )

    assert faded is not None and faded.size == RATE
    assert faded[0] == 0.0
    assert faded[400] == pytest.approx(0.5)
    assert faded[800:7200].tolist() == [1.0] * 6400
    assert faded[RATE - 400] == pytest.approx(0.5)
    assert joined is not None and joined.size == 2 * RATE - 2000
    seam = joined[RATE - 2000 : RATE]
    assert np.allclose(seam, 1.0, atol=1e-3)


def test_mix_places_components_on_the_millisecond_delay() -> None:
    ones = np.ones(RATE, dtype=np.float32)
    piece = SourceAudio(Path("a"), 0.0, 0.5)
    mixed = MixAudio(
        At(0.0, piece),
        (At(0.5004, piece), At(1.0, SilenceAudio(0.25))),
    )

    result = evaluate_audio(mixed, crossfade_curve="tri", load_source=lambda _: ones)

    assert result is not None
    assert result.size == RATE + 2000
    assert result[:4000].tolist() == [1.0] * 4000
    assert result[4000:8000].tolist() == [1.0] * 4000
    assert result[8000:].tolist() == [0.0] * (result.size - 8000)


def test_overlapping_mix_components_sum_like_the_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    track = project.track_by_id("caleb")
    defaults = load_defaults()
    audio, curve = unfiltered_track_audio(project, track, defaults)
    mix = next(n for n in postorder(audio) if isinstance(n, MixAudio))
    starts = [at.start_sec for at in (mix.head, *mix.tail)]
    ends = [at.start_sec + duration(at.audio) for at in (mix.head, *mix.tail)]
    assert any(later < earlier for earlier, later in zip(ends, starts[1:], strict=False))
    rendered_path = tmp_path / "render.wav"
    render_track_from_timeline(project, track, rendered_path, defaults)
    rendered = load_mono_full(rendered_path)
    evaluated = evaluate_audio(audio, crossfade_curve=curve, load_source=load_mono_full)
    assert evaluated is not None
    frame = RATE // 10
    count = min(rendered.size, evaluated.size) // frame * frame
    live = np.abs(rendered[:count]).reshape(-1, frame).max(axis=1) > 0.01
    db = [
        10 * np.log10(np.mean(x[:count].reshape(-1, frame) ** 2, axis=1) + 1e-12)
        for x in (rendered, evaluated)
    ]
    assert np.abs(db[0] - db[1])[live].max() < 0.05


def test_mixed_channel_layouts_keep_the_render(monkeypatch: pytest.MonkeyPatch) -> None:
    channels = {Path("stereo"): 2, Path("mono"): 1}
    monkeypatch.setattr(
        audio_eval,
        "probe_media",
        lambda path: types.SimpleNamespace(channels=channels[path]),
    )
    stereo = SourceAudio(Path("stereo"), 0.0, 0.5)
    mono = SourceAudio(Path("mono"), 0.0, 0.5)

    assert audio_eval.single_layout(SequenceAudio(stereo, (stereo,)))
    assert not audio_eval.single_layout(SequenceAudio(stereo, (mono,)))


def test_gate_fill_is_summed_under_its_source() -> None:
    audio = SequenceAudio(
        SourceAudio(Path("a"), 0.0, 0.25, fill_path=Path("fill")),
        (SourceAudio(Path("a"), 0.25, 0.5),),
    )
    media = {
        Path("a"): np.ones(RATE, dtype=np.float32),
        Path("fill"): np.full(RATE, 0.5, np.float32),
    }

    result = evaluate_audio(audio, crossfade_curve="tri", load_source=media.__getitem__)

    assert result is not None
    assert result[:2000].tolist() == [1.5] * 2000
    assert result[2000:].tolist() == [1.0] * 2000


def test_unsupported_trees_are_not_evaluated() -> None:
    ones = np.ones(RATE, dtype=np.float32)
    leaf = SourceAudio(Path("a"), 0.0, 0.5)
    muted = SourceAudio(Path("a"), 0.0, 0.5, mute_spans=(MuteEnvelope(0.1, 0.2, 0.01, 0.01),))
    unsupported = {
        "mute span": (muted, "tri"),
        "mute span in a sequence": (SequenceAudio(leaf, (muted,)), "tri"),
        "mask": (MaskAudio(leaf, 0.0, ((0.1, 0.2),)), "tri"),
        "off speaker": (OffSpeakerAudio(leaf, leaf, ()), "tri"),
        "crossfade curve": (CrossfadeAudio(leaf, leaf, 0.1), "qsin"),
        "overlap longer than a side": (CrossfadeAudio(leaf, leaf, 0.6), "tri"),
    }

    for name, (audio, curve) in unsupported.items():
        assert evaluate_audio(audio, crossfade_curve=curve, load_source=lambda _: ones) is None, (
            name
        )


@pytest.fixture
def render_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    real = timeline_render.render_track_from_timeline

    def counting(project, track, output_path, defaults, **kwargs):
        calls.append(track.id)
        return real(project, track, output_path, defaults, **kwargs)

    monkeypatch.setattr(timeline_render, "render_track_from_timeline", counting)
    return calls


def _chained(project: EpisodeProject) -> EpisodeProject:
    project.mix.processing_chains = [
        ProcessingChain(track_id="caleb", effects=[ProcessingEffect(effect="highpass", params={})])
    ]
    return project


def test_chain_track_cache_takes_the_fast_path_without_a_render(
    tmp_path: Path, render_calls: list[str]
) -> None:
    _ffmpeg_or_skip()
    project = _chained(_project(tmp_path, "mixed joins and pads"))

    caches = audio_audit.build_track_rms_caches(
        project, track_ids=["caleb"], unprocessed=True, defaults=load_defaults()
    )

    assert render_calls == []
    fast = caches.caches["caleb"]
    assert fast.sample_rate == RATE
    assert fast.recording_profile is not None
    assert fast.samples.size == 141400


def test_fast_cache_equals_the_rendered_cache(tmp_path: Path, render_calls: list[str]) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    defaults = load_defaults()
    track = project.track_by_id("caleb")
    stem = tmp_path / "stem.wav"
    render_track_from_timeline(project, track, stem, defaults)
    rendered = audio_audit.TrackRmsCache.from_timeline_stem(stem)

    render_calls.clear()
    fast = audio_audit._ungated_cache(project, "caleb", with_chain=False, defaults=defaults)

    assert render_calls == []
    assert fast.samples.size == pytest.approx(rendered.samples.size, abs=3)
    for field in ("room_rms", "speech_rms"):
        assert getattr(fast.profile, field) == pytest.approx(
            getattr(rendered.profile, field), abs=0.05
        )


def _with_mute(project: EpisodeProject) -> None:
    clip = next(c for c in project.clips if c.track_id == "caleb")
    clip.mute_regions = [
        ClipMuteRegion(start_s=clip.source_start + 0.5, end_s=clip.source_start + 0.8)
    ]


def _with_envelope(project: EpisodeProject) -> None:
    project.automation_envelopes = [
        AutomationEnvelope(
            track_id="caleb",
            points=[
                AutomationPoint(id="a", time=0.0, value=1.0),
                AutomationPoint(id="b", time=5.0, value=0.5),
            ],
        )
    ]


def _with_gate(project: EpisodeProject) -> None:
    project.track_by_id("caleb").transcript_gate = True


def _with_chain_left_in(project: EpisodeProject) -> None:
    _chained(project)


@pytest.mark.parametrize("setup", [_with_mute, _with_envelope])
def test_ungated_cache_keeps_the_render_when_the_tree_needs_it(
    setup, tmp_path: Path, render_calls: list[str]
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    setup(project)

    cache = audio_audit._ungated_cache(project, "caleb", with_chain=False, defaults=load_defaults())

    assert render_calls == ["caleb"]
    assert cache.samples.size > 0


def test_unfiltered_audio_declines_what_the_render_would_filter(tmp_path: Path) -> None:
    defaults = load_defaults()
    for setup in (_with_envelope, _with_gate, _with_chain_left_in):
        project = _project(tmp_path / setup.__name__, "fade joins")
        setup(project)
        assert unfiltered_track_audio(project, project.track_by_id("caleb"), defaults) is None

    empty = _project(tmp_path / "empty", "fade joins")
    empty.timeline.clips = [c for c in empty.clips if c.track_id != "caleb"]
    assert unfiltered_track_audio(empty, empty.track_by_id("caleb"), defaults) is None
