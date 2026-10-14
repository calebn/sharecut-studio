"""Tighten judges quiet and audible against each track's own levels (#1195).

Tighten reads raw, unnormalized tracks, so a fixed dBFS floor moves its proposals with the
recording level. Every scenario here is rendered at several gains, and each gain must
propose the same cuts with edges inside one 10 ms frame of the unscaled recording.
"""

from __future__ import annotations

import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.edits.silence_islands import suggest_handoff_cut
from podcast_mcp.edits.speech_energy_guard import (
    _peer_voice_in_mean,
    measure_peer_speech,
)
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.engines.audio_audit import build_track_rms_caches, measure_timeline_rms_db
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

RATE = 16_000
SECONDS = 20
# -36 dB puts the speech near -60 dBFS, as on a quiet recording.
GAINS_DB = (-36.0, -34.0, -24.0, -18.0, -12.0, 6.0, 12.0)
FRAME_SEC = 0.01
HOP_SEC = 0.02
SPEECH_DB = -24.0
ROOM_DB = -68.0


def _tone(n: int, level_db: float, f0: float = 150.0) -> np.ndarray:
    t = np.arange(n) / RATE
    tone = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 6))
    return tone / np.sqrt(np.mean(tone**2)) * 10 ** (level_db / 20)


def _voice(audio: np.ndarray, start: float, end: float, level_db: float = SPEECH_DB) -> None:
    lo, hi = round(start * RATE), round(end * RATE)
    audio[lo:hi] += _tone(hi - lo, level_db)


def _decay(audio: np.ndarray, start: float, end: float, from_db: float, to_db: float) -> None:
    """Voice whose level falls linearly in dB: the tail a word's voice leaves past its end."""
    lo, hi = round(start * RATE), round(end * RATE)
    shape = 10 ** (np.linspace(from_db, to_db, hi - lo) / 20)
    audio[lo:hi] += _tone(hi - lo, 0.0) * shape


def _fricative(audio: np.ndarray, start: float, end: float, from_db: float, to_db: float) -> None:
    lo, hi = round(start * RATE), round(end * RATE)
    shape = 10 ** (np.linspace(from_db, to_db, hi - lo) / 20)
    audio[lo:hi] += np.random.default_rng(5).standard_normal(hi - lo) * shape


def _room(seed: int, *, gated: bool = False) -> np.ndarray:
    if gated:
        return np.zeros(SECONDS * RATE)
    return np.random.default_rng(seed).normal(0, 10 ** (ROOM_DB / 20), SECONDS * RATE)


def _host(*, gated: bool) -> tuple[np.ndarray, list[TranscriptWord]]:
    """A kept word with a decaying voice, a filler before a soft fricative, a filler that
    runs into the next word, a filler too quiet to hear, and a murmur inside a long pause."""
    audio = _room(11, gated=gated)
    _voice(audio, 1.0, 1.3)
    _decay(audio, 1.3, 1.62, SPEECH_DB, SPEECH_DB - 40.0)
    _voice(audio, 3.0, 3.35, SPEECH_DB - 3.0)
    _fricative(audio, 3.5, 3.62, ROOM_DB - 4.0, SPEECH_DB - 30.0)
    _voice(audio, 3.62, 4.1)
    _voice(audio, 6.0, 6.3, SPEECH_DB - 2.0)
    _voice(audio, 6.3, 6.8)
    _voice(audio, 9.0, 9.3, SPEECH_DB - 31.0)
    _voice(audio, 9.9, 10.4)
    _voice(audio, 11.0, 11.4)
    _voice(audio, 12.2, 12.5, SPEECH_DB - 22.0)
    _voice(audio, 15.0, 15.4)
    words = [
        ("so", 1.0, 1.3),
        ("well", 2.4, 2.8),
        ("um", 3.0, 3.35),
        ("right", 3.55, 4.1),
        ("and", 5.4, 5.8),
        ("uh", 6.0, 6.3),
        ("that", 6.3, 6.8),
        ("uh", 9.0, 9.3),
        ("yes", 9.9, 10.4),
        ("then", 11.0, 11.4),
        ("end", 15.0, 15.4),
    ]
    return audio, [TranscriptWord(text=t, start=s, end=e) for t, s, e in words]


