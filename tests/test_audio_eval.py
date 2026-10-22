from __future__ import annotations

import shutil
import types
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import audio_audit, audio_eval, track_evidence
from podcast_mcp.engines.audio import (
    At,
    CrossfadeAudio,
    MaskAudio,
    MixAudio,
    OffSpeakerAudio,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    SourceMuteEnvelope,
    duration,
    postorder,
)
from podcast_mcp.engines.audio import (
    sources as audio_sources,
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
    ClipOffSpeakerMuteRegion,
    EpisodeProject,
    GateFill,
    GateFillSource,
    ProcessingChain,
    ProcessingEffect,
    SourceRecording,
    load_project,
)
from podcast_mcp.util.binaries import resolve_ffmpeg_pair
from podcast_mcp.util.process import run

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
    "crossfade over source handles": [
        (0, 3.2, 0, 15, 25, FADE),
        (3.0, 8, 3.0, 200, 40, CROSSFADE),
        (8, 12.2, 7.8, 40, 40, CROSSFADE),
    ],
    "pads": [(0, 3, 0, 15, 25, FADE), (3.4, 8, 4.2, 15, 25, FADE), (8.5, 12, 10.1, 15, 25, FADE)],
    "cuts between 8 kHz samples": [
        (0.25473378406774855, 1.388811270375909, 0.0, 14, 43, FADE),
        (1.4675902672371368, 2.8020590721027068, 1.1340774863081604, 57, 31, FADE),
        (3.051069467681859, 5.176875664016201, 2.4685462911737304, 14, 8, FADE),
        (5.613838410121426, 6.880534303661, 5.029212441012399, 45, 50, FADE),
    ],
    "crossfades between 8 kHz samples": [
        (0.1234567, 3.0123457, 0.0, 15, 25, FADE),
        (3.4234567, 8.0345679, 2.8888889, 40, 40, CROSSFADE),
        (8.5456789, 12.0111111, 7.5, 30, 60, CROSSFADE),
    ],
    "reordered and repeated slices": [
        (8.5, 12, 0, 15, 25, FADE),
        (0, 3, 3.5, 15, 25, FADE),
        (8.5, 10, 7.0, 15, 25, FADE),
        (3.4, 8, 9.0, 15, 25, FADE),
    ],
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


def _project(tmp_path: Path, layout: str, *, mono_rate: int | None = None) -> EpisodeProject:
    workspace = tmp_path / "project"
    shutil.copytree(FIXTURE, workspace)
    if mono_rate is not None:
        source = workspace / "raw" / "caleb.flac"
        converted = tmp_path / "converted.flac"
        run(
            [
                resolve_ffmpeg_pair().ffmpeg,
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-ac",
                "1",
                "-ar",
                str(mono_rate),
                str(converted),
            ],
            check=True,
        )
        shutil.move(converted, source)
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


def _evaluate(
    project: EpisodeProject, track, defaults
) -> tuple[np.ndarray | None, track_evidence.Declined | str]:
    """The track's 8 kHz evidence evaluated from its tree, or why the render is needed."""
    result = track_evidence._entry(project, track.id, defaults, locked=False)
    if isinstance(result, track_evidence.Declined):
        return None, result
    return result.samples[RATE], ""


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

    evaluated, reason = _evaluate(project, track, defaults)

    assert evaluated is not None, reason
    assert abs(evaluated.size - rendered.size) <= (0 if "8 kHz" in layout else 3)
    common = min(evaluated.size, rendered.size)
    assert np.abs(evaluated[:common] - rendered[:common]).max() < SAMPLE_TOLERANCE
    reference, candidate = _frame_db(rendered[:common]), _frame_db(evaluated[:common])
    live = reference > LIVE_FLOOR_DB
    assert live.sum() > 10
    assert np.abs(reference - candidate)[live].max() < FRAME_DB_TOLERANCE


