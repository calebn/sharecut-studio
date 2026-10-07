"""Source-gate holes are filled so a gated track never drops to dead air (#1111)."""

from __future__ import annotations

import re
import wave
from itertools import pairwise
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.gate_fill import detect_gate_holes, fill_gate_holes
from podcast_mcp.edits.room_tone import room_tone_source_id
from podcast_mcp.engines.play_audit import track_render_hash
from podcast_mcp.engines.timeline_render import (
    render_source_with_chain,
    render_track_from_timeline,
    render_track_segment,
)
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EpisodeProject,
    GateFillSource,
    MediaAsset,
    RoomToneFill,
    SourceRecording,
    Track,
    TrackRole,
)
from podcast_mcp.project_store import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace

SR = 16000
DURATION_SEC = 15.4
VOICE_DB = -20.0
ROOM_DB = -66.0
# The guest's gate opens 30 ms before each phrase and holds 150 ms after it; between
# phrases its track is digital silence, like Zoom's per-participant recordings.
PHRASES = (
    (0.6, 1.2),
    (2.0, 2.6),
    (3.4, 4.2),
    (5.2, 5.8),
    (6.6, 7.2),
    (8.0, 8.7),
    (9.6, 10.2),
    (11.0, 11.8),
    (12.6, 13.2),
    (14.0, 14.6),
)
OPEN_BEFORE = 0.03
HOLD = 0.15


def _holes(hold: float) -> tuple[tuple[float, float], ...]:
    """Interior holes; the silence before the first phrase and after the last is not a gate
    closing between words (a late joiner, padding), so it is left alone."""
    return tuple(
        (round(end + hold, 3), round(nxt - OPEN_BEFORE, 3))
        for (_, end), (nxt, _) in pairwise(PHRASES)
    )


HOLES = _holes(HOLD)
LEAD_END = 0.57
TRAIL_START = 14.75
# A 5 ms dropout inside a phrase: shorter than a gate closing, so not a hole.
DROPOUT = (3.8, 3.805)


def _write_wav(path: Path, samples: np.ndarray, sr: int = SR) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.round(np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as f:
        sr = f.getframerate()
        ch = f.getnchannels()
        raw = np.frombuffer(f.readframes(f.getnframes()), dtype="<i2")
    return raw.reshape(-1, ch)[:, 0].astype(np.float64) / 32768.0, sr


def _voice(n: int, level_db: float, f0: float = 140.0) -> np.ndarray:
    t = np.arange(n) / SR
    voice = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 9))
    voice *= 10 ** (level_db / 20) / np.sqrt(np.mean(voice**2))
    ramp = round(0.01 * SR)
    voice[:ramp] *= np.linspace(0.0, 1.0, ramp)
    voice[-ramp:] *= np.linspace(1.0, 0.0, ramp)
    return voice


def _gated_track(
    *,
    room_db: float = ROOM_DB,
    voice_db: float = VOICE_DB,
    seed: int = 1111,
    hold: float = HOLD,
    ring_sec: float = 0.0,
):
    """The guest's gated track. With ``ring_sec``, each phrase rings on in the room for that
    long, decaying 20 dB, and the gate counts its hold from the end of the ring."""
    rng = np.random.default_rng(seed)
    out = np.zeros(round(DURATION_SEC * SR))
    for start, end in PHRASES:
        i0, i1 = round((start - OPEN_BEFORE) * SR), round((end + ring_sec + hold) * SR)
        out[i0:i1] = rng.normal(0.0, 10 ** (room_db / 20), i1 - i0)
        v0, v1 = round(start * SR), round(end * SR)
        out[v0:v1] += _voice(v1 - v0, voice_db)
        ring = round(ring_sec * SR)
        decay = 10 ** (-np.arange(ring) / ring) if ring else np.zeros(0)
        out[v1 : v1 + ring] += rng.normal(0.0, 10 ** (voice_db / 20), ring) * decay
    out[round(DROPOUT[0] * SR) : round(DROPOUT[1] * SR)] = 0.0
    return out


def _peer_track(seed: int = 7) -> np.ndarray:
    """A peer with a -70 dB floor talking loudly inside every one of the guest's holes."""
    rng = np.random.default_rng(seed)
    out = rng.normal(0.0, 10 ** (-70 / 20), round(DURATION_SEC * SR))
    for start, end in HOLES:
        i0, i1 = round(start * SR), round(end * SR)
        out[i0:i1] += _voice(i1 - i0, -18.0, f0=210.0)
    return out