def _guest(*, gated: bool) -> tuple[np.ndarray, list[TranscriptWord]]:
    audio = _room(23, gated=gated)
    _voice(audio, 16.2, 17.0)
    _voice(audio, 17.2, 18.0)
    words = [("okay", 16.2, 17.0), ("sure", 17.2, 18.0)]
    return audio, [TranscriptWord(text=t, start=s, end=e) for t, s, e in words]


def _pcm24(samples: np.ndarray) -> bytes:
    """24-bit PCM, so a quiet recording's quantization noise is not part of what is measured."""
    ints = np.rint(samples * 8388607).astype("<i4")
    return ints.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()


def _project(
    tmp_path: Path,
    gain_db: float,
    *,
    gated: bool,
    tracks: tuple[tuple[str, tuple[np.ndarray, list[TranscriptWord]]], ...] | None = None,
) -> EpisodeProject:
    """The host and a guest, and a third track with no audio at all (a lane that never spoke)."""
    project = EpisodeProject.create("gain", str(tmp_path))
    silent = (np.zeros(SECONDS * RATE), [])
    for track_id, (audio, words) in tracks or (
        ("host", _host(gated=gated)),
        ("guest", _guest(gated=gated)),
        ("lull", silent),
    ):
        path = tmp_path / "raw" / f"{track_id}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        scaled = audio * 10 ** (gain_db / 20)
        assert np.max(np.abs(scaled)) < 1.0
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(3)
            handle.setframerate(RATE)
            handle.writeframes(_pcm24(scaled))
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=float(SECONDS)),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c_{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=float(SECONDS),
                timeline_start=0.0,
            )
        )
        project.transcripts.append(Transcript(track_id=track_id, words=words))
    return project


def _proposals(tmp_path: Path, gain_db: float, edit_mode: str, intensity: str, *, gated: bool):
    return _rows(_proposal(_project(tmp_path, gain_db, gated=gated), edit_mode, intensity))


def _proposal(project: EpisodeProject, edit_mode: str, intensity: str):
    defaults = {
        "tighten": {
            "edit_mode": edit_mode,
            "filler_words": ["um", "uh"],
            "discourse_markers": [],
        }
    }
    return propose_tighten_edits(project, defaults, intensity=intensity)


def _rows(proposal) -> list:
    return sorted(
        (d.track_id, d.reason, d.start, d.end, d.review_required) for d in proposal.decisions
    )


# What the unscaled (0 dB) recording must propose: (track, reason, start, end, review_required).
_UNGATED_MUTE = [
    ("host", "filler:acoustic", 12.14, 12.565, True),
    ("host", "filler:uh:voiced_edge", 5.84, 6.295, True),
    ("host", "filler:um", 2.84, 3.47, False),
]
_RIPPLE_FILLERS = [
    ("host", "filler:uh:voiced_edge", 5.84, 6.295, True),
    ("host", "filler:um", 2.84, 3.47, False),
]
_EXPECTED = {
    (False, "mute", "medium"): _UNGATED_MUTE,
    (False, "ripple", "medium"): [
        ("host", "filler:uh", 8.965, 9.5, False),
        *_RIPPLE_FILLERS,
        ("host", "pause:1.30s:solo:air_edges", 4.15, 4.85, False),
        ("host", "pause:2.20s:solo:air_edges", 6.85, 8.45, False),
        ("host", "pause:3.60s:solo:air_edges", 12.59, 14.45, False),
    ],
    (False, "ripple", "aggressive"): [
        ("host", "filler:uh", 8.965, 9.5, False),
        *_RIPPLE_FILLERS,
        ("host", "pause:1.10s:solo:air_edges", 1.66, 2.089, False),
        ("host", "pause:1.30s:solo:air_edges", 4.15, 5.1, False),
        ("host", "pause:2.20s:solo:air_edges", 6.85, 8.7, False),
        ("host", "pause:3.60s:solo:air_edges", 12.59, 14.693, False),
    ],
    (True, "mute", "medium"): [
        ("host", "filler:acoustic", 12.14, 12.501, True),
        *_RIPPLE_FILLERS,
    ],
    (True, "ripple", "medium"): [
        ("host", "filler:acoustic", 12.14, 12.501, True),
        ("host", "filler:uh", 8.96, 9.5, False),
        *_RIPPLE_FILLERS,
        ("host", "pause:1.30s:solo:air_edges", 4.13, 4.85, False),
        ("host", "pause:2.20s:solo", 6.83, 8.42, False),
        ("host", "pause:3.60s:solo:air_edges", 12.53, 14.45, False),
    ],
    (True, "ripple", "aggressive"): [
        ("host", "filler:acoustic", 12.14, 12.501, True),
        ("host", "filler:uh", 8.96, 9.5, False),
        *_RIPPLE_FILLERS,
        ("host", "pause:1.10s:solo:air_edges", 1.65, 2.06, False),
        ("host", "pause:1.30s:solo:air_edges", 4.13, 5.06, False),
        ("host", "pause:2.20s:solo:air_edges", 6.83, 8.66, False),
        ("host", "pause:3.60s:solo:air_edges", 12.53, 14.66, False),
    ],
}