def test_mute_regions_match_the_ffmpeg_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    clips = [c for c in project.clips if c.track_id == "caleb"]
    clips[0].mute_regions = [
        ClipMuteRegion(start_s=clips[0].source_start + 0.5, end_s=clips[0].source_start + 0.9),
        ClipMuteRegion(
            start_s=clips[0].source_start + 1.5,
            end_s=clips[0].source_start + 1.51,
            fade_out_ms=40,
            fade_in_ms=40,
        ),
    ]
    clips[2].mute_regions = [
        ClipMuteRegion(
            start_s=clips[2].source_start + 0.2,
            end_s=clips[2].source_start + 1.0,
            fade_out_ms=30,
            fade_in_ms=60,
            gain_db=-12.0,
        )
    ]
    track = project.track_by_id("caleb")
    defaults = load_defaults()
    rendered_path = tmp_path / "render.wav"
    render_track_from_timeline(project, track, rendered_path, defaults)
    rendered = load_mono_full(rendered_path)

    audio, curve = unfiltered_track_audio(project, track, defaults)
    evaluated = evaluate_audio(audio, crossfade_curve=curve, load_source=load_mono_full)

    assert evaluated is not None
    common = min(evaluated.size, rendered.size)
    assert abs(evaluated.size - rendered.size) <= 3
    reference, candidate = _frame_db(rendered[:common]), _frame_db(evaluated[:common])
    live = reference > LIVE_FLOOR_DB
    assert np.abs(reference - candidate)[live].max() < FRAME_DB_TOLERANCE
    assert np.abs(evaluated[:common] - rendered[:common]).max() < 4e-3


def test_off_speaker_mutes_match_the_ffmpeg_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    clips = [c for c in project.clips if c.track_id == "caleb"]
    for clip in clips[:3]:
        clip.off_speaker_mute_regions = [
            ClipOffSpeakerMuteRegion(
                start_s=clip.source_start + 0.4, end_s=clip.source_start + 1.1, fade_out_ms=30
            ),
            ClipOffSpeakerMuteRegion(
                start_s=clip.source_start + 1.6, end_s=clip.source_start + 1.65
            ),
        ]
    track = project.track_by_id("caleb")
    defaults = load_defaults()
    rendered_path = tmp_path / "render.wav"
    render_track_from_timeline(project, track, rendered_path, defaults)
    rendered = load_mono_full(rendered_path)

    audio, curve = unfiltered_track_audio(project, track, defaults)
    evaluated = evaluate_audio(audio, crossfade_curve=curve, load_source=load_mono_full)

    assert evaluated is not None
    common = min(evaluated.size, rendered.size)
    assert abs(evaluated.size - rendered.size) <= 3
    reference, candidate = _frame_db(rendered[:common]), _frame_db(evaluated[:common])
    live = reference > LIVE_FLOOR_DB
    assert np.abs(reference - candidate)[live].max() < FRAME_DB_TOLERANCE
    assert np.abs(evaluated[:common] - rendered[:common]).max() < 4e-3


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
        (At(0.5004, SourceAudio(Path("b"), 0.0, 0.5)), At(1.0, SilenceAudio(0.25))),
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


def test_off_speaker_gain_follows_the_automatic_envelope() -> None:
    ones = np.ones(RATE, dtype=np.float32)
    leaf = SourceAudio(Path("a"), 0.0, 1.0)
    audio = OffSpeakerAudio(leaf, leaf, (SourceMuteEnvelope(0.25, 0.5, 0.05, 0.05),))

    result = evaluate_audio(audio, crossfade_curve="tri", load_source=lambda _: ones)

    assert result is not None
    assert result[:2000].tolist() == [1.0] * 2000
    assert result[2400:3600].tolist() == [0.0] * 1200
    assert result[2000] == 1.0
    assert 0.0 < result[2200] < 1.0
    assert result[4000:].tolist() == [1.0] * (result.size - 4000)


def test_pads_and_duplicates_in_a_sequence_are_evaluated() -> None:
    ones = np.ones(RATE, dtype=np.float32)
    audio = SequenceAudio(
        SourceAudio(Path("a"), 0.5, 0.75),
        (SourceAudio(Path("a"), 0.0, 0.25), SourceAudio(Path("a"), 0.5, 0.75)),
    )

    result = evaluate_audio(audio, crossfade_curve="tri", load_source=lambda _: ones)

    assert result is not None
    assert result.size == 6000


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
    unsupported = {
        "mask": (MaskAudio(leaf, 0.0, ((0.1, 0.2),)), "tri"),
        "crossfade curve": (CrossfadeAudio(leaf, leaf, 0.1), "qsin"),
        "overlap longer than a side": (CrossfadeAudio(leaf, leaf, 0.6), "tri"),
        "crossfade onto a duplicated slice": (CrossfadeAudio(leaf, leaf, 0.1), "tri"),
        "crossfade onto an earlier slice": (
            CrossfadeAudio(SourceAudio(Path("a"), 0.3, 0.9), leaf, 0.1),
            "tri",
        ),
    }

    for name, (audio, curve) in unsupported.items():
        assert evaluate_audio(audio, crossfade_curve=curve, load_source=lambda _: ones) is None, (
            name
        )