def _project(
    tmp_path: Path,
    guest: np.ndarray,
    *,
    peer: np.ndarray | None = None,
    clips: list[Clip] | None = None,
) -> EpisodeProject:
    project = EpisodeProject.create("gate_fill", str(tmp_path))
    tracks = {"guest": guest, **({"host": peer} if peer is not None else {})}
    for tid, samples in tracks.items():
        _write_wav(tmp_path / "raw" / f"{tid}.wav", samples)
        project.tracks.append(
            Track(
                id=tid,
                label=tid.title(),
                role=TrackRole.DIALOGUE,
                media=MediaAsset(
                    path=f"raw/{tid}.wav",
                    duration_sec=DURATION_SEC,
                    sample_rate=SR,
                    channels=1,
                ),
            )
        )
    project.clips = clips or [
        Clip(
            id="c_guest",
            track_id="guest",
            source_start=0.0,
            source_end=DURATION_SEC,
            timeline_start=0.0,
        )
    ]
    return project


def _encode_aac(project: EpisodeProject) -> None:
    """Re-encode the guest's media as AAC (Zoom's native format) and point the track at it."""
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.util.process import run

    track = project.track_by_id("guest")
    wav = project.workspace_path() / track.media.path
    m4a = wav.with_suffix(".m4a")
    run(
        [FFmpegEngine().ffmpeg, "-v", "error", "-i", str(wav), "-c:a", "aac", "-y", str(m4a)],
        check=True,
        timeout=30,
    )
    track.media.path = str(m4a.relative_to(project.workspace_path()))


def _defaults(mode: str = "auto") -> dict:
    return {"gate_fill": {"mode": mode, "fade_ms": 10}}


def _rms_db(x: np.ndarray) -> float:
    return 20 * np.log10(max(float(np.sqrt(np.mean(x**2))), 1e-12))


def _span(x: np.ndarray, start: float, end: float, sr: int = SR) -> np.ndarray:
    return x[round(start * sr) : round(end * sr)]


def _render(project: EpisodeProject, tmp_path: Path, name: str) -> np.ndarray:
    track = project.track_by_id("guest")
    assert track is not None
    out = render_track_from_timeline(project, track, tmp_path / "out" / f"{name}.wav", {})
    samples, sr = _read_wav(out)
    assert sr == SR
    return samples


# --- detection --------------------------------------------------------------------


def test_detects_interior_digital_silence_as_source_gate_holes(tmp_path: Path) -> None:
    path = tmp_path / "guest.wav"
    _write_wav(path, _gated_track())

    holes = detect_gate_holes(path)

    assert [(round(a, 3), round(b, 3)) for a, b in holes.spans] == list(HOLES)


def test_a_track_with_a_room_floor_and_no_digital_silence_has_no_holes(tmp_path: Path) -> None:
    rng = np.random.default_rng(3)
    floor = rng.normal(0.0, 10 ** (-70 / 20), round(DURATION_SEC * SR))
    path = tmp_path / "host.wav"
    _write_wav(path, floor)

    assert detect_gate_holes(path).spans == ()


# --- fill sources, in order -------------------------------------------------------


def test_gated_track_without_a_bed_gets_comfort_noise_at_its_own_floor(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())

    summary = fill_gate_holes(project, _defaults())

    fill = project.track_by_id("guest").gate_fill
    assert fill is not None
    assert fill.source is GateFillSource.COMFORT_NOISE
    assert fill.holes == len(HOLES)
    assert fill.filled_sec == pytest.approx(sum(b - a for a, b in HOLES), abs=0.01)
    assert fill.level_db == pytest.approx(ROOM_DB, abs=4.0)
    assert "guest" in summary
    rendered = _render(project, tmp_path, "filled")
    for a, b in HOLES:
        assert _rms_db(_span(rendered, a + 0.02, b - 0.02)) == pytest.approx(ROOM_DB, abs=4.0)