def _assert_the_same_at_every_level(
    tmp_path: Path, edit_mode: str, intensity: str, *, gated: bool
) -> None:
    expected = sorted(_EXPECTED[(gated, edit_mode, intensity)])
    for gain_db in (0.0, *GAINS_DB):
        got = _proposals(tmp_path / str(gain_db), gain_db, edit_mode, intensity, gated=gated)
        assert [(t, r, f) for t, r, _, _, f in got] == [(t, r, f) for t, r, _, _, f in expected], (
            gain_db
        )
        for (_, _, start, end, _), (_, _, want_start, want_end, _) in zip(
            got, expected, strict=True
        ):
            assert start == pytest.approx(want_start, abs=FRAME_SEC + 1e-6), gain_db
            assert end == pytest.approx(want_end, abs=FRAME_SEC + 1e-6), gain_db


@pytest.mark.parametrize(
    ("edit_mode", "intensity"), [("mute", "medium"), ("ripple", "medium"), ("ripple", "aggressive")]
)
def test_proposals_are_the_same_at_every_recording_level(
    tmp_path: Path, edit_mode: str, intensity: str
) -> None:
    _assert_the_same_at_every_level(tmp_path, edit_mode, intensity, gated=False)


@pytest.mark.parametrize("edit_mode", ["mute", "ripple"])
def test_proposals_on_a_gated_recording_are_the_same_at_every_level(
    tmp_path: Path, edit_mode: str
) -> None:
    """A noise gate holds the tracks at digital zero between words (Zoom), so the room is -inf."""
    _assert_the_same_at_every_level(tmp_path, edit_mode, "medium", gated=True)


def _peer_tracks(*, gated: bool):
    """The host murmurs in two long pauses; the guest voices over the first only."""
    host = _room(11, gated=gated)
    host_words = [("so", 1.0, 1.3), ("end", 3.0, 3.3), ("okay", 6.0, 6.3)]
    for _, start, end in host_words:
        _voice(host, start, end)
    _voice(host, 1.8, 2.1, SPEECH_DB - 22.0)
    _voice(host, 4.4, 4.7, SPEECH_DB - 22.0)
    guest = _room(23, gated=gated)
    _voice(guest, 1.7, 2.2)
    guest_words = [("right", 1.7, 2.2)]
    return (
        ("host", (host, [TranscriptWord(text=t, start=a, end=b) for t, a, b in host_words])),
        ("guest", (guest, [TranscriptWord(text=t, start=a, end=b) for t, a, b in guest_words])),
    )


@pytest.mark.parametrize("gated", [False, True])
def test_a_peer_voiced_in_a_pause_blocks_the_hint_at_every_level(
    tmp_path: Path, gated: bool
) -> None:
    """Only the pause the guest is silent in yields an acoustic hint, at any recording level."""
    for gain_db in (0.0, *GAINS_DB):
        project = _project(
            tmp_path / str(gain_db), gain_db, gated=gated, tracks=_peer_tracks(gated=gated)
        )
        proposal = _proposal(project, "mute", "medium")
        hints = [row for row in _rows(proposal) if row[1] == "filler:acoustic"]
        assert proposal.skip_counts.get("acoustic:peer_speaking") == 1, gain_db
        assert len(hints) == 1, gain_db
        assert hints[0][2] == pytest.approx(4.4, abs=0.1 + FRAME_SEC), gain_db


LEVELS_DB = (12.0, 0.0, -12.0, -24.0, -36.0)
_HANDOFF_LEFT = 2.0
_HANDOFF_RIGHT = 12.0
UNEQUAL_DB = -20.0