def _chained(project: EpisodeProject) -> EpisodeProject:
    project.mix.processing_chains = [
        ProcessingChain(track_id="caleb", effects=[ProcessingEffect(effect="highpass", params={})])
    ]
    return project


@pytest.mark.parametrize(
    "layout",
    ["cuts between 8 kHz samples", "crossfades between 8 kHz samples", "mixed joins and pads"],
)
def test_evaluation_matches_the_render_of_a_44100_hz_mono_track(
    layout: str, tmp_path: Path
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, layout, mono_rate=44100)
    track = project.track_by_id("caleb")
    defaults = load_defaults()
    rendered_path = tmp_path / "render.wav"
    render_track_from_timeline(project, track, rendered_path, defaults)
    rendered = load_mono_full(rendered_path)

    evaluated, reason = _evaluate(project, track, defaults)

    assert evaluated is not None, reason
    assert evaluated.size == rendered.size
    assert np.abs(evaluated - rendered).max() < SAMPLE_TOLERANCE


def test_chunk_edges_inside_slices_change_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    rng = np.random.default_rng(3)
    source = rng.normal(0, 0.1, 3 * RATE).astype(np.float32)
    mask = SourceAudio(Path("a"), 0.1, 1.4, 0.02, 0.03)
    audio = MixAudio(
        At(
            0.0,
            SequenceAudio(
                CrossfadeAudio(mask, SourceAudio(Path("a"), 1.5, 2.6, 0.0, 0.03), 0.01),
                (SilenceAudio(0.2), SourceAudio(Path("a"), 0.3, 0.9, 0.01, 0.01)),
            ),
        ),
        (At(0.7, SourceAudio(Path("a"), 2.0, 2.5, 0.01, 0.01)),),
    )
    whole = evaluate_audio(audio, crossfade_curve="tri", load_source=lambda _: source)
    monkeypatch.setattr(audio_eval, "CHUNK_SAMPLES", 777)

    def passthrough(chunks, _from, rates):  # type: ignore[no-untyped-def]
        whole = np.concatenate(list(chunks))
        return dict.fromkeys(rates, whole)

    chunked = audio_eval.evaluate_resampled(
        audio,
        crossfade_curve="tri",
        reader=lambda _: audio_eval.ArrayReader(source),
        sample_rate=RATE,
        target_rates=(RATE,),
        resample=passthrough,
    )

    assert whole is not None
    assert chunked is not None
    np.testing.assert_array_equal(chunked[RATE], whole)


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
    assert fast.samples.size == 141600


def test_reordered_slices_take_the_fast_path_without_a_render(
    tmp_path: Path, render_calls: list[str]
) -> None:
    _ffmpeg_or_skip()
    project = _chained(_project(tmp_path, "reordered and repeated slices"))

    caches = audio_audit.build_track_rms_caches(
        project, track_ids=["caleb"], unprocessed=True, defaults=load_defaults()
    )

    assert render_calls == []
    assert caches.caches["caleb"].samples.size > 0


def test_fast_cache_equals_the_rendered_cache(tmp_path: Path, render_calls: list[str]) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    defaults = load_defaults()
    track = project.track_by_id("caleb")
    stem = tmp_path / "stem.wav"
    render_track_from_timeline(project, track, stem, defaults)
    rendered = audio_audit.TrackRmsCache.from_timeline_stem(stem)

    render_calls.clear()
    fast = track_evidence.rms(project, "caleb", defaults)

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


