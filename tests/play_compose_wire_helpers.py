"""Shared fixtures, surfaces and normalizer for the PlayService audition-context wire pins."""

from __future__ import annotations

import json
import re
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.edit_log import archive_timeline_op
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.engines.play_audit import write_stem_hash
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import play as play_tools
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import PlayService
from podcast_mcp.util.tracks import stem_path

RATE = 16_000
_ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+00:00")
_IDS = re.compile(r"\b(alog_[0-9a-f]{8}|cmt_[0-9a-f]{8}|act_[0-9a-f]{8})\b")
_SHORT_IDS = re.compile(r'(?<="id": ")[0-9a-f]{12}(?=")')
_HASH = re.compile(r'(?<=")[0-9a-f]{16}(?=")')
_DIGITS = 4


def dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, _DIGITS)
    if isinstance(value, list):
        return [_round(v) for v in value]
    if isinstance(value, dict):
        return {k: _round(v) for k, v in value.items()}
    return value


def normalize(value: Any, ws: ProjectWorkspace) -> Any:
    """Workspace paths become <ws>; ids, timestamps and 16-hex hashes become tokens; floats keep 4 places."""
    text = dump(value)
    for root in {str(ws.path.parent), str(ws.path.parent.resolve())}:
        text = text.replace(root, "<ws>")
    seen: dict[str, str] = {}

    def token(match: re.Match[str], kind: str) -> str:
        return seen.setdefault(match.group(0), f"<{kind}{len(seen)}>")

    text = _ISO.sub("<ts>", text)
    text = _IDS.sub(lambda m: token(m, m.group(0).split("_")[0] + ":"), text)
    text = _SHORT_IDS.sub(lambda m: token(m, "id:"), text)
    text = _HASH.sub(lambda m: token(m, "hash:"), text)
    return _round(json.loads(text))


def voice(total: float, start: float, end: float, *, f0: float = 150.0) -> np.ndarray:
    """A vowel-like harmonic complex, periodic at ``f0``, voiced between ``start`` and ``end``."""
    samples = np.zeros(int(total * RATE), dtype=np.float32)
    n = int((end - start) * RATE)
    t = np.arange(n) / RATE
    tone = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 7))
    samples[int(start * RATE) : int(start * RATE) + n] = (0.25 * tone / 2.45).astype(np.float32)
    return samples


