"""Every detector decides the same at any recording level (#1443).

Detection levels are offsets from each track's own ``LevelProfile``, so a recording made
quieter, as a whole or one track alone, must get the decisions of the unscaled one. This
is the one contract for that invariant: each detector entry point runs one scene at 0 dB,
at -12 and -24 dB on every track, and with one track alone at -24 dB, and must give the
literal outcome pinned for 0 dB.
"""

from __future__ import annotations

import wave
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

from bleed_helpers import DURATION_SEC, delay, spurts, voices
from bleed_helpers import RATE as BLEED_RATE
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.silence_islands import suggest_handoff_cut
from podcast_mcp.edits.speech_energy_guard import _voice_refs, measure_peer_speech
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.word_spans import WordSpanCaps, trim_implausible_words
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import SpeechLevels, refresh_silence_flags
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCache,
    compute_word_audibility_map,
    list_low_audibility_words,
)
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.engines.bleed_gate import build_bleed_gate_plan
from podcast_mcp.engines.speaker_split import attribute_speakers
from podcast_mcp.engines.transcript_reconcile import reconcile_transcript
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.pipeline.config import suggest_pipeline_tuning
from podcast_mcp.util.wav import open_wav
from test_bleed_gate_generality import _episode as _bleed_episode
from test_speaker_split import SpectralBackend, _mix

RATE = 16_000
SECONDS = 20
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
    audio[lo:hi] += _tone(hi - lo, 0.0) * 10 ** (np.linspace(from_db, to_db, hi - lo) / 20)


def _fricative(audio: np.ndarray, start: float, end: float, from_db: float, to_db: float) -> None:
    lo, hi = round(start * RATE), round(end * RATE)
    shape = 10 ** (np.linspace(from_db, to_db, hi - lo) / 20)
    audio[lo:hi] += np.random.default_rng(5).standard_normal(hi - lo) * shape


def _room(seed: int, *, gated: bool) -> np.ndarray:
    if gated:
        return np.zeros(SECONDS * RATE)
    return np.random.default_rng(seed).normal(0, 10 ** (ROOM_DB / 20), SECONDS * RATE)


def _tighten_scene(tmp_path: Path, *, gated: bool) -> EpisodeProject:
    """A host with a decaying word, a filler before a soft fricative, a filler running into
    the next word, a filler too quiet to hear, a murmur in a long pause; a guest after."""
    host = _room(11, gated=gated)
    _voice(host, 1.0, 1.3)
    _decay(host, 1.3, 1.62, SPEECH_DB, SPEECH_DB - 40.0)
    _voice(host, 3.0, 3.35, SPEECH_DB - 3.0)
    _fricative(host, 3.5, 3.62, ROOM_DB - 4.0, SPEECH_DB - 30.0)
    _voice(host, 3.62, 4.1)
    _voice(host, 6.0, 6.3, SPEECH_DB - 2.0)
    _voice(host, 6.3, 6.8)
    _voice(host, 9.0, 9.3, SPEECH_DB - 31.0)
    _voice(host, 9.9, 10.4)
    _voice(host, 11.0, 11.4)
    _voice(host, 12.2, 12.5, SPEECH_DB - 22.0)
    _voice(host, 15.0, 15.4)
    host_words = [
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
    guest = _room(23, gated=gated)
    _voice(guest, 16.2, 17.0)
    _voice(guest, 17.2, 18.0)
    guest_words = [("okay", 16.2, 17.0), ("sure", 17.2, 18.0)]
    return _project(tmp_path, {"host": (host, host_words), "guest": (guest, guest_words)})


def _project(
    tmp_path: Path, tracks: dict[str, tuple[np.ndarray, list[tuple[str, float, float]]]]
) -> EpisodeProject:
    project = EpisodeProject.create("gain", str(tmp_path))
    for track_id, (audio, words) in tracks.items():
        _write(tmp_path / "raw" / f"{track_id}.wav", audio, RATE)
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=audio.size / RATE),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c_{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=audio.size / RATE,
                timeline_start=0.0,
            )
        )
        project.transcripts.append(
            Transcript(
                track_id=track_id,
                words=[TranscriptWord(text=t, start=s, end=e) for t, s, e in words],
            )
        )
    return project


def _peer_in_pause_scene(tmp_path: Path) -> EpisodeProject:
    """The host murmurs in two long pauses; the guest voices over the first only."""
    host = _room(11, gated=False)
    host_words = [("so", 1.0, 1.3), ("end", 3.0, 3.3), ("okay", 6.0, 6.3)]
    for _, start, end in host_words:
        _voice(host, start, end)
    _voice(host, 1.8, 2.1, SPEECH_DB - 22.0)
    _voice(host, 4.4, 4.7, SPEECH_DB - 22.0)
    guest = _room(23, gated=False)
    _voice(guest, 1.7, 2.2)
    return _project(tmp_path, {"host": (host, host_words), "guest": (guest, [("right", 1.7, 2.2)])})