@pytest.mark.parametrize("setup", [_with_envelope])
def test_ungated_cache_keeps_the_render_when_the_tree_needs_it(
    setup, tmp_path: Path, render_calls: list[str]
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    setup(project)

    cache = track_evidence.rms(project, "caleb", load_defaults())

    assert render_calls == ["caleb"]
    assert cache.samples.size > 0


def test_unfiltered_audio_declines_what_the_render_would_filter(tmp_path: Path) -> None:
    defaults = load_defaults()
    for setup in (_with_envelope,):
        project = _project(tmp_path / setup.__name__, "fade joins")
        setup(project)
        assert unfiltered_track_audio(project, project.track_by_id("caleb"), defaults) is None

    empty = _project(tmp_path / "empty", "fade joins")
    empty.timeline.clips = [c for c in empty.clips if c.track_id != "caleb"]
    assert unfiltered_track_audio(empty, empty.track_by_id("caleb"), defaults) is None


def _convert(source: Path, target: Path, *, rate: int | None = None, gain: float = 1.0) -> None:
    args = ["-af", f"volume={gain}"] if gain != 1.0 else []
    if rate is not None:
        args += ["-ar", str(rate)]
    run(
        [resolve_ffmpeg_pair().ffmpeg, "-v", "error", "-y", "-i", str(source), *args, str(target)],
        check=True,
    )


def _with_second_source(
    project: EpisodeProject, workspace: Path, *, rate: int | None = None
) -> list[Clip]:
    """The track's clips over two recordings: the second is another speaker's file."""
    path = workspace / "raw" / "second.flac"
    _convert(workspace / "raw" / "audra.flac", path, rate=rate)
    project.sources = [SourceRecording(id="second", path="raw/second.flac")]
    clips = [c for c in project.clips if c.track_id == "caleb"]
    for clip, source_id in zip(clips, [None, "second", "second", None, "second"], strict=True):
        clip.source_id = source_id
    return clips


def _with_gate_fill(project: EpisodeProject, workspace: Path) -> None:
    track = project.track_by_id("caleb")
    media = workspace / "raw" / "caleb.flac"
    _convert(workspace / "raw" / "lana.flac", workspace / "raw" / "fill.wav", gain=0.2)
    stat = media.stat()
    track.gate_fill = GateFill(
        source=GateFillSource.COMFORT_NOISE,
        path="raw/fill.wav",
        media_size=stat.st_size,
        media_mtime_ns=stat.st_mtime_ns,
        holes=1,
        filled_sec=1.0,
        level_db=-40.0,
        fade_ms=20,
    )


def _assert_evaluation_matches_render(project: EpisodeProject, tmp_path: Path) -> None:
    track = project.track_by_id("caleb")
    defaults = load_defaults()
    rendered_path = tmp_path / "render.wav"
    render_track_from_timeline(project, track, rendered_path, defaults)
    rendered = load_mono_full(rendered_path)

    evaluated, reason = _evaluate(project, track, defaults)

    assert evaluated is not None, reason
    assert abs(evaluated.size - rendered.size) <= 3
    common = min(evaluated.size, rendered.size)
    assert np.abs(evaluated[:common] - rendered[:common]).max() < SAMPLE_TOLERANCE
    reference, candidate = _frame_db(rendered[:common]), _frame_db(evaluated[:common])
    live = reference > LIVE_FLOOR_DB
    assert live.sum() > 10
    assert np.abs(reference - candidate)[live].max() < FRAME_DB_TOLERANCE


def test_several_sources_on_one_track_match_the_ffmpeg_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    clips = _with_second_source(project, tmp_path / "project")
    assert len({clip.source_id for clip in clips}) == 2

    _assert_evaluation_matches_render(project, tmp_path)


def test_gate_fill_under_the_tracks_own_media_matches_the_ffmpeg_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    _with_gate_fill(project, tmp_path / "project")
    defaults = load_defaults()
    audio, _ = unfiltered_track_audio(project, project.track_by_id("caleb"), defaults)
    assert any(leaf.fill_path is not None for leaf in audio_sources(audio))

    _assert_evaluation_matches_render(project, tmp_path)


def test_gate_fill_stays_under_the_primary_media_when_sources_are_mixed(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    workspace = tmp_path / "project"
    _with_second_source(project, workspace)
    _with_gate_fill(project, workspace)
    defaults = load_defaults()
    audio, _ = unfiltered_track_audio(project, project.track_by_id("caleb"), defaults)
    leaves = list(audio_sources(audio))
    assert {leaf.fill_path is not None for leaf in leaves} == {True, False}
    assert all((leaf.fill_path is None) == (leaf.source_id == "second") for leaf in leaves)

    _assert_evaluation_matches_render(project, tmp_path)


def test_sources_at_different_rates_keep_the_render(
    tmp_path: Path, render_calls: list[str]
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    _with_second_source(project, tmp_path / "project", rate=44100)
    defaults = load_defaults()

    evaluated, reason = _evaluate(project, project.track_by_id("caleb"), defaults)
    cache = track_evidence.rms(project, "caleb", defaults)

    assert evaluated is None
    assert reason is track_evidence.Declined.MIXED_RATE
    assert render_calls == ["caleb"]
    assert cache.samples.size > 0