@pytest.mark.parametrize(
    ("hold", "ring_sec", "aac"),
    [(0.02, 0.0, False), (0.25, 0.0, False), (0.15, 0.1, False), (0.15, 0.0, True)],
    ids=["20ms-hold", "250ms-hold", "ringing-room-150ms-hold", "aac-150ms-hold"],
)
def test_comfort_noise_is_read_over_the_gates_own_hold(
    tmp_path: Path, hold: float, ring_sec: float, aac: bool
) -> None:
    # A fixed 120 ms window read a 20 ms gate's word tails as noise, 5 dB over its floor.
    # AAC fades the floor out over its last frame before each closure; the hold is read
    # from the level floor before that fade.
    project = _project(tmp_path, _gated_track(hold=hold, ring_sec=ring_sec))
    if aac:
        _encode_aac(project)

    summary = fill_gate_holes(project, _defaults())

    assert project.track_by_id("guest").gate_fill is not None
    measured = re.search(r"read over a (\d+) ms gate hold", summary)
    assert measured is not None
    assert 15 <= int(measured.group(1)) <= 1000 * hold
    rendered = _render(project, tmp_path, "filled")
    for a, b in _holes(ring_sec + hold):
        assert _rms_db(_span(rendered, a + 0.02, b - 0.02)) == pytest.approx(ROOM_DB, abs=2.0)


def test_a_gate_that_closes_on_a_ringing_voice_leaves_its_holes_silent(tmp_path: Path) -> None:
    # No hold: each closure cuts the voice's ring 20 dB under the voice, 26 dB over the
    # room, so the room is never heard and any fill would hiss.
    project = _project(tmp_path, _gated_track(hold=0.0, ring_sec=0.1))

    summary = fill_gate_holes(project, _defaults())

    assert project.track_by_id("guest").gate_fill is None
    assert "too short to measure" in summary


def test_recorded_room_tone_bed_comes_before_comfort_noise(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())
    t = np.arange(SR) / SR
    bed = 10 ** (-60 / 20) * np.sqrt(2) * np.sin(2 * np.pi * 220 * t)
    _write_wav(tmp_path / "raw" / "room-tone" / "guest.wav", bed)
    track = project.track_by_id("guest")
    track.room_tone = MediaAsset(path="raw/room-tone/guest.wav", duration_sec=1.0)
    project.sources.append(
        SourceRecording(id=room_tone_source_id("guest"), path="raw/room-tone/guest.wav")
    )

    fill_gate_holes(project, _defaults())

    assert track.gate_fill is not None
    assert track.gate_fill.source is GateFillSource.ROOM_TONE_BED
    rendered = _render(project, tmp_path, "bed")
    hole = _span(rendered, HOLES[2][0] + 0.05, HOLES[2][1] - 0.05)
    spectrum = np.abs(np.fft.rfft(hole * np.hanning(hole.size)))
    peak_hz = np.argmax(spectrum) * SR / hole.size
    assert peak_hz == pytest.approx(220.0, abs=5.0)
    assert _rms_db(hole) == pytest.approx(-60.0, abs=1.5)


def test_fill_never_carries_another_tracks_bleed(tmp_path: Path) -> None:
    alone = _project(tmp_path / "alone", _gated_track())
    with_peer = _project(tmp_path / "peer", _gated_track(), peer=_peer_track())

    fill_gate_holes(alone, _defaults())
    fill_gate_holes(with_peer, _defaults())

    a = alone.track_by_id("guest").gate_fill
    b = with_peer.track_by_id("guest").gate_fill
    assert a is not None and b is not None
    bed_a, _ = _read_wav_any(alone.workspace_path() / a.path)
    bed_b, _ = _read_wav_any(with_peer.workspace_path() / b.path)
    assert np.array_equal(bed_a, bed_b)
    # The peer's track has a floor and no holes: it gets no fill.
    assert with_peer.track_by_id("host").gate_fill is None


def test_no_comfort_noise_when_the_noise_under_speech_is_not_credible(tmp_path: Path) -> None:
    # Noise 15 dB under the voice is not a room floor; filling holes with it would hiss.
    project = _project(tmp_path, _gated_track(room_db=-35.0))

    summary = fill_gate_holes(project, _defaults())

    assert project.track_by_id("guest").gate_fill is None
    assert "near its speech" in summary


def test_track_too_short_to_measure_its_noise_is_left_alone(tmp_path: Path) -> None:
    # Two 25 ms blips: gate holes around them, but no open stretch long enough to analyse.
    short = np.zeros(round(1.0 * SR))
    v0, v1 = round(0.2 * SR), round(0.225 * SR)
    short[v0:v1] = _voice(v1 - v0, VOICE_DB)
    w0, w1 = round(0.6 * SR), round(0.625 * SR)
    short[w0:w1] = _voice(w1 - w0, VOICE_DB)
    project = _project(tmp_path, short)

    summary = fill_gate_holes(project, _defaults())

    assert project.track_by_id("guest").gate_fill is None
    assert "no noise measured" in summary


