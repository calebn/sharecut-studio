from __future__ import annotations

import copy
import wave
from pathlib import Path

import numpy as np

from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace

RATE = 16000


def write_wav(path: Path, audio: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())


def room(seconds: float = 6, seed: int = 1214, db: float = -70) -> np.ndarray:
    return np.random.default_rng(seed).normal(0, 10 ** (db / 20), round(seconds * RATE))


def voice(audio: np.ndarray, start: float, end: float, db: float = -20) -> None:
    lo, hi = round(start * RATE), round(end * RATE)
    t = np.arange(hi - lo) / RATE
    wavelet = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 9))
    wavelet *= 10 ** (db / 20) / np.sqrt(np.mean(wavelet**2))
    audio[lo:hi] += wavelet


def defaults(*, acoustic: bool = False, mode: str = "room_tone") -> dict:
    return {
        "tighten": {
            "inaudible_opt": False,
            "leave_in_if_risky": False,
            "join_continuity_gate": False,
            "filler_words": [],
            "repetition_candidates": False,
            "min_retained_solo_pause_sec": 0.55,
            "min_retained_pause_sec": 0.18,
            "filler_pad_mode": mode,
            "filler_pre_pad_fade_out_ms": 5,
            "filler_post_pad_fade_in_ms": 30,
            "apply_pause_trims": True,
            "apply_filler_cuts": True,
            "acoustic_gap_filler": {"enabled": False},
            "breath_handling": {"enabled": acoustic},
            "speech_energy_guard": {"enabled": acoustic},
        },
        "performance": {"max_workers": 1},
    }


def configure(monkeypatch, cfg: dict) -> None:
    for target in (
        "podcast_mcp.edits.source_removals.load_defaults",
        "podcast_mcp.edits.decisions.load_defaults",
        "podcast_mcp.edits.filler_pacing.load_defaults",
        "podcast_mcp.services.document.edit.load_defaults",
    ):
        monkeypatch.setattr(target, lambda: copy.deepcopy(cfg))
    monkeypatch.setattr("podcast_mcp.engines.vad_silero.get_shared_vad", lambda: None)


def project(tmp_path: Path, *, topology: str = "intact", guest: str | None = None):
    result = EpisodeProject.create("public pause policy", str(tmp_path))
    audio = room()
    voice(audio, 0, 0.2)
    voice(audio, 5, 5.2)
    write_wav(tmp_path / "raw" / "host.wav", audio)
    result.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=6, sample_rate=RATE, channels=1),
        )
    ]
    placements = {
        "intact": [(0, 6, 0)],
        "split": [(0, 4.7, 0), (4.7, 6, 4.7)],
        "deleted": [(0, 2, 0), (4.7, 6, 2)],
    }[topology]
    result.clips = [
        Clip(id=f"host-{i}", track_id="host", source_start=a, source_end=b, timeline_start=t)
        for i, (a, b, t) in enumerate(placements)
    ]
    result.timeline.duration_sec = 3.3 if topology == "deleted" else 6
    result.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=0, end=0.2),
                TranscriptWord(text="after", start=5, end=5.2),
            ],
        )
    ]
    if guest is not None:
        add_guest(result, tmp_path, guest)
    return result


def add_guest(result: EpisodeProject, tmp_path: Path, kind: str) -> None:
    track = Track(
        id="guest",
        label="Guest",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="raw/guest.wav", duration_sec=6, sample_rate=RATE, channels=1),
        timeline_empty=kind == "empty",
    )
    result.tracks.append(track)
    if kind != "empty":
        result.clips.append(
            Clip(
                id="guest",
                track_id="guest",
                source_start=0,
                source_end=result.timeline.duration_sec,
                timeline_start=0,
            )
        )
    if kind == "missing":
        return
    if kind == "corrupt":
        path = tmp_path / "raw" / "guest.wav"
        path.write_bytes(b"this is not an audio container")
        return
    audio = room(seed=1215)
    if kind in {"digital", "gated"}:
        audio[:] = 0
    if kind == "gated":
        voice(audio, 5, 5.2)
    if kind == "rejected":
        audio = room(seed=1215, db=-40)
        voice(audio, 5, 5.2)
    write_wav(tmp_path / "raw" / "guest.wav", audio)


def add_bed(result: EpisodeProject, tmp_path: Path, tid: str = "host", *, seconds=0.25):
    path = f"raw/room-tone/{tid}.wav"
    write_wav(tmp_path / path, room(seconds, seed=1216, db=-62))
    result.track_by_id(tid).room_tone = MediaAsset(path=path, duration_sec=seconds)
    result.sources.append(
        SourceRecording(
            id=f"room-tone-{tid}", path=path, duration_sec=seconds, sample_rate=RATE, channels=1
        )
    )


def pause(edit_id="pause", *, start=0.2, end=2, gap=0.25, track_id="host"):
    return EditDecision(
        id=edit_id,
        track_id=track_id,
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        replace_gap_sec=gap,
        reason="pause:2.10s",
        applied=False,
        scope="session",
        boundary_mode="exact",
        review_required=False,
    )


def workspace(result: EpisodeProject):
    mark_refine_done(result, notes="Literal synthetic fixture. No owner audio acceptance.")
    return ProjectWorkspace.open(save_project(result))


def files(directory: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(directory)): p.read_bytes()
        for p in directory.rglob("*")
        if p.is_file() and p.suffix != ".lock"
    }


def primary_spans(result: EpisodeProject, tid="host"):
    return sorted(
        (c.source_start, c.source_end, c.timeline_start)
        for c in result.clips
        if c.track_id == tid and c.source_id is None
    )