def speech_like(seconds: float, *, seed: int) -> np.ndarray:
    """Wideband noise with syllable-rate bursts and pauses; each seed has its own envelope."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    noise = np.convolve(rng.normal(0, 1.0, n), np.ones(2) / 2.0, mode="same")
    t = np.arange(n) / RATE
    burst_phase, gap_phase = rng.uniform(0.0, 2 * np.pi, 2)
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 4.0 * t + burst_phase)
    envelope *= (np.sin(2 * np.pi * 0.5 * t + gap_phase) > -0.3).astype(np.float64)
    out = noise * envelope
    return (0.2 * out / (np.max(np.abs(out)) or 1.0)).astype(np.float32)


def delayed_copy(source: np.ndarray, *, delay_samples: int, gain_db: float) -> np.ndarray:
    out = np.zeros_like(source)
    out[delay_samples:] = source[: source.size - delay_samples] * (10 ** (gain_db / 20.0))
    return out


def with_hum(samples: np.ndarray, start: float, end: float, *, level: float = 0.2) -> np.ndarray:
    out = samples.copy()
    a, b = int(start * RATE), int(end * RATE)
    t = np.arange(b - a) / RATE
    out[a:b] += (level * np.sin(2 * np.pi * 60.0 * t)).astype(np.float32)
    return out


def with_clipping(samples: np.ndarray, start: float, end: float) -> np.ndarray:
    out = samples.copy()
    a, b = int(start * RATE), int(end * RATE)
    out[a:b] = np.clip(out[a:b] * 40.0, -1.0, 1.0)
    return out


def write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(pcm.tobytes())


@dataclass
class TrackSpec:
    """One track: its audio, clips as (source_start, source_end, timeline_start), words and stem."""

    id: str
    samples: np.ndarray
    role: TrackRole = TrackRole.DIALOGUE
    muted: bool = False
    clips: list[tuple[float, float, float]] | None = None
    words: list[tuple[str, float, float]] | None = None
    aligner: str | None = None
    suppressed: tuple[int, ...] = ()
    stem: str = "none"
    effects: list[ProcessingEffect] = field(default_factory=list)


def _seconds(spec: TrackSpec) -> float:
    return spec.samples.size / RATE


def build_project(root: Path, specs: list[TrackSpec], *, name: str = "ep") -> EpisodeProject:
    project = EpisodeProject.create(name, str(root))
    project.ensure_dirs()
    furthest = 0.0
    for spec in specs:
        write_wav(root / "raw" / f"{spec.id}.wav", spec.samples)
        project.timeline.tracks.append(
            Track(
                id=spec.id,
                label=spec.id.title(),
                role=spec.role,
                muted=spec.muted,
                media=MediaAsset(
                    path=f"raw/{spec.id}.wav",
                    duration_sec=_seconds(spec),
                    sample_rate=RATE,
                    channels=1,
                ),
            )
        )
        for i, (src_start, src_end, tl_start) in enumerate(
            spec.clips or [(0.0, _seconds(spec), 0.0)]
        ):
            project.timeline.clips.append(
                Clip(
                    id=f"c_{spec.id}" if i == 0 else f"c_{spec.id}_{i}",
                    track_id=spec.id,
                    source_start=src_start,
                    source_end=src_end,
                    timeline_start=tl_start,
                )
            )
            furthest = max(furthest, tl_start + src_end - src_start)
        if spec.words is not None:
            project.transcripts.append(
                Transcript(
                    track_id=spec.id,
                    word_aligner=spec.aligner,
                    words=[
                        TranscriptWord(
                            text=text,
                            start=start,
                            end=end,
                            confidence=0.9,
                            suppressed=i in spec.suppressed,
                        )
                        for i, (text, start, end) in enumerate(spec.words)
                    ],
                )
            )
        if spec.effects:
            project.processing_chains.append(
                ProcessingChain(track_id=spec.id, effects=spec.effects)
            )
    project.timeline.duration_sec = furthest
    return project


def pending_cut(
    edit_id: str, track_id: str, start: float, end: float, **kwargs: Any
) -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id=track_id,
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason=kwargs.pop("reason", "nl:range"),
        applied=False,
        boundary_mode="vocal_transcript_guided",
        **kwargs,
    )


def open_workspace(
    project: EpisodeProject, specs: list[TrackSpec] | None = None, *, applied: bool = False
) -> ProjectWorkspace:
    """Save ``project``; write each spec's stem (``fresh`` also writes the matching hash)."""
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    if applied:
        archive_timeline_op(
            project,
            operation="remove_range",
            track_ids=["host"],
            timeline_start=1.0,
            timeline_end=1.5,
            source_start=1.0,
            source_end=1.5,
            reason="filler:um",
        )
    ws = ProjectWorkspace.open(save_project(project))
    defaults = ws.effective_config()
    for spec in specs or []:
        if spec.stem == "none":
            continue
        loaded = ws.project
        write_wav(stem_path(loaded, spec.id), spec.samples)
        if spec.stem == "fresh":
            write_stem_hash(loaded, spec.id, defaults=defaults)
    return ProjectWorkspace.open(ws.path)


def dialogue_pair(*, guest_offset: float = 0.0, seconds: float = 8.0) -> list[TrackSpec]:
    """Host and guest, each with captions in the first four seconds and silence-free voice."""
    host_words = [("hello", 0.5, 0.9), ("there", 1.0, 1.4), ("world", 2.5, 3.0)]
    guest_words = [("totally", 0.6, 1.1), ("different", 1.3, 1.9), ("topic", 3.2, 3.6)]
    return [
        TrackSpec(
            "host",
            voice(seconds, 0.4, seconds - 0.5, f0=140.0),
            words=host_words,
            aligner="forced",
        ),
        TrackSpec(
            "guest",
            voice(seconds, 0.4, seconds - 0.5, f0=210.0),
            clips=[(0.0, seconds, guest_offset)],
            words=guest_words,
            aligner="forced",
        ),
    ]


def run_service(ws: ProjectWorkspace, start: float, end: float, **kwargs: Any) -> Any:
    return PlayService(ws).audition_context(start, end, **kwargs)


def run_mcp(ws: ProjectWorkspace, start: float, end: float, **kwargs: Any) -> Any:
    return json.loads(
        play_tools.audition_context_tool(
            str(ws.path),
            start,
            end,
            skew_warn_sec=kwargs.get("skew_warn_sec") or 0.05,
            detail=kwargs.get("detail", "summary"),
        )
    )