def test_mode_off_clears_an_existing_fill(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())
    fill_gate_holes(project, _defaults())
    assert project.track_by_id("guest").gate_fill is not None

    fill_gate_holes(project, _defaults("off"))

    assert project.track_by_id("guest").gate_fill is None


# --- render: own speech untouched, crossfades, our own edits ---------------------


def test_own_audio_is_byte_identical_outside_the_holes(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())
    plain = _render(project, tmp_path, "plain")

    fill_gate_holes(project, _defaults())
    filled = _render(project, tmp_path, "filled")

    outside = np.ones(plain.size, dtype=bool)
    for a, b in HOLES:
        outside[round(a * SR) : round(b * SR)] = False
    assert plain.size == filled.size
    assert np.array_equal(plain[outside], filled[outside])
    assert not np.array_equal(plain[~outside], filled[~outside])


def test_segment_render_keeps_own_audio_byte_identical(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())
    plain_path = render_track_segment(project, "guest", 2.5, 5.5, tmp_path / "seg_plain.wav", {})
    plain, _ = _read_wav(plain_path)

    fill_gate_holes(project, _defaults())
    filled_path = render_track_segment(project, "guest", 2.5, 5.5, tmp_path / "seg_fill.wav", {})
    filled, _ = _read_wav(filled_path)

    outside = np.ones(plain.size, dtype=bool)
    for a, b in HOLES:
        lo, hi = max(a, 2.5) - 2.5, min(b, 5.5) - 2.5
        if hi > lo:
            outside[round(lo * SR) : round(hi * SR)] = False
    assert np.array_equal(plain[outside], filled[outside])
    assert _rms_db(_span(filled, 2.76 - 2.5, 3.36 - 2.5)) == pytest.approx(ROOM_DB, abs=4.0)


@pytest.mark.parametrize(
    "suffix",
    [
        "wav",
        # Multi-source renders input-seek AAC media up to a frame off an exact decode, while
        # the fill is seeked exactly, so the fill lands on speech until #1141 lands.
        pytest.param("m4a", marks=pytest.mark.xfail(reason="#1141", strict=True)),
    ],
)
def test_fill_never_overlaps_speech_in_a_multi_source_render(tmp_path: Path, suffix: str) -> None:
    # A room-tone-filled mute reads a second stretch of the media, so the render seeks it.
    clip = Clip(
        id="c_guest",
        track_id="guest",
        source_start=1.2345678,
        source_end=DURATION_SEC,
        timeline_start=0.0,
        mute_regions=[
            ClipMuteRegion(start_s=5.3, end_s=5.6, fill=RoomToneFill(start_s=1.5, end_s=1.9))
        ],
    )
    project = _project(tmp_path, _gated_track(), clips=[clip])
    track = project.track_by_id("guest")
    if suffix == "m4a":
        _encode_aac(project)
    plain = _render(project, tmp_path, "plain")

    fill_gate_holes(project, _defaults())
    filled = _render(project, tmp_path, "filled")

    assert track.gate_fill is not None
    assert plain.size == filled.size
    own = plain != 0.0
    assert np.array_equal(filled[own], plain[own])
    assert not np.array_equal(filled[~own], plain[~own])


def test_guest_proxy_render_carries_the_fill(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())
    track = project.track_by_id("guest")
    plain, _ = _read_wav(render_source_with_chain(project, track, tmp_path / "proxy_plain.wav"))

    fill_gate_holes(project, _defaults())
    filled, _ = _read_wav(render_source_with_chain(project, track, tmp_path / "proxy_fill.wav"))

    outside = np.ones(plain.size, dtype=bool)
    for a, b in HOLES:
        outside[round(a * SR) : round(b * SR)] = False
        assert _rms_db(_span(filled, a + 0.02, b - 0.02)) == pytest.approx(ROOM_DB, abs=4.0)
    assert np.array_equal(plain[outside], filled[outside])


def test_an_unknown_mode_is_rejected(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())

    with pytest.raises(ValueError, match=r"gate_fill\.mode"):
        fill_gate_holes(project, _defaults("on"))