def _handoff_tracks(*, gated: bool, um_at: float, guest_db: float = 0.0):
    """Both talk either side of a long gap; the host's um and the guest's murmur sit in it.

    The guest is a sparse speaker (a second of speech), recorded ``guest_db`` under the host.
    """
    host = _room(11, gated=gated)
    _voice(host, 1.0, _HANDOFF_LEFT)
    _voice(host, um_at, um_at + 0.35, SPEECH_DB - 22.0)
    _voice(host, _HANDOFF_RIGHT, 13.0)
    guest = _room(23, gated=gated)
    _voice(guest, 8.0, 8.4, SPEECH_DB - 22.0)
    _voice(guest, 15.0, 16.0)
    return (("host", (host, [])), ("guest", (guest * 10 ** (guest_db / 20), [])))


def _handoff(
    tmp_path: Path, gain_db: float, *, gated: bool, um_at: float, guest_db: float = 0.0
) -> dict:
    project = _project(
        tmp_path / str(gain_db),
        gain_db,
        gated=gated,
        tracks=_handoff_tracks(gated=gated, um_at=um_at, guest_db=guest_db),
    )
    return suggest_handoff_cut(project, ["host", "guest"], _HANDOFF_LEFT, _HANDOFF_RIGHT)


def _handoff_outcome(out: dict) -> tuple:
    return (
        out["ok"],
        out["cut_start"],
        out["cut_end"],
        sorted(out["warnings"]),
        [edge for i in out["islands"] for edge in (i["start"], i["end"])],
    )


@pytest.mark.parametrize("guest_db", [0.0, UNEQUAL_DB], ids=["equal", "unequal"])
@pytest.mark.parametrize("gated", [False, True])
def test_a_handoff_cut_is_the_same_at_every_recording_level(
    tmp_path: Path, gated: bool, guest_db: float
) -> None:
    """The um mid-gap goes with the cut and the guest's murmur splits the quiet, at any level."""
    outcomes = {
        gain: _handoff_outcome(_handoff(tmp_path, gain, gated=gated, um_at=6.0, guest_db=guest_db))
        for gain in (0.0, *LEVELS_DB)
    }
    ok, cut_start, cut_end, warnings, islands = outcomes[0.0]
    assert (ok, warnings) == (True, [])
    assert [cut_start, cut_end] == pytest.approx([3.0, 11.0], abs=0.1)
    assert len(islands) == 6
    for gain, (g_ok, g_start, g_end, g_warnings, g_islands) in outcomes.items():
        assert (g_ok, g_warnings) == (ok, warnings), gain
        assert [g_start, g_end] == pytest.approx([cut_start, cut_end], abs=HOP_SEC + 1e-6), gain
        assert g_islands == pytest.approx(islands, abs=HOP_SEC + 1e-6), gain


@pytest.mark.parametrize("gated", [False, True])
def test_a_handoff_refuses_an_um_at_the_retain_target_at_every_recording_level(
    tmp_path: Path, gated: bool
) -> None:
    for gain in LEVELS_DB:
        out = _handoff(tmp_path, gain, gated=gated, um_at=2.85)
        assert out["ok"] is False, gain
        assert "cut_start_not_quiet" in out["warnings"], gain


_GUARD_ON = {
    "tighten": {"speech_energy_guard": {"enabled": True, "on_conflict": "review"}},
    "analysis": {"heuristics": {}},
}
_PEER_SPAN = (6.0, 9.0)
_OPEN_MIC_DB = -50.0


def _peer_tracks_in_span(
    *, voice_db: float | None, guest_db: float = 0.0, host_voice_in_span: bool = False
):
    """The host speaks around a pause. The guest holds an open mic, and may speak in the pause.

    The guest's voice is one second long (a sparse speaker), ``voice_db`` over a room it
    shares with an open mic at ``_OPEN_MIC_DB``; ``guest_db`` is how far under the host it is
    recorded. ``host_voice_in_span`` has the host speak through the pause too, at the same
    pitch as the guest.
    """
    host = _room(11, gated=False)
    _voice(host, 1.0, 5.5, SPEECH_DB + 4.0)
    _voice(host, 9.5, 14.0, SPEECH_DB + 4.0)
    if host_voice_in_span:
        _voice(host, 6.5, 7.5, SPEECH_DB + 4.0)
    guest = np.random.default_rng(23).normal(0, 10 ** (_OPEN_MIC_DB / 20), SECONDS * RATE)
    if voice_db is not None:
        _voice(guest, 6.5, 7.5, voice_db)
    return (("host", (host, [])), ("guest", (guest * 10 ** (guest_db / 20), [])))