def _handoff_scene(tmp_path: Path) -> EpisodeProject:
    """Both talk either side of a long gap; the host's um and the guest's murmur sit in it.
    The guest is a sparse speaker (a second of speech), recorded 20 dB under the host."""
    host = _room(11, gated=False)
    _voice(host, 1.0, 2.0)
    _voice(host, 6.0, 6.35, SPEECH_DB - 22.0)
    _voice(host, 12.0, 13.0)
    guest = _room(23, gated=False)
    _voice(guest, 8.0, 8.4, SPEECH_DB - 22.0)
    _voice(guest, 15.0, 16.0)
    return _project(tmp_path, {"host": (host, []), "guest": (guest * 0.1, [])})


def _open_mic_scene(tmp_path: Path) -> EpisodeProject:
    """The host speaks around a pause. The guest, 20 dB under the host, holds an open mic
    at -50 dBFS and speaks for one second in the pause (a sparse speaker)."""
    host = _room(11, gated=False)
    _voice(host, 1.0, 5.5, SPEECH_DB + 4.0)
    _voice(host, 9.5, 14.0, SPEECH_DB + 4.0)
    guest = np.random.default_rng(23).normal(0, 10 ** (-50.0 / 20), SECONDS * RATE)
    _voice(guest, 6.5, 7.5)
    return _project(tmp_path, {"host": (host, []), "guest": (guest * 0.1, [])})


def _bleed_scene(tmp_path: Path) -> EpisodeProject:
    """The host's mic carries the guest's coloured copy 16 dB down, and the guest's own track
    runs 140 ms late (#945). A low-scoring word sits on the host's silence before the talk.
    Recorded 12 dB under the generality scene, as a quiet call is."""
    project = _scaled(_bleed_episode(tmp_path), {"host": -12.0, "guest": -12.0})
    host = project.transcript_for_track("host")
    assert host is not None
    for word in host.words:
        word.alignment_score = 0.001 if word.text.startswith("w") else 0.9
    host.words.append(TranscriptWord(text="ghost", start=0.75, end=0.95, alignment_score=0.001))
    host.words.sort(key=lambda word: word.start)
    return project


def _same_room_scene(tmp_path: Path) -> EpisodeProject:
    """Two speakers in one room (#774): the host's mic carries the guest's copy 20 dB down
    and 3 ms late, so the host's transcript holds the guest's words as well as its own."""
    dry = voices(7)
    room = np.random.default_rng(11).standard_normal((2, dry["caleb"].size))
    tracks = {
        "host": dry["caleb"] + 0.1 * delay(dry["audra"], 0.003) + 1e-3 * room[0],
        "guest": dry["audra"] + 1e-4 * room[1],
    }
    words = {
        "host": spurts(dry["caleb"], gap_sec=0.02) + spurts(dry["audra"], gap_sec=0.02),
        "guest": spurts(dry["audra"], gap_sec=0.02),
    }
    project = EpisodeProject.create("same room", str(tmp_path))
    for track_id, samples in tracks.items():
        _write(tmp_path / "raw" / f"{track_id}.wav", 0.25 * samples, BLEED_RATE)
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=DURATION_SEC),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c_{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=DURATION_SEC,
                timeline_start=0.0,
            )
        )
        spans = sorted(words[track_id])
        project.transcripts.append(
            Transcript(
                track_id=track_id,
                words=[
                    TranscriptWord(text=f"{track_id}{n}", start=a / BLEED_RATE, end=b / BLEED_RATE)
                    for n, (a, b) in enumerate(spans)
                ],
            )
        )
    return project


def _write(path: Path, samples: np.ndarray, rate: int) -> None:
    """24-bit PCM, so a quiet recording's quantization noise is not part of what is measured."""
    path.parent.mkdir(parents=True, exist_ok=True)
    assert np.max(np.abs(samples)) < 1.0
    ints = np.rint(samples * 8388607).astype("<i4")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(3)
        handle.setframerate(rate)
        handle.writeframes(ints.view(np.uint8).reshape(-1, 4)[:, :3].tobytes())