def run_cli(ws: ProjectWorkspace, start: float, end: float, **kwargs: Any) -> Any:
    args = [
        "play",
        "context",
        "--project",
        str(ws.path),
        "--start",
        repr(start),
        "--end",
        repr(end),
    ]
    if kwargs.get("skew_warn_sec") is not None:
        args += ["--skew-warn-ms", repr(kwargs["skew_warn_sec"] * 1000.0)]
    if "detail" in kwargs:
        args += ["--detail", kwargs["detail"]]
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 0, result.output
    return json.loads(result.stdout)


def run_prosody_service(ws: ProjectWorkspace) -> Any:
    return PlayService(ws).prosody_overlay()


def run_prosody_web(ws: ProjectWorkspace) -> Any:
    with TestClient(create_app()) as client:
        reply = client.get("/api/project/prosody", params={"path": str(ws.path)})
    assert reply.status_code == 200, reply.text
    return reply.json()


def profile_segment(
    start: float, end: float, *, word: str | None = "hello", **overrides: Any
) -> dict[str, Any]:
    """A cached prosody segment as ``analyze_prosody`` stores it; ``overrides`` replace top-level keys."""
    segment: dict[str, Any] = {
        "start": start,
        "end": end,
        "f0": {
            "mean_hz": 180.0,
            "median_hz": 175.0,
            "sd_st": 2.0,
            "range_st": 5.0,
            "voiced_fraction": 0.7,
        },
        "rate": {"syllable_count": 4, "speech_rate": 2.0, "articulation_rate": 2.5},
        "pauses": {"count": 0, "total_sec": 0.0},
        "energy": {
            "mean_db": 60.0,
            "sd_db": 5.0,
            "slope_db_per_sec": -1.0,
            "start_third_db": 62.0,
            "mid_third_db": 60.0,
            "end_third_db": 58.0,
            "drop_db": 4.0,
            "trend": "falling",
        },
        "voice_quality": {
            "jitter_local": 0.01,
            "shimmer_local": 0.02,
            "hnr_db": 15.0,
            "jitter_high": False,
            "shimmer_high": False,
            "hnr_low": False,
        },
        "prominent_words": (
            [{"text": word, "start": start + 0.1, "end": start + 0.4, "score": 1.2}] if word else []
        ),
        "boundaries": [
            {
                "time": end,
                "strength": 1.0,
                "pause_sec": 0.0,
                "lengthening": 0.0,
                "pitch_reset": 0.0,
                "kind": "segment_end",
            }
        ],
    }
    segment.update(overrides)
    return segment


def seed_profile(
    project: EpisodeProject,
    track_id: str,
    segments: list[dict[str, Any]],
    *,
    params: dict[str, Any] | None = None,
    tag: str = "0",
    algorithm_version: int | None = None,
) -> Path:
    """Write a cached prosody profile for ``track_id`` without running Praat."""
    from podcast_mcp.edits.prosody_profile import (
        ALGORITHM_VERSION,
        ProsodyProfile,
        profile_path,
        profile_words,
        words_fingerprint,
    )
    from podcast_mcp.engines.prosody import ProsodyParams, parselmouth_version
    from podcast_mcp.util.atomic_json import write_json_atomic
    from podcast_mcp.util.tracks import track_audio_path

    stat = track_audio_path(project, track_id).stat()
    profile = ProsodyProfile(
        track_id=track_id,
        audio_sha256="deadbeef",
        audio_size=stat.st_size,
        audio_mtime_ns=stat.st_mtime_ns,
        words_fingerprint=words_fingerprint(profile_words(project, track_id)),
        algorithm_version=ALGORITHM_VERSION if algorithm_version is None else algorithm_version,
        params=params if params is not None else ProsodyParams.from_defaults({}).key(),
        engine={"backend": "parselmouth", "version": parselmouth_version() or "0.0.0"},
        segments=segments,
        computed_at=0.0,
    )
    path = profile_path(project, track_id, tag * 16, "1" * 16)
    write_json_atomic(path, profile.to_json())
    return path


def play_case(case: Any, tmp_path: Path, monkeypatch: Any, surface: str) -> Any:
    """Build ``case`` under ``tmp_path``, call one surface and return the normalized output."""
    ws = case.build(tmp_path)
    if case.setup is not None:
        case.setup(monkeypatch, ws)
    call = {"service": run_service, "mcp": run_mcp, "cli": run_cli}[surface]
    return normalize(call(ws, case.start, case.end, **case.kwargs), ws)


def prosody_case(case: Any, tmp_path: Path, monkeypatch: Any, surface: str) -> Any:
    ws = case.build(tmp_path)
    if case.setup is not None:
        case.setup(monkeypatch, ws)
    call = {"service": run_prosody_service, "web": run_prosody_web}[surface]
    return normalize(call(ws), ws)