def _speaking(project: EpisodeProject, *, cached: bool) -> tuple[str, ...]:
    """Who speaks in the pause, with the frame evidence withheld so the span's mean decides."""
    caches = build_track_rms_caches(project) if cached else None
    kwargs = {
        "owner_track_ids": ["host"],
        "peer_track_ids": ["guest"],
        "defaults": _GUARD_ON,
        "caches": caches,
    }
    with patch("podcast_mcp.edits.speech_energy_guard.timeline_frame_levels_db", return_value=None):
        levels = measure_peer_speech(project, [_PEER_SPAN], **kwargs)
    assert levels is not None
    assert levels.unread == {}
    return levels.speaking


def _speaking_at_every_level(tmp_path: Path, tracks: tuple, *, cached: bool) -> dict:
    return {
        gain: _speaking(
            _project(tmp_path / str(gain), gain, gated=False, tracks=tracks), cached=cached
        )
        for gain in (0.0, *LEVELS_DB)
    }


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("guest_db", [0.0, UNEQUAL_DB], ids=["equal", "unequal"])
@pytest.mark.parametrize("voice", [False, True], ids=["open_mic", "sparse_voice"])
def test_the_peer_fallback_is_the_same_at_every_recording_level(
    tmp_path: Path, cached: bool, guest_db: float, voice: bool
) -> None:
    """With no frames to read, a sparse speaker's voice in the span speaks and an open mic does not."""
    tracks = _peer_tracks_in_span(voice_db=SPEECH_DB if voice else None, guest_db=guest_db)
    expected = ("guest",) if voice else ()
    for gain, speaking in _speaking_at_every_level(tmp_path, tracks, cached=cached).items():
        assert speaking == expected, gain


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize(
    ("under_host_db", "expected"),
    [(-1.0, ("guest",)), (-12.0, ("guest",)), (-36.0, ())],
)
def test_a_same_pitch_peer_is_detected_by_its_own_reach_not_owner_dominance(
    tmp_path: Path, cached: bool, under_host_db: float, expected: tuple[str, ...]
) -> None:
    """Both voices share a pitch; fallback reads the peer's own reach, not the owner's level."""
    tracks = _peer_tracks_in_span(voice_db=SPEECH_DB + 4.0 + under_host_db, host_voice_in_span=True)
    for gain, speaking in _speaking_at_every_level(tmp_path, tracks, cached=cached).items():
        assert speaking == expected, gain


def _frame_fallback_quiet_peer_tracks() -> tuple:
    """A 1 s guest word 30 dB under speech in a 3 s pause; span mean stays under reach."""
    host = _room(11, gated=False)
    _voice(host, 1.0, 5.5, SPEECH_DB + 4.0)
    _voice(host, 9.5, 14.0, SPEECH_DB + 4.0)
    guest = np.random.default_rng(23).normal(0, 10 ** (_OPEN_MIC_DB / 20), SECONDS * RATE)
    _voice(guest, 6.5, 7.5, SPEECH_DB - 30.0)
    return (("host", (host, [])), ("guest", (guest, [])))