def test_fill_fades_in_and_out_inside_each_hole(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())
    fill_gate_holes(project, _defaults())
    rendered = _render(project, tmp_path, "fades")

    fade = round(0.010 * SR)
    for a, b in HOLES:
        i0, i1 = round(a * SR), round(b * SR)
        middle = _rms_db(rendered[i0 + 4 * fade : i1 - 4 * fade])
        assert abs(rendered[i0]) <= 2 / 32768
        assert abs(rendered[i1 - 1]) <= 2 / 32768
        assert _rms_db(rendered[i0 : i0 + fade // 4]) < middle - 9
        assert _rms_db(rendered[i1 - fade // 4 : i1]) < middle - 9
        assert _rms_db(rendered[i0 + fade : i0 + 2 * fade]) == pytest.approx(middle, abs=4.0)


def test_our_mutes_and_pads_stay_silent_and_leading_silence_is_not_a_hole(
    tmp_path: Path,
) -> None:
    clips = [
        Clip(
            id="c1",
            track_id="guest",
            source_start=0.0,
            source_end=4.3,
            timeline_start=0.0,
            mute_regions=[ClipMuteRegion(start_s=1.5, end_s=2.7)],
        ),
        # A 0.5 s pad between the clips: a hole on the timeline, not in the source.
        Clip(
            id="c2",
            track_id="guest",
            source_start=4.3,
            source_end=DURATION_SEC,
            timeline_start=4.8,
        ),
    ]
    project = _project(tmp_path, _gated_track(), clips=clips)
    fill_gate_holes(project, _defaults())
    rendered = _render(project, tmp_path, "edits")

    assert np.max(np.abs(_span(rendered, 0.0, LEAD_END))) == 0.0
    assert _rms_db(_span(rendered, 1.37, 1.49)) == pytest.approx(ROOM_DB, abs=4.0)
    assert np.max(np.abs(_span(rendered, 1.51, 2.69))) == 0.0
    assert _rms_db(_span(rendered, 2.77, 3.35)) == pytest.approx(ROOM_DB, abs=4.0)
    assert np.max(np.abs(_span(rendered, 4.31, 4.79))) == 0.0
    assert _rms_db(_span(rendered, 4.87, 5.65)) == pytest.approx(ROOM_DB, abs=4.0)
    assert np.max(np.abs(_span(rendered, TRAIL_START + 0.5 + 0.01, DURATION_SEC + 0.49))) == 0.0


def test_a_replaced_recording_drops_its_stale_fill(tmp_path: Path) -> None:
    project = _project(tmp_path, _gated_track())
    fill_gate_holes(project, _defaults())
    replaced = _gated_track(seed=99)
    replaced[: round(0.1 * SR)] = 0.0
    _write_wav(tmp_path / "raw" / "guest.wav", np.concatenate([replaced, np.zeros(SR // 10)]))

    rendered = _render(project, tmp_path, "stale")

    for a, b in HOLES:
        assert np.max(np.abs(_span(rendered, a + 0.01, b - 0.01))) == 0.0


# --- undoable and visible ---------------------------------------------------------


def test_pipeline_step_is_undoable_and_changes_the_render_hash(tmp_path: Path) -> None:
    from podcast_mcp.services.document import HistoryService
    from podcast_mcp.services.pipeline import PipelineService

    project = _project(tmp_path, _gated_track())
    project.ensure_dirs()
    project_file = save_project(project)
    before = track_render_hash(project, "guest")
    ws = ProjectWorkspace.open(project_file)

    result = PipelineService(ws).run(only_step="fill_gate_holes", config=_defaults())

    filled = load_project(project_file)
    assert filled.track_by_id("guest").gate_fill is not None
    assert track_render_hash(filled, "guest") != before
    step_log = result.steps[-1]
    assert step_log.step == "fill_gate_holes"
    assert "comfort noise" in (step_log.message or "")

    HistoryService(ProjectWorkspace.open(project_file)).undo()

    undone = load_project(project_file)
    assert undone.track_by_id("guest").gate_fill is None
    assert track_render_hash(undone, "guest") == before


def _read_wav_any(path: Path) -> tuple[np.ndarray, int]:
    from podcast_mcp.engines.align import load_mono_window

    return load_mono_window(path, start_sec=0.0, duration_sec=3600.0, sample_rate=SR), SR