def _write_pcm_s16le(path: Path, samples: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    assert np.max(np.abs(samples)) < 1.0
    ints = np.rint(samples * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(ints.tobytes())


def _read(path: Path) -> tuple[np.ndarray, int]:
    with open_wav(path) as source:
        width, rate = source.getsampwidth(), source.getframerate()
        raw = np.frombuffer(source.readframes(source.getnframes()), dtype=np.uint8)
    if width == 2:
        return raw.view("<i2") / 32768.0, rate
    padded = np.zeros((raw.size // 3, 4), dtype=np.uint8)
    padded[:, 1:] = raw.reshape(-1, 3)
    return padded.view("<i4").reshape(-1) / 2147483648.0, rate


def _scaled(project: EpisodeProject, gains: dict[str, float]) -> EpisodeProject:
    """Rewrite each track's recording ``gains[track]`` dB quieter, as 24-bit PCM."""
    for track in project.timeline.tracks:
        assert track.media is not None
        path = project.workspace_path() / track.media.path
        samples, rate = _read(path)
        _write(path, samples * 10 ** (gains.get(track.id, 0.0) / 20), rate)
    return project


def _scaled_s16(project: EpisodeProject, gains: dict[str, float]) -> EpisodeProject:
    for track in project.timeline.tracks:
        assert track.media is not None
        path = project.workspace_path() / track.media.path
        samples, rate = _read(path)
        _write_pcm_s16le(path, samples * 10 ** (gains.get(track.id, 0.0) / 20), rate)
    return project


def _tighten_defaults(edit_mode: str) -> dict:
    return {
        "tighten": {"edit_mode": edit_mode, "filler_words": ["um", "uh"], "discourse_markers": []}
    }


def _tighten(edit_mode: str) -> Callable[[EpisodeProject], list]:
    def outcome(project: EpisodeProject) -> list:
        proposal = propose_tighten_edits(project, _tighten_defaults(edit_mode), intensity="medium")
        return sorted(
            (d.track_id, d.reason, d.start, d.end, d.review_required) for d in proposal.decisions
        )

    return outcome


def _peer_hint(project: EpisodeProject) -> tuple:
    """The acoustic hints tighten proposes, and how many a speaking peer blocked."""
    proposal = propose_tighten_edits(project, _tighten_defaults("mute"), intensity="medium")
    hints = [round(d.start, 1) for d in proposal.decisions if d.reason == "filler:acoustic"]
    return proposal.skip_counts.get("acoustic:peer_speaking"), hints


def _handoff(project: EpisodeProject) -> tuple:
    out = suggest_handoff_cut(project, ["host", "guest"], 2.0, 12.0, defaults=load_defaults())
    islands = [edge for i in out["islands"] for edge in (i["start"], i["end"])]
    return (
        out["ok"],
        sorted(out["warnings"]),
        round(out["cut_start"], 1),
        round(out["cut_end"], 1),
        len(islands),
    )


def _guard_fallback(project: EpisodeProject) -> tuple[str, ...]:
    """Who speaks in the host's pause, with the frame evidence withheld so the span's mean
    decides (the speech-energy guard's fallback)."""
    defaults = {
        "tighten": {"speech_energy_guard": {"enabled": True, "on_conflict": "review"}},
        "analysis": {"heuristics": {}},
    }
    with patch("podcast_mcp.edits.speech_energy_guard.timeline_frame_levels_db", return_value=None):
        levels = measure_peer_speech(
            project,
            [(6.0, 9.0)],
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=defaults,
            caches=None,
        )
    assert levels is not None and levels.unread == {}
    return levels.speaking


def _reconcile(project: EpisodeProject) -> dict:
    """How many words of each track get each verdict."""
    rows = compute_word_audibility_map(project, policy=AnalysisPolicy(), defaults=load_defaults())
    return dict(Counter((r["track_id"], r["audibility_status"]) for r in rows))


def _gate(project: EpisodeProject) -> tuple:
    plan = build_bleed_gate_plan(project, "host", defaults=load_defaults())
    return plan.attenuation_spans, plan.reduction, plan.reasons


def _analyze(project: EpisodeProject) -> list:
    result = suggest_pipeline_tuning(project)
    return sorted((r["code"], r.get("track_id")) for r in result["reasons"])


def _silence_filter(project: EpisodeProject) -> list:
    host = project.transcript_for_track("host")
    assert host is not None
    options = AsrOptions()
    refresh_silence_flags(
        host.words,
        project.workspace_path() / "raw" / "host.wav",
        options,
        evidence=SpeechLevels.for_project(project, options, bleed_check=True),
        track_id="host",
    )
    return [word.text for word in host.words if word.suspect_hallucination]


def _speaker_split(samples: np.ndarray) -> list:
    attribution = attribute_speakers(samples, speaker_count=2, backend=SpectralBackend())
    return [(turn.start, turn.end, turn.speakers) for turn in attribution.turns]


LOUD_DB = -18.0
LEVEL_NAMES = ("alpha", "soft", "faint", "bleed", "long", "end")


def _two_mics_scene(tmp_path: Path) -> EpisodeProject:
    """Loud words that set the speech level, a soft but audible one, a faint one on the room
    tone, a host word the guest's copy explains, and a guest who speaks only three times."""
    host = _room(11, gated=False)
    spans = [
        ("alpha", 1.0, 1.6, LOUD_DB),
        ("soft", 2.0, 2.5, LOUD_DB - 15.0),
        ("faint", 3.0, 3.5, LOUD_DB - 36.0),
        ("bleed", 5.0, 5.6, LOUD_DB - 12.0),
        ("long", 8.0, 10.0, LOUD_DB),
        ("end", 12.0, 13.0, LOUD_DB),
    ]
    for _, start, end, level in spans:
        _voice(host, start, end, level)
    guest = _room(23, gated=False)
    guest_spans = [("bravo", 5.0, 5.6), ("charlie", 14.0, 15.0), ("delta", 16.0, 17.0)]
    for _, start, end in guest_spans:
        _voice(guest, start, end, LOUD_DB)
    return _project(
        tmp_path,
        {
            "host": (host, [(t, s, e) for t, s, e, _ in spans]),
            "guest": (guest, guest_spans),
        },
    )


def _guest_reaches_host() -> Any:
    path = EchoPairProfile(
        source_track_id="guest",
        bleed_track_id="host",
        span_start=0.0,
        span_end=float(SECONDS),
        dominated_frames=100,
        copy_frames=40,
        consistent_frames=30,
        lag_ms=3.0,
        level_db=-18.0,
        examples=(1.0,),
        null_runs=8,
        null_copy_rate=0.05,
        null_consistent_rate=0.02,
    )
    return patch(
        "podcast_mcp.engines.audio_audit.TrackRmsCacheSet.echo_pairs", new=lambda self: [path]
    )


def _audibility(project: EpisodeProject) -> list:
    with _guest_reaches_host():
        rows = compute_word_audibility_map(
            project, policy=AnalysisPolicy(), defaults=load_defaults()
        )
    return [(r["track_id"], r["text"], r["audibility_status"]) for r in rows]


def _reconciled(project: EpisodeProject) -> list:
    with _guest_reaches_host():
        reconcile_transcript(
            project,
            policy=AnalysisPolicy(),
            dry_run=False,
            update_status=True,
            defaults=load_defaults(),
        )
    host = project.transcript_for_track("host")
    assert host is not None
    return [(w.text, w.audibility_status, w.suppressed) for w in host.words]


def _low_audibility(project: EpisodeProject) -> list:
    return [
        (r["track_id"], r["text"])
        for r in list_low_audibility_words(project, defaults=load_defaults())
    ]


def _one_track_scene(kind: str) -> Callable[[Path], EpisodeProject]:
    """One track: a single word, a steady tone (no room to tell the voice from), digital
    silence, or a sparse speaker (``sparse:<share>:<room dB>``: that share of two minutes in
    0.6 s bursts) with two words on room tone."""

    def scene(tmp_path: Path) -> EpisodeProject:
        if kind == "single-word":
            audio = _room(5, gated=False)[: SECONDS * RATE // 20]
            _voice(audio, 0.2, 0.6, LOUD_DB)
            words = [("hi", 0.2, 0.6)]
        elif kind == "no-contrast":
            audio = _tone(2 * RATE, LOUD_DB)
            words = [("hi", 0.5, 1.5)]
        elif kind == "no-live-audio":
            audio = np.zeros(2 * RATE)
            words = [("hi", 0.5, 1.0)]
        else:
            _, share, room_db = kind.split(":")
            audio = np.random.default_rng(7).normal(0, 10 ** (float(room_db) / 20), 120 * RATE)
            count = max(1, round((float(share) * 120 - 0.3) / 0.6))
            starts = np.linspace(8.0, 99.0, count)
            real = [(float(start), float(start) + 0.6) for start in starts]
            for start, end in real:
                _voice(audio, start, end, LOUD_DB)
            words = [(f"real{n}", s, e) for n, (s, e) in enumerate(real)]
            words += [("ghost0", 104.0, 104.4), ("ghost1", 116.0, 116.4)]
        return _project(tmp_path, {"solo": (audio, words)})

    return scene


def _sparse_expected(share: float) -> list:
    count = max(1, round((share * 120 - 0.3) / 0.6))
    return [(f"real{n}", "audible") for n in range(count)] + [
        ("ghost0", "inaudible"),
        ("ghost1", "inaudible"),
    ]


def _solo_audibility(project: EpisodeProject) -> list:
    rows = compute_word_audibility_map(project, policy=AnalysisPolicy(), defaults=load_defaults())
    return [(r["text"], r["audibility_status"]) for r in rows]


def _stretched_token_scene(tmp_path: Path) -> EpisodeProject:
    """A filler token whose span runs far past its 0.3 s of voice, in a long quiet track."""
    audio = _room(3, gated=False)
    _voice(audio, 1.0, 1.3, LOUD_DB)
    _voice(audio, 6.0, 8.0, LOUD_DB)
    words = [("uh", 0.5, 5.0), ("so", 6.0, 8.0)]
    return _project(tmp_path, {"solo": (audio, words)})


def _trimmed_token(project: EpisodeProject) -> tuple:
    cache = TrackRmsCache.from_timeline_stem(
        project.workspace_path() / "raw" / "solo.wav", sample_rate=RATE
    )
    words = [TranscriptWord(text="uh", start=0.5, end=5.0)]
    caps = WordSpanCaps.from_defaults({"tighten": {"filler_words": ["uh"]}})
    trim_implausible_words(words, cache, caps)
    return round(words[0].start, 1), round(words[0].end, 1)


def _asr_scene(
    *,
    gated: bool,
    seconds: float,
    speech: list[tuple[float, float]],
    soft: list[tuple[float, float]] = (),
) -> Callable:
    def scene(tmp_path: Path) -> EpisodeProject:
        audio = (
            np.zeros(round(seconds * RATE))
            if gated
            else np.random.default_rng(7).normal(0, 10 ** (ROOM_DB / 20), round(seconds * RATE))
        )
        for start, end in speech:
            _voice(audio, start, end, SPEECH_DB)
        for start, end in soft:
            _voice(audio, start, end, SPEECH_DB - 14.0)
        return _project(tmp_path, {"solo": (audio, [])})

    return scene


_SPOKEN = [(1.0, 1.7), (3.0, 3.6), (5.0, 5.8), (8.0, 9.0), (11.0, 11.5), (13.0, 14.0)]
_INVENTED = [(2.0, 2.6), (6.5, 7.2), (10.0, 10.6), (15.0, 15.8)]
_SPARSE_SPEECH = [(10.0, 10.8), (31.0, 31.6), (52.0, 52.9)]
_SPARSE_INVENTED = [(20.0, 20.7), (41.0, 41.8)]


def _asr_flags(spans: list[tuple[float, float]]) -> Callable[[EpisodeProject], list]:
    def flags(project: EpisodeProject) -> list:
        words = [TranscriptWord(text="w", start=s, end=e) for s, e in spans]
        assert (
            refresh_silence_flags(
                words, project.workspace_path() / "raw" / "solo.wav", AsrOptions()
            )
            is not None
        )
        return [w.suspect_hallucination for w in words]

    return flags


def _asr_detector(
    *,
    gated: bool,
    seconds: float,
    speech: list[tuple[float, float]],
    invented: list[tuple[float, float]] = (),
    soft: list[tuple[float, float]] = (),
    spans: list[tuple[float, float]] | None = None,
    expected: list[bool] | None = None,
) -> Detector:
    """A track and the words the silence filter must flag in it: the ``invented`` ones, or
    ``expected`` for the given ``spans``."""
    spans = sorted(speech + list(invented) + list(soft)) if spans is None else spans
    return Detector(
        _asr_scene(gated=gated, seconds=seconds, speech=speech, soft=soft),
        _asr_flags(spans),
        _equal,
        [span in invented for span in spans] if expected is None else expected,
        alone="solo",
    )


def _same_rows(got: list, want: list) -> None:
    """Same rows; a time may move by one 10 ms frame."""
    assert [r[:2] + r[4:] for r in got] == [r[:2] + r[4:] for r in want]
    for g, w in zip(got, want, strict=True):
        assert g[2:4] == pytest.approx(w[2:4], abs=FRAME_SEC + 1e-6)


def _same_spans(got: tuple, want: tuple) -> None:
    assert got[1:] == want[1:]
    assert len(got[0]) == len(want[0])
    for g, w in zip(got[0], want[0], strict=True):
        assert g == pytest.approx(w, abs=0.02)


def _same_turns(got: list, want: list) -> None:
    assert [t[2] for t in got] == [t[2] for t in want]
    for g, w in zip(got, want, strict=True):
        assert g[:2] == pytest.approx(w[:2], abs=0.04)


def _equal(got: Any, want: Any) -> None:
    assert got == want


@dataclass(frozen=True)
class Detector:
    scene: Callable[[Path], EpisodeProject]
    outcome: Callable[[EpisodeProject], Any]
    same: Callable[[Any, Any], None]
    expected: Any
    alone: str = "host"
    # The recording levels the scene is pinned at. Louder than ``loudest_db`` its peaks pass
    # full scale. Quieter than ``quietest_db`` tighten-mute's soft filler edge moves by 26 ms
    # (-40 dB puts that filler at -86 dBFS), so it is not pinned there.
    loudest_db: float = 12.0
    quietest_db: float = -40.0


_RIPPLE_FILLERS = [
    ("host", "filler:uh:voiced_edge", 5.84, 6.295, True),
    ("host", "filler:um", 2.84, 3.47, False),
]

DETECTORS = {
    "tighten-mute": Detector(
        lambda path: _tighten_scene(path, gated=False),
        _tighten("mute"),
        _same_rows,
        [
            ("host", "filler:acoustic", 12.14, 12.565, True),
            ("host", "filler:uh:voiced_edge", 5.84, 6.295, True),
            ("host", "filler:um", 2.84, 3.47, False),
        ],
        quietest_db=-36.0,
    ),
    "tighten-ripple-gated": Detector(
        lambda path: _tighten_scene(path, gated=True),
        _tighten("ripple"),
        _same_rows,
        [
            ("host", "filler:acoustic", 12.14, 12.501, True),
            ("host", "filler:uh", 8.96, 9.5, False),
            *_RIPPLE_FILLERS,
            ("host", "pause:1.30s:solo:air_edges", 4.13, 4.85, False),
            ("host", "pause:2.20s:solo", 6.83, 8.42, False),
            ("host", "pause:3.60s:solo:air_edges", 12.53, 14.45, False),
        ],
    ),
    "tighten-peer-in-pause": Detector(_peer_in_pause_scene, _peer_hint, _equal, (1, [4.4])),
    "handoff": Detector(_handoff_scene, _handoff, _equal, (True, [], 3.0, 10.9, 6)),
    "speech-guard-fallback": Detector(_open_mic_scene, _guard_fallback, _equal, ("guest",)),
    "reconcile": Detector(
        _same_room_scene,
        _reconcile,
        _equal,
        {("host", "bleed"): 208, ("host", "audible"): 278, ("guest", "audible"): 208},
        loudest_db=6.0,
    ),
    "bleed-gate": Detector(_bleed_scene, _gate, _same_spans, (((1.03, 30.79),), "mute", ())),
    "analyze": Detector(
        _same_room_scene,
        _analyze,
        _equal,
        [("bleed", "host"), ("pre_aligned", None)],
        loudest_db=6.0,
    ),
    "asr-silence-filter": Detector(
        _bleed_scene, _silence_filter, _equal, ["ghost", *(f"w{n}" for n in range(74))]
    ),
    "audibility-verdicts": Detector(
        _two_mics_scene,
        _audibility,
        _equal,
        [
            ("host", "alpha", "audible"),
            ("host", "soft", "audible"),
            ("host", "faint", "inaudible"),
            ("host", "bleed", "bleed"),
            ("host", "long", "audible"),
            ("host", "end", "audible"),
            ("guest", "bravo", "audible"),
            ("guest", "charlie", "audible"),
            ("guest", "delta", "audible"),
        ],
    ),
    "reconciled-transcript": Detector(
        _two_mics_scene,
        _reconciled,
        _equal,
        [
            ("alpha", "audible", False),
            ("soft", "audible", False),
            ("faint", "inaudible", True),
            ("bleed", "bleed", True),
            ("long", "audible", False),
            ("end", "audible", False),
        ],
    ),
    "low-audibility-scan": Detector(_two_mics_scene, _low_audibility, _equal, [("host", "faint")]),
    "single-word-track": Detector(
        _one_track_scene("single-word"),
        _solo_audibility,
        _equal,
        [("hi", "audible")],
        alone="solo",
    ),
    "no-contrast-track": Detector(
        _one_track_scene("no-contrast"),
        _solo_audibility,
        _equal,
        [("hi", "audible")],
        alone="solo",
    ),
    "no-live-audio-track": Detector(
        _one_track_scene("no-live-audio"),
        _solo_audibility,
        _equal,
        [("hi", "inaudible")],
        alone="solo",
    ),
    "sparse-speaker-reconcile": Detector(
        _one_track_scene("sparse:0.03:-68"),
        _solo_audibility,
        _equal,
        _sparse_expected(0.03),
        alone="solo",
    ),
    "sparse-speaker-noisy-room": Detector(
        _one_track_scene("sparse:0.10:-55"),
        _solo_audibility,
        _equal,
        _sparse_expected(0.10),
        alone="solo",
    ),
    "word-span-trim": Detector(
        _stretched_token_scene, _trimmed_token, _equal, (1.0, 1.3), alone="solo"
    ),
    "asr-silence-ungated": _asr_detector(
        gated=False, seconds=17.0, speech=_SPOKEN, invented=_INVENTED
    ),
    "asr-silence-gated": _asr_detector(
        gated=True, seconds=17.0, speech=_SPOKEN, invented=_INVENTED
    ),
    "asr-silence-sparse": _asr_detector(
        gated=False, seconds=60.0, speech=_SPARSE_SPEECH, invented=_SPARSE_INVENTED
    ),
    "asr-silence-too-short-to-learn": _asr_detector(
        gated=False, seconds=1.5, speech=[(0.2, 0.6)], invented=[(1.0, 1.4)]
    ),
    "asr-silence-soft-word": _asr_detector(
        gated=False,
        seconds=17.0,
        speech=_SPOKEN,
        soft=[(15.0, 15.8)],
        spans=[(15.0, 15.8)],
        expected=[False],
    ),
    "asr-silence-no-live-audio": _asr_detector(
        gated=True,
        seconds=4.0,
        speech=[],
        spans=[(0.5, 1.0), (2.0, 2.5)],
        expected=[True, True],
    ),
    "asr-silence-no-contrast": _asr_detector(
        gated=False,
        seconds=10.0,
        speech=[],
        spans=[(1.0, 1.5), (6.0, 6.5)],
        expected=[False, False],
    ),
}

# Every track recorded this many dB louder (+) or quieter (-) than the 0 dB scene.
ALL_TRACK_GAINS = (6.0, 12.0, -12.0, -24.0, -36.0, -40.0)


def _scalings() -> dict[str, tuple[float | None, Callable[[str], dict[str, float]]]]:
    scalings: dict[str, tuple[float | None, Callable[[str], dict[str, float]]]] = {
        "0dB": (0.0, lambda alone: {})
    }
    for gain in ALL_TRACK_GAINS:
        scalings[f"all{gain:+.0f}dB"] = (
            gain,
            lambda alone, gain=gain: dict.fromkeys(("host", "guest", "solo"), gain),
        )
    scalings["one-track-24dB"] = (None, lambda alone: {alone: -24.0})
    return scalings


SCALINGS = _scalings()


def _tighten_signature(project: EpisodeProject, *, edit_mode: str = "ripple") -> tuple:
    proposal = propose_tighten_edits(project, _tighten_defaults(edit_mode), intensity="medium")
    decisions = sorted(
        (d.track_id, d.reason, round(d.start, 3), round(d.end, 3), d.review_required)
        for d in proposal.decisions
    )
    return decisions, dict(proposal.skip_counts)


@pytest.mark.parametrize(
    ("detector_name", "gain_db"),
    [
        ("tighten-ripple-gated", -12.0),
        ("tighten-ripple-gated", -24.0),
    ],
)
def test_tighten_proposals_match_when_tracks_are_requantized_to_pcm_s16le(
    tmp_path: Path, detector_name: str, gain_db: float
) -> None:
    """Gain-scaled 16-bit stems must not move tighten edges (#1401)."""
    detector = DETECTORS[detector_name]
    if gain_db < detector.quietest_db:
        pytest.skip(f"{detector_name} is not pinned at {gain_db:+.0f} dB")
    edit_mode = "ripple" if "ripple" in detector_name else "mute"
    base = detector.scene(tmp_path / "base")
    gains = dict.fromkeys(("host", "guest", "solo"), gain_db)
    scaled = _scaled_s16(detector.scene(tmp_path / "s16"), gains)
    want_decisions, want_skips = _tighten_signature(base, edit_mode=edit_mode)
    got_decisions, got_skips = _tighten_signature(scaled, edit_mode=edit_mode)
    assert got_skips == want_skips
    assert len(got_decisions) == len(want_decisions)
    for got, want in zip(got_decisions, want_decisions, strict=True):
        assert got[:2] == want[:2] and got[4] == want[4]
        assert got[2] == pytest.approx(want[2], abs=FRAME_SEC + 1e-6)
        assert got[3] == pytest.approx(want[3], abs=FRAME_SEC + 1e-6)


@pytest.mark.parametrize(
    ("detector_name", "edit_mode", "alone", "gain_db"),
    [
        ("tighten-ripple-gated", "ripple", "host", -12.0),
        ("tighten-mute", "mute", "host", -12.0),
        ("tighten-ripple-gated", "ripple", "guest", -12.0),
    ],
)
def test_tighten_proposals_match_when_one_track_is_12db_quieter(
    tmp_path: Path, detector_name: str, edit_mode: str, alone: str, gain_db: float
) -> None:
    """Proposal clocks, reasons and skip counts stay fixed when one dialogue track is scaled (#1529)."""
    detector = DETECTORS[detector_name]
    base = detector.scene(tmp_path / "base")
    scaled = _scaled(detector.scene(tmp_path / "scaled"), {alone: gain_db})
    want_decisions, want_skips = _tighten_signature(base, edit_mode=edit_mode)
    got_decisions, got_skips = _tighten_signature(scaled, edit_mode=edit_mode)
    assert got_skips == want_skips
    assert len(got_decisions) == len(want_decisions)
    for got, want in zip(got_decisions, want_decisions, strict=True):
        assert got[:2] == want[:2] and got[4] == want[4]
        assert got[2] == pytest.approx(want[2], abs=FRAME_SEC + 1e-6)
        assert got[3] == pytest.approx(want[3], abs=FRAME_SEC + 1e-6)


def test_a_quiet_contrast_mic_keeps_its_voice_reference(tmp_path: Path) -> None:
    """Do not treat a quieter dialogue recording as bleed residue (#1529)."""
    project = _tighten_scene(tmp_path, gated=False)
    refs = _voice_refs(project, ["host", "guest"], caches=None)
    assert refs["guest"] != 0.0
    assert refs["host"] != 0.0


@pytest.mark.parametrize("scaling", SCALINGS)
@pytest.mark.parametrize("name", DETECTORS)
def test_a_detector_decides_the_same_at_any_recording_level(
    tmp_path: Path, name: str, scaling: str
) -> None:
    detector = DETECTORS[name]
    gain, gains = SCALINGS[scaling]
    if gain is not None and not detector.quietest_db <= gain <= detector.loudest_db:
        pytest.skip(f"{name} is not pinned at {gain:+.0f} dB")
    project = _scaled(detector.scene(tmp_path), gains(detector.alone))
    detector.same(detector.outcome(project), detector.expected)


@pytest.mark.parametrize("gain_db", [0.0, -12.0, -24.0])
def test_speaker_split_decides_the_same_at_any_recording_level(gain_db: float) -> None:
    """One recording, so there is no track to scale alone."""
    audio, _ = _mix(2, 40.0, seed=2)
    expected = _speaker_split(audio)
    assert len(expected) > 4
    _same_turns(_speaker_split(audio * np.float32(10 ** (gain_db / 20))), expected)


def _guard_scene(tmp_path: Path, host: np.ndarray, guest: np.ndarray) -> EpisodeProject:
    return _project(tmp_path, {"host": (host, []), "guest": (guest, [])})


@pytest.mark.parametrize(("under_host_db", "expected"), [(-1.0, ("guest",)), (-12.0, ())])
def test_a_same_pitch_peer_is_told_from_the_owner_by_level(
    tmp_path: Path, under_host_db: float, expected: tuple[str, ...]
) -> None:
    """Both voices share a pitch through the pause, so only the level decides."""
    host = _room(11, gated=False)
    for start, end in ((1.0, 5.5), (6.5, 7.5), (9.5, 14.0)):
        _voice(host, start, end, SPEECH_DB + 4.0)
    guest = np.random.default_rng(23).normal(0, 10 ** (-50.0 / 20), SECONDS * RATE)
    # The guest's own voice elsewhere sets the level its pause sound is read against (#1549).
    _voice(guest, 2.0, 3.0, SPEECH_DB + 4.0)
    _voice(guest, 6.5, 7.5, SPEECH_DB + 4.0 + under_host_db)
    assert _guard_fallback(_guard_scene(tmp_path, host, guest)) == expected


@pytest.mark.parametrize(
    ("word_db", "word_sec", "burst_db", "expected"),
    [
        pytest.param(-15.0, 0.15, None, ("guest",), id="short-quiet-word-in-a-long-span"),
        pytest.param(-15.0, 0.10, None, ("guest",), id="word-of-one-syllable"),
        pytest.param(None, 0.0, -54.0, (), id="noise-under-the-reach-is-no-voice"),
    ],
)
def test_a_peer_word_is_heard_in_the_window_it_fills(
    tmp_path: Path,
    word_db: float | None,
    word_sec: float,
    burst_db: float | None,
    expected: tuple[str, ...],
) -> None:
    """The fallback reads the span's loudest 100 ms, not its mean, which a few seconds of
    silence dilute (#1419). The peer talks under a tenth of the time, so the reach clamp
    (27 dB under its loudest frames) is what keeps a second of noise above its room tone, but
    far under its voice, from reading as the voice."""
    host = _room(11, gated=False)
    for start, end in ((1.0, 5.5), (9.5, 14.0)):
        _voice(host, start, end, SPEECH_DB + 4.0)
    guest = np.random.default_rng(23).normal(0, 10 ** (ROOM_DB / 20), SECONDS * RATE)
    _voice(guest, 2.0, 3.0, SPEECH_DB + 4.0)
    if word_db is not None:
        _voice(guest, 7.0, 7.0 + word_sec, SPEECH_DB + 4.0 + word_db)
    if burst_db is not None:
        lo, hi = round(7.0 * RATE), round(8.0 * RATE)
        guest[lo:hi] += np.random.default_rng(5).normal(0, 10 ** (burst_db / 20), hi - lo)
    assert _guard_fallback(_guard_scene(tmp_path, host, guest)) == expected


@pytest.mark.parametrize(
    ("host", "guest", "expected"),
    [
        pytest.param("talk", "silent", (), id="peer-with-no-audio-never-speaks"),
        pytest.param("flat", "flat", (), id="flat-peer-as-loud-as-the-owner-is-no-voice"),
        pytest.param("silent", "flat", ("guest",), id="flat-peer-over-a-silent-owner-speaks"),
        pytest.param("talk+ghost", "flat", (), id="a-lane-with-no-file-is-skipped"),
    ],
)
def test_a_peer_with_nothing_to_read_it_against(
    tmp_path: Path, host: str, guest: str, expected: tuple[str, ...]
) -> None:
    def lane(kind: str, seed: int) -> np.ndarray:
        if kind == "silent":
            return np.zeros(SECONDS * RATE)
        if kind == "flat":
            return np.random.default_rng(seed).normal(0, 0.001, SECONDS * RATE)
        audio = _room(seed, gated=False)
        _voice(audio, 1.0, 5.5, SPEECH_DB + 4.0)
        return audio

    project = _guard_scene(tmp_path, lane(host.removesuffix("+ghost"), 3), lane(guest, 4))
    if host.endswith("+ghost"):
        # An unrelated dialogue lane whose recording is gone: the session's voice level is read
        # from the lanes that have audio.
        project.timeline.tracks.append(
            Track(
                id="ghost",
                label="ghost",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path="raw/ghost.wav", duration_sec=SECONDS),
            )
        )
    assert _guard_fallback(project) == expected


@pytest.mark.parametrize("gain_db", [0.0, -12.0, -24.0])
def test_long_delay_evidence_is_the_same_at_any_recording_level(gain_db: float) -> None:
    from test_bleed_delay_evidence import _copy, _measure, _voice

    source = _voice(11) * 10 ** (gain_db / 20)
    rows = [row for row in _measure(source, _copy(source, 150.0, 0.15)) if row.supported]
    assert len(rows) >= 10
    assert np.median([row.lag_ms for row in rows]) == pytest.approx(150.0, abs=0.5)