def test_frame_fallback_finds_quiet_peer_when_mean_and_trunk_stay_silent(tmp_path: Path) -> None:
    """Frame fallback must hear a brief peer word the whole-span mean and trunk miss (#1419).

    At 30 dB under speech the span mean stays below session reach; merge-base fallback stays
    silent. Tighten retains decoded RMS caches, so live and cached frame reads must agree.
    """
    tracks = _frame_fallback_quiet_peer_tracks()
    project = _project(tmp_path, 0.0, gated=False, tracks=tracks)
    caches = build_track_rms_caches(project)
    span_rms = measure_timeline_rms_db(project, "guest", *_PEER_SPAN, caches=caches)
    assert span_rms is not None
    assert _peer_voice_in_mean(project, "guest", span_rms, caches) is False
    kwargs = {
        "owner_track_ids": ["host"],
        "peer_track_ids": ["guest"],
        "defaults": _GUARD_ON,
    }
    with patch("podcast_mcp.edits.speech_energy_guard._peer_speaks_near_span", return_value=None):
        cached = measure_peer_speech(project, [_PEER_SPAN], caches=caches, **kwargs)
        live = measure_peer_speech(project, [_PEER_SPAN], caches=None, **kwargs)
    assert cached is not None and live is not None
    assert cached.speaking == live.speaking == ("guest",)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_frame_fallback_quiet_peer_is_gain_invariant(tmp_path: Path, cached: bool) -> None:
    tracks = _frame_fallback_quiet_peer_tracks()
    for gain in (0.0, *LEVELS_DB):
        project = _project(tmp_path / str(gain), gain, gated=False, tracks=tracks)
        caches = build_track_rms_caches(project) if cached else None
        with patch(
            "podcast_mcp.edits.speech_energy_guard._peer_speaks_near_span", return_value=None
        ):
            levels = measure_peer_speech(
                project,
                [_PEER_SPAN],
                owner_track_ids=["host"],
                peer_track_ids=["guest"],
                defaults=_GUARD_ON,
                caches=caches,
            )
        assert levels is not None
        assert levels.speaking == ("guest",), gain


def test_session_reach_skips_dialogue_lane_with_missing_media(tmp_path: Path) -> None:
    """A flat peer's session median must not fail when another dialogue lane has no file (#1419)."""
    import math

    from podcast_mcp.edits.speech_energy_guard import _session_voice_reach_db

    host_audio, host_words = _host(gated=False)
    guest = np.random.default_rng(4).normal(0, 0.001, SECONDS * RATE)
    project = _project(
        tmp_path,
        0.0,
        gated=False,
        tracks=(
            ("host", (host_audio, host_words)),
            ("guest", (guest, [])),
        ),
    )
    project.timeline.tracks.append(
        Track(
            id="bender",
            label="bender",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/bender.wav", duration_sec=float(SECONDS)),
        )
    )
    project.timeline.clips.append(
        Clip(
            id="c_bender",
            track_id="bender",
            source_start=0.0,
            source_end=float(SECONDS),
            timeline_start=0.0,
        )
    )
    caches = build_track_rms_caches(project)
    reach = _session_voice_reach_db(project, "guest", caches)
    assert reach is not None and math.isfinite(reach)


def test_sparse_ungated_peer_reach_clamp_is_gain_invariant(tmp_path: Path) -> None:
    """Removing the reach clamp must not be the only guard on sparse ungated peer fallback."""
    tracks = _peer_tracks_in_span(voice_db=SPEECH_DB, guest_db=UNEQUAL_DB)
    speaking = _speaking_at_every_level(tmp_path, tracks, cached=True)
    assert speaking and all(s == ("guest",) for s in speaking.values())


def test_a_peer_with_no_audio_never_speaks(tmp_path: Path) -> None:
    tracks = _peer_tracks_in_span(voice_db=None)
    silent = (np.zeros(SECONDS * RATE), [])
    for gain in LEVELS_DB:
        project = _project(
            tmp_path / str(gain), gain, gated=True, tracks=(tracks[0], ("guest", silent))
        )
        assert _speaking(project, cached=True) == (), gain


def test_a_flat_peer_as_loud_as_the_owner_with_nothing_to_read_it_against_is_no_voice(
    tmp_path: Path,
) -> None:
    host = ("host", (np.random.default_rng(3).normal(0, 0.001, SECONDS * RATE), []))
    guest = ("guest", (np.random.default_rng(4).normal(0, 0.001, SECONDS * RATE), []))
    project = _project(tmp_path, 0.0, gated=True, tracks=(host, guest))
    assert _speaking(project, cached=False) == ()


def test_a_flat_peer_over_a_silent_owner_with_nothing_to_read_it_against_speaks(
    tmp_path: Path,
) -> None:
    """A flat peer over a silent owner is the louder one, at any recording level."""
    host_silent = ("host", (np.zeros(SECONDS * RATE), []))
    guest = ("guest", (np.random.default_rng(3).normal(0, 0.001, SECONDS * RATE), []))
    project = _project(tmp_path, 0.0, gated=True, tracks=(host_silent, guest))
    assert _speaking(project, cached=False) == ("guest",)
