"""Tighten judges quiet and audible against each track's own levels (#1195).

Tighten reads raw, unnormalized tracks, so a fixed dBFS floor moves its proposals with the
recording level. Every scenario here is rendered at several gains, and each gain must
propose the same cuts with edges inside one 10 ms frame of the unscaled recording.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.tighten import propose_tighten_edits
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
# -34 dB puts the speech near -58 dBFS, as on a quiet recording. A gated recording is also
# held to -40 dB (speech near -64 dBFS); with a room floor the pause-island quiet level is
# still fixed (#1306), so that gain waits for it.
GAINS_DB = (-34.0, -18.0, -12.0, 6.0, 12.0)
GATED_ONLY_GAINS_DB = (-40.0,)
FRAME_SEC = 0.01
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
    for gain_db in (0.0, *GAINS_DB, *(GATED_ONLY_GAINS_DB if gated else ())):
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
    for gain_db in (0.0, -34.0, -18.0, 6.0, 12.0):
        project = _project(
            tmp_path / str(gain_db), gain_db, gated=gated, tracks=_peer_tracks(gated=gated)
        )
        proposal = _proposal(project, "mute", "medium")
        hints = [row for row in _rows(proposal) if row[1] == "filler:acoustic"]
        assert proposal.skip_counts.get("acoustic:peer_speaking") == 1, gain_db
        assert len(hints) == 1, gain_db
        assert hints[0][2] == pytest.approx(4.4, abs=0.1 + FRAME_SEC), gain_db
