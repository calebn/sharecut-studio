from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import numpy as np

log = logging.getLogger(__name__)

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.models import EpisodeProject, TrackRole
from podcast_mcp.transcript_context import SpeakerIdConfig, TranscriptContext
from podcast_mcp.util.progress import (
    ProgressReporter,
    resolve_progress_task,
)
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids


@dataclass
class SpeakerProfile:
    speaker_id: str
    track_id: str
    embedding: list[float]
    enrollment_sec: float
    stem_hash: str
    confidence: float = 1.0
    home_track_id: str | None = None
    source_start: float | None = None
    source_end: float | None = None
    audio_source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "speaker_id": self.speaker_id,
            "track_id": self.track_id,
            "embedding": self.embedding,
            "enrollment_sec": self.enrollment_sec,
            "stem_hash": self.stem_hash,
            "confidence": self.confidence,
            "home_track_id": self.home_track_id,
            "source_start": self.source_start,
            "source_end": self.source_end,
        }
        if self.audio_source is not None:
            out["audio_source"] = self.audio_source
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SpeakerProfile:
        track_id = str(data["track_id"])
        return cls(
            speaker_id=str(data.get("speaker_id", track_id)),
            track_id=track_id,
            embedding=[float(x) for x in data["embedding"]],
            enrollment_sec=float(data.get("enrollment_sec", 0)),
            stem_hash=str(data.get("stem_hash", "")),
            confidence=float(data.get("confidence", 1.0)),
            home_track_id=(
                str(data["home_track_id"]) if data.get("home_track_id") is not None else None
            ),
            source_start=(
                float(data["source_start"]) if data.get("source_start") is not None else None
            ),
            source_end=(float(data["source_end"]) if data.get("source_end") is not None else None),
            audio_source=(
                str(data["audio_source"]) if data.get("audio_source") is not None else None
            ),
        )


@dataclass
class WindowScore:
    track_id: str
    start_sec: float
    end_sec: float
    scores: dict[str, float]
    best_track_id: str
    margin: float
    best_identity: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "track_id": self.track_id,
            "start_sec": self.start_sec,
            "end_sec": self.end_sec,
            "scores": self.scores,
            "best_track_id": self.best_track_id,
            "best_identity": self.best_identity,
            "margin": self.margin,
        }


@runtime_checkable
class SpeakerBackend(Protocol):
    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray: ...

    def name(self) -> str: ...


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-9 or nb < 1e-9:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


class MockSpeakerBackend:
    """Deterministic pseudo-embeddings from audio hash for CI."""

    def name(self) -> str:
        return "mock"

    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        if samples.size == 0:
            return np.zeros(8, dtype=np.float32)
        chunk = samples[: min(samples.size, sample_rate)]
        vec = np.array(
            [
                float(np.mean(chunk)),
                float(np.std(chunk)),
                float(np.max(np.abs(chunk))),
                float(np.sum(chunk**2)),
                float(chunk.size),
                float(np.median(chunk)),
                float(np.percentile(chunk, 25)),
                float(np.percentile(chunk, 75)),
            ],
            dtype=np.float32,
        )
        return vec


class SpeechBrainBackend:
    def __init__(self) -> None:
        self._classifier = None

    def name(self) -> str:
        return "speechbrain-ecapa"

    def _load(self):
        if self._classifier is None:
            from speechbrain.inference.speaker import EncoderClassifier

            self._classifier = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir=None,
            )
        return self._classifier

    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        import torch

        classifier = self._load()
        tensor = torch.tensor(samples, dtype=torch.float32).unsqueeze(0)
        emb = classifier.encode_batch(tensor)
        return emb.squeeze().detach().cpu().numpy().astype(np.float32)


class ResemblyzerBackend:
    def __init__(self) -> None:
        self._encoder = None

    def name(self) -> str:
        return "resemblyzer"

    def _load(self):
        if self._encoder is None:
            from resemblyzer import VoiceEncoder

            self._encoder = VoiceEncoder()
        return self._encoder

    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        encoder = self._load()
        if sample_rate != 16000:
            ratio = 16000 / sample_rate
            idx = (np.arange(int(samples.size * ratio)) / ratio).astype(int)
            idx = np.clip(idx, 0, samples.size - 1)
            samples = samples[idx]
        return encoder.embed_utterance(samples).astype(np.float32)


def resolve_speaker_backend(
    backend_name: str | None = None,
    *,
    prefer_mock: bool = False,
) -> SpeakerBackend:
    if prefer_mock:
        return MockSpeakerBackend()
    name = (backend_name or "auto").lower()
    if name == "mock":
        return MockSpeakerBackend()
    if name in ("speechbrain", "ecapa", "auto"):
        try:
            import torch  # noqa: F401
            from speechbrain.inference.speaker import EncoderClassifier  # noqa: F401

            return SpeechBrainBackend()
        except ImportError:
            pass
    if name in ("resemblyzer", "lite", "auto"):
        try:
            from resemblyzer import VoiceEncoder  # noqa: F401

            return ResemblyzerBackend()
        except ImportError:
            pass
    if name == "auto":
        return MockSpeakerBackend()
    raise ImportError(f"speaker backend unavailable: {name}")


def _stem_path_and_source(project: EpisodeProject, track_id: str) -> tuple[Path | None, str | None]:
    processed = project.artifacts_dir() / "tracks" / f"{track_id}.wav"
    if processed.is_file():
        return processed, "processed"
    track = project.track_by_id(track_id)
    if not track or not track.media:
        return None, None
    path = Path(track.media.path)
    if not path.is_absolute():
        path = project.workspace_path() / path
    if path.is_file():
        return path, "raw"
    return None, None


def _stem_path(project: EpisodeProject, track_id: str) -> Path | None:
    path, _ = _stem_path_and_source(project, track_id)
    return path


def _stem_hash(path: Path) -> str:
    import hashlib

    stat = path.stat()
    h = hashlib.sha256()
    h.update(str(stat.st_size).encode())
    h.update(str(stat.st_mtime_ns).encode())
    with path.open("rb") as f:
        data = f.read()
    if len(data) <= 256 * 1024:
        h.update(data)
    else:
        chunk = 65536
        h.update(data[:chunk])
        mid = len(data) // 2
        h.update(data[mid : mid + chunk])
        h.update(data[-chunk:])
    return h.hexdigest()[:16]


def _profile_stem_valid(project: EpisodeProject, profile: SpeakerProfile) -> bool:
    path, _ = _stem_path_and_source(project, profile.track_id)
    if path is None:
        return False
    return profile.stem_hash == _stem_hash(path)


def profile_home_track(profile: SpeakerProfile) -> str:
    return profile.home_track_id or profile.track_id


def profile_cache_path(project: EpisodeProject, identity_id: str, stem_hash: str) -> Path:
    d = project.artifacts_dir() / "speaker_profiles"
    d.mkdir(parents=True, exist_ok=True)
    safe = identity_id.replace("/", "_")
    return d / f"{safe}_{stem_hash}.json"


def resolve_expected_speaker_count(
    project: EpisodeProject, cfg: SpeakerIdConfig
) -> tuple[int | None, str]:
    if cfg.expected_speaker_count is not None and cfg.expected_speaker_count > 0:
        return cfg.expected_speaker_count, cfg.speaker_count_source or "user"
    dialogue = [t.id for t in project.tracks if t.role == TrackRole.DIALOGUE and t.media]
    if dialogue:
        return len(dialogue), "inferred"
    profiles = load_all_profiles(project)
    if profiles:
        homes = {profile_home_track(p) for p in profiles.values()}
        return len(homes), "inferred"
    labels: set[str] = set()
    for t in project.tracks:
        if t.role != TrackRole.DIALOGUE:
            continue
        if t.speaker:
            labels.add(t.speaker.strip().lower())
        elif t.label:
            labels.add(t.label.strip().lower())
    if labels:
        return len(labels), "inferred"
    return None, "unknown"


def _load_profile_files(project: EpisodeProject) -> dict[str, SpeakerProfile]:
    d = project.artifacts_dir() / "speaker_profiles"
    if not d.is_dir():
        return {}
    out: dict[str, SpeakerProfile] = {}
    for f in sorted(d.glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        prof = SpeakerProfile.from_dict(data)
        out[prof.speaker_id] = prof
    return out


def load_all_profiles(project: EpisodeProject) -> dict[str, SpeakerProfile]:
    out: dict[str, SpeakerProfile] = {}
    for sid, prof in _load_profile_files(project).items():
        if not _profile_stem_valid(project, prof):
            log.debug(
                "skipping stale speaker profile %s (stem hash mismatch)",
                prof.speaker_id,
            )
            continue
        out[sid] = prof
    return out


def load_profile(project: EpisodeProject, identity_or_track_id: str) -> SpeakerProfile | None:
    path, _ = _stem_path_and_source(project, identity_or_track_id)
    if path is not None:
        cache = profile_cache_path(project, identity_or_track_id, _stem_hash(path))
        if cache.is_file():
            prof = SpeakerProfile.from_dict(json.loads(cache.read_text(encoding="utf-8")))
            if _profile_stem_valid(project, prof):
                return prof
    for prof in _load_profile_files(project).values():
        if prof.speaker_id == identity_or_track_id:
            return prof
        if prof.track_id == identity_or_track_id:
            return prof
        if profile_home_track(prof) == identity_or_track_id:
            return prof
    return None


def list_profiles(project: EpisodeProject) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    d = project.artifacts_dir() / "speaker_profiles"
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        prof = SpeakerProfile.from_dict(data)
        out.append(
            {
                "speaker_id": prof.speaker_id,
                "track_id": prof.track_id,
                "home_track_id": profile_home_track(prof),
                "enrollment_sec": prof.enrollment_sec,
                "stem_hash": prof.stem_hash,
                "source_start": prof.source_start,
                "source_end": prof.source_end,
                "audio_source": prof.audio_source,
                "path": str(f),
            }
        )
    return out


def _save_profile(project: EpisodeProject, profile: SpeakerProfile, stem_hash: str) -> Path:
    cache = profile_cache_path(project, profile.speaker_id, stem_hash)
    cache.write_text(json.dumps(profile.to_dict(), indent=2), encoding="utf-8")
    return cache


def enroll_track(
    project: EpisodeProject,
    track_id: str,
    cfg: SpeakerIdConfig,
    backend: SpeakerBackend,
    *,
    progress: ProgressReporter | None = None,
) -> SpeakerProfile | None:
    path, audio_source = _stem_path_and_source(project, track_id)
    if path is None:
        return None
    tr = project.transcript_for_track(track_id)
    if not tr:
        return None

    windows: list[tuple[float, float]] = []
    for w in tr.words:
        if w.suppressed:
            continue
        if w.audibility_status not in (None, "audible"):
            continue
        conf = w.confidence if w.confidence is not None else 1.0
        if conf < cfg.min_enrollment_confidence:
            continue
        dur = w.end - w.start
        if dur < 0.05:
            continue
        windows.append((w.start, w.end))

    if not windows:
        return None

    total = 0.0
    embeddings: list[np.ndarray] = []
    for start, end in windows:
        if total >= cfg.min_enrollment_sec:
            break
        dur = min(end - start, cfg.min_enrollment_sec - total)
        samples = load_mono_window(
            path,
            start_sec=start,
            duration_sec=dur,
            sample_rate=cfg.sample_rate,
        )
        embeddings.append(backend.embed(samples, cfg.sample_rate))
        total += dur

    if not embeddings:
        return None

    mean_emb = np.mean(np.stack(embeddings), axis=0)
    stem = _stem_hash(path)
    profile = SpeakerProfile(
        speaker_id=track_id,
        track_id=track_id,
        embedding=mean_emb.tolist(),
        enrollment_sec=total,
        stem_hash=stem,
        confidence=min(1.0, total / cfg.min_enrollment_sec),
        home_track_id=track_id,
        audio_source=audio_source,
    )
    _save_profile(project, profile, stem)
    text = f"Enrolled {track_id} ({total:.1f}s)"
    with resolve_progress_task(
        "speaker-enroll",
        "Speaker enrollment",
        prefer_parent=True,
        progress=progress,
    ) as task:
        task.message(text)
    return profile


def enroll_segment(
    project: EpisodeProject,
    speaker_id: str,
    track_id: str,
    start_sec: float,
    end_sec: float,
    cfg: SpeakerIdConfig,
    backend: SpeakerBackend,
    *,
    home_track_id: str | None = None,
    progress: ProgressReporter | None = None,
) -> SpeakerProfile | None:
    path, audio_source = _stem_path_and_source(project, track_id)
    if path is None or end_sec <= start_sec:
        return None
    dur = end_sec - start_sec
    if dur < cfg.min_window_sec:
        return None
    samples = load_mono_window(
        path,
        start_sec=start_sec,
        duration_sec=dur,
        sample_rate=cfg.sample_rate,
    )
    emb = backend.embed(samples, cfg.sample_rate)
    stem = _stem_hash(path)
    profile = SpeakerProfile(
        speaker_id=speaker_id,
        track_id=track_id,
        embedding=emb.tolist(),
        enrollment_sec=dur,
        stem_hash=stem,
        confidence=min(1.0, dur / cfg.min_enrollment_sec),
        home_track_id=home_track_id or track_id,
        source_start=start_sec,
        source_end=end_sec,
        audio_source=audio_source,
    )
    _save_profile(project, profile, stem)
    text = f"Enrolled {speaker_id} from {track_id} [{start_sec:.2f}-{end_sec:.2f}]"
    with resolve_progress_task(
        "speaker-enroll",
        "Speaker enrollment",
        prefer_parent=True,
        progress=progress,
    ) as task:
        task.message(text)
    return profile


def _rank_scores(
    emb: np.ndarray, profiles: dict[str, SpeakerProfile]
) -> tuple[dict[str, float], str, float, str]:
    scores: dict[str, float] = {}
    for sid, prof in profiles.items():
        scores[sid] = _cosine_similarity(emb, np.array(prof.embedding, dtype=np.float32))
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    best_id, best_score = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    best_home = profile_home_track(profiles[best_id])
    return scores, best_id, best_score - second, best_home


def _decode_window_samples(
    path: Path,
    start_sec: float,
    end_sec: float,
    cfg: SpeakerIdConfig,
) -> np.ndarray:
    span = max(0.0, end_sec - start_sec)
    target_dur = max(cfg.min_window_sec, span)
    if span >= cfg.min_window_sec:
        decode_start = start_sec
        decode_dur = span
    else:
        center = (start_sec + end_sec) / 2.0
        decode_start = max(0.0, center - target_dur / 2.0)
        decode_dur = target_dur
    return load_mono_window(
        path,
        start_sec=decode_start,
        duration_sec=decode_dur,
        sample_rate=cfg.sample_rate,
    )


def score_window(
    project: EpisodeProject,
    track_id: str,
    start_sec: float,
    end_sec: float,
    cfg: SpeakerIdConfig,
    backend: SpeakerBackend,
    profiles: dict[str, SpeakerProfile] | None = None,
) -> WindowScore | None:
    path = _stem_path(project, track_id)
    if path is None:
        return None
    samples = _decode_window_samples(path, start_sec, end_sec, cfg)
    emb = backend.embed(samples, cfg.sample_rate)
    profs = profiles or load_all_profiles(project)
    if not profs:
        for tid in dialogue_track_ids(project):
            p = load_profile(project, tid)
            if p:
                profs[p.speaker_id] = p
    if not profs:
        return None

    scores, best_id, margin, best_home = _rank_scores(emb, profs)
    return WindowScore(
        track_id=track_id,
        start_sec=start_sec,
        end_sec=end_sec,
        scores=scores,
        best_track_id=best_home,
        best_identity=best_id,
        margin=margin,
    )


def classify_track_role(
    ws: WindowScore | None,
    track_id: str,
    cfg: SpeakerIdConfig,
) -> tuple[str, str | None]:
    if ws is None or ws.margin < cfg.min_margin:
        return "uncertain", None
    if ws.best_track_id == track_id:
        return "own", ws.best_identity
    return "bleed", ws.best_identity


def _classify_role(
    ws: WindowScore | None,
    track_id: str,
    cfg: SpeakerIdConfig,
) -> tuple[str, str | None]:
    return classify_track_role(ws, track_id, cfg)


def compare_window(
    project: EpisodeProject,
    start_sec: float,
    end_sec: float,
    cfg: SpeakerIdConfig,
    backend: SpeakerBackend,
    *,
    track_ids: list[str] | None = None,
) -> dict[str, Any]:
    expected, count_source = resolve_expected_speaker_count(project, cfg)
    profiles = load_all_profiles(project)
    targets = track_ids or dialogue_track_ids(project)
    tracks_out: list[dict[str, Any]] = []
    owner_track_id: str | None = None
    best_own_margin = -1.0

    for tid in targets:
        ws = score_window(
            project,
            tid,
            start_sec,
            end_sec,
            cfg,
            backend,
            profiles=profiles or None,
        )
        role, match_id = _classify_role(ws, tid, cfg)
        entry: dict[str, Any] = {
            "track_id": tid,
            "role": role,
            "match_identity": match_id,
            "margin": ws.margin if ws else 0.0,
            "scores": ws.scores if ws else {},
            "best_home_track": ws.best_track_id if ws else None,
        }
        if role == "own" and ws and ws.margin > best_own_margin:
            owner_track_id = tid
            best_own_margin = ws.margin
        elif role == "bleed" and match_id and ws:
            entry["match_home_track"] = ws.best_track_id
        tracks_out.append(entry)

    return {
        "start_sec": start_sec,
        "end_sec": end_sec,
        "expected_speaker_count": expected,
        "speaker_count_source": count_source,
        "owner_track_id": owner_track_id,
        "tracks": tracks_out,
        "profile_count": len(profiles),
    }


def label_window(
    project: EpisodeProject,
    track_id: str,
    start_sec: float,
    end_sec: float,
    cfg: SpeakerIdConfig,
    backend: SpeakerBackend,
    *,
    dry_run: bool = True,
) -> dict[str, Any]:
    ws = score_window(project, track_id, start_sec, end_sec, cfg, backend)
    if ws is None:
        return {"labeled": 0, "error": "could not score window"}
    role, _ = _classify_role(ws, track_id, cfg)
    if role == "uncertain":
        return {"labeled": 0, "role": role, "score": ws.to_dict()}

    tr = project.transcript_for_track(track_id)
    if not tr:
        return {"labeled": 0, "error": "no transcript"}

    changed = 0
    for i, w in enumerate(tr.words):
        if w.end <= start_sec or w.start >= end_sec:
            continue
        if role == "own":
            if not dry_run:
                tr.words[i] = w.model_copy(
                    update={
                        "speaker_match_track": track_id,
                        "speaker_match_score": round(
                            ws.scores.get(ws.best_identity or track_id, 0), 4
                        ),
                    }
                )
            changed += 1
        else:
            if not dry_run:
                tr.words[i] = w.model_copy(
                    update={
                        "speaker_match_track": ws.best_track_id,
                        "speaker_match_score": round(ws.scores.get(ws.best_identity or "", 0), 4),
                        "suppressed": cfg.auto_suppress or w.suppressed,
                    }
                )
            changed += 1

    if not dry_run and changed:
        from podcast_mcp.edits.transcript_sync import rebuild_combined

        rebuild_combined(project)

    return {
        "labeled": changed,
        "role": role,
        "dry_run": dry_run,
        "score": ws.to_dict(),
    }


def assess_speaker_cut_role(
    project: EpisodeProject,
    cut_track_id: str,
    src_start: float,
    src_end: float,
    cfg: SpeakerIdConfig,
    backend: SpeakerBackend | None = None,
) -> dict[str, Any] | None:
    profiles = load_all_profiles(project)
    if not profiles:
        return None
    eng = backend or resolve_speaker_backend()
    ws = score_window(project, cut_track_id, src_start, src_end, cfg, eng, profiles=profiles)
    if ws is None:
        return None
    role, match_id = _classify_role(ws, cut_track_id, cfg)
    return {
        "role": role,
        "match_identity": match_id,
        "match_home_track": ws.best_track_id if role == "bleed" else cut_track_id,
        "margin": ws.margin,
    }


def extend_intervals_with_speaker_gaps(
    project: EpisodeProject,
    track_id: str,
    intervals: list[tuple[float, float]],
    cfg: SpeakerIdConfig,
    backend: SpeakerBackend | None = None,
) -> list[tuple[float, float]]:
    if not intervals or cfg.max_speaker_gap_sec <= 0:
        return intervals
    if not load_all_profiles(project):
        return intervals

    from podcast_mcp.engines.session_timeline import SessionTimeline

    st = SessionTimeline(project)
    eng = backend or resolve_speaker_backend()
    sorted_iv = sorted(intervals)
    out: list[tuple[float, float]] = [sorted_iv[0]]

    for start, end in sorted_iv[1:]:
        prev_start, prev_end = out[-1]
        gap = start - prev_end
        if gap <= 0:
            out[-1] = (prev_start, max(prev_end, end))
            continue
        if gap > cfg.max_speaker_gap_sec:
            out.append((start, end))
            continue

        gap_src_start = st.timeline_to_source(track_id, TimelineSec(prev_end))
        gap_src_end = st.timeline_to_source(track_id, TimelineSec(start))
        if gap_src_start is None or gap_src_end is None:
            out.append((start, end))
            continue
        gs, ge = float(gap_src_start), float(gap_src_end)
        if ge <= gs:
            out.append((start, end))
            continue

        ws = score_window(project, track_id, gs, ge, cfg, eng)
        role, _ = _classify_role(ws, track_id, cfg)
        if role == "own":
            out[-1] = (prev_start, end)
        else:
            out.append((start, end))

    return out


def _bleed_windows(
    project: EpisodeProject, cfg: SpeakerIdConfig
) -> list[tuple[str, int, float, float]]:
    windows: list[tuple[str, int, float, float]] = []
    for tr in project.transcripts:
        for i, w in enumerate(tr.words):
            if w.audibility_status != "bleed":
                continue
            if w.end - w.start < cfg.min_window_sec:
                continue
            windows.append((tr.track_id, i, w.start, w.end))
    return windows


def _speech_regions(project: EpisodeProject, track_id: str) -> list[tuple[float, float]]:
    tr = project.transcript_for_track(track_id)
    if not tr or not tr.words:
        return []
    spans: list[tuple[float, float]] = []
    for w in tr.words:
        if w.suppressed:
            continue
        if w.end <= w.start:
            continue
        spans.append((w.start, w.end))
    if not spans:
        return []
    spans.sort()
    merged: list[tuple[float, float]] = [spans[0]]
    for start, end in spans[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end + 0.05:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _word_overlaps_window(
    word_start: float, word_end: float, win_start: float, win_end: float
) -> bool:
    return word_end > win_start and word_start < win_end


def label_track_home_speaker(
    project: EpisodeProject,
    cfg: SpeakerIdConfig,
    backend: SpeakerBackend,
    *,
    track_ids: list[str] | None = None,
    dry_run: bool = True,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    """Slide windows over speech regions and suppress non-home speaker spans."""
    profiles = load_all_profiles(project)
    if not profiles:
        return {"suppressed": 0, "error": "no profiles"}

    expected, count_source = resolve_expected_speaker_count(project, cfg)
    targets = track_ids or dialogue_track_ids(project)
    gate_win = cfg.gate_window_sec
    gate_hop = cfg.gate_hop_sec

    would_suppress = 0
    suppressed = 0
    tracks_out: list[dict[str, Any]] = []
    winning_identities: set[str] = set()

    with resolve_progress_task(
        "speaker-gate",
        "Home-speaker gate",
        total=max(len(targets), 1),
        prefer_parent=True,
        progress=progress,
    ) as task:
        for tid in targets:
            tr = project.transcript_for_track(tid)
            if not tr:
                task.advance(1, total=len(targets))
                continue

            bleed_hits: list[tuple[float, float, WindowScore]] = []
            for region_start, region_end in _speech_regions(project, tid):
                cursor = region_start
                while cursor < region_end:
                    win_end = min(cursor + gate_win, region_end)
                    if win_end - cursor < cfg.min_window_sec * 0.5:
                        break
                    ws = score_window(
                        project,
                        tid,
                        cursor,
                        win_end,
                        cfg,
                        backend,
                        profiles=profiles,
                    )
                    role, _ = _classify_role(ws, tid, cfg)
                    if ws and role == "own" and ws.best_identity:
                        winning_identities.add(ws.best_identity)
                    if ws and role == "bleed":
                        bleed_hits.append((cursor, win_end, ws))
                    cursor += gate_hop

            track_would = 0
            track_done = 0
            for i, w in enumerate(tr.words):
                for win_start, win_end, ws in bleed_hits:
                    if not _word_overlaps_window(w.start, w.end, win_start, win_end):
                        continue
                    track_would += 1
                    if not dry_run:
                        tr.words[i] = w.model_copy(
                            update={
                                "speaker_match_track": ws.best_track_id,
                                "speaker_match_score": round(
                                    ws.scores.get(ws.best_identity or "", 0), 4
                                ),
                                "suppressed": True,
                            }
                        )
                        track_done += 1
                    break

            would_suppress += track_would
            suppressed += track_done
            tracks_out.append(
                {
                    "track_id": tid,
                    "bleed_windows": len(bleed_hits),
                    "words_would_suppress": track_would,
                    "words_suppressed": track_done,
                }
            )
            task.advance(1, total=len(targets))

    speaker_count_warning: str | None = None
    if expected is not None and len(winning_identities) > expected:
        speaker_count_warning = (
            f"distinct winning identities ({len(winning_identities)}) "
            f"exceed expected_speaker_count ({expected})"
        )

    if not dry_run and suppressed:
        from podcast_mcp.edits.transcript_sync import rebuild_combined

        rebuild_combined(project)

    return {
        "dry_run": dry_run,
        "backend": backend.name(),
        "expected_speaker_count": expected,
        "speaker_count_source": count_source,
        "words_would_suppress": would_suppress,
        "words_suppressed": suppressed,
        "tracks": tracks_out,
        "speaker_count_warning": speaker_count_warning,
    }


def run_speaker_attribution(
    project: EpisodeProject,
    ctx: TranscriptContext,
    *,
    dry_run: bool = True,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    backend: SpeakerBackend | None = None,
) -> dict[str, Any]:
    cfg = ctx.speaker_id
    eng = backend or resolve_speaker_backend()
    expected, count_source = resolve_expected_speaker_count(project, cfg)

    dialogue_ids = [t.id for t in project.tracks if t.role == TrackRole.DIALOGUE and t.media]
    profiles: dict[str, SpeakerProfile] = load_all_profiles(project)
    windows = _bleed_windows(project, cfg)
    would_change = 0
    changed = 0
    scored: list[dict[str, Any]] = []

    with resolve_progress_task(
        "speaker-enroll",
        "Speaker enrollment",
        total=max(len(dialogue_ids), 1),
        prefer_parent=False,
        progress=progress,
    ) as task:
        for tid in dialogue_ids:
            has_profile = any(
                p.speaker_id == tid or profile_home_track(p) == tid for p in profiles.values()
            )
            if not has_profile:
                prof = enroll_track(project, tid, cfg, eng, progress=None)
                if prof:
                    profiles[prof.speaker_id] = prof
            task.advance(1, total=len(dialogue_ids))

    with resolve_progress_task(
        "speaker-attribute",
        "Speaker attribution",
        total=max(len(windows), 1),
        prefer_parent=False,
        progress=progress,
    ) as task:
        for idx, (track_id, word_idx, start, end) in enumerate(windows):
            ws = score_window(
                project,
                track_id,
                start,
                end,
                cfg,
                eng,
                profiles=profiles,
            )
            if ws is None:
                continue
            scored.append(ws.to_dict())
            role, _ = _classify_role(ws, track_id, cfg)
            if role != "bleed":
                continue
            tr = project.transcript_for_track(track_id)
            if not tr or word_idx >= len(tr.words):
                continue
            w = tr.words[word_idx]
            would_change += 1
            if not dry_run:
                tr.words[word_idx] = w.model_copy(
                    update={
                        "speaker_match_track": ws.best_track_id,
                        "speaker_match_score": round(ws.scores.get(ws.best_identity or "", 0), 4),
                        "suppressed": cfg.auto_suppress or w.suppressed,
                    }
                )
                changed += 1

            if (idx + 1) % 50 == 0:
                task.advance_to(idx + 1)

        if windows:
            task.advance_to(len(windows))
        else:
            task.advance(0)

    if not dry_run and changed:
        from podcast_mcp.edits.transcript_sync import rebuild_combined

        rebuild_combined(project)

    return {
        "ran": True,
        "skipped_reason": None,
        "backend": eng.name(),
        "profiles": list(profiles.keys()),
        "expected_speaker_count": expected,
        "speaker_count_source": count_source,
        "windows_scored": len(scored),
        "attributions_would_change": would_change,
        "attributions_changed": changed,
        "scores": scored[:50],
    }


def speaker_doctor() -> dict[str, Any]:
    priority = ("speechbrain-ecapa", "resemblyzer", "mock")
    available: list[str] = []
    for name in ("speechbrain", "resemblyzer", "mock"):
        try:
            b = resolve_speaker_backend(name)
            if b.name() not in available:
                available.append(b.name())
        except ImportError:
            pass
    recommended = next((p for p in priority if p in available), None)
    return {
        "available_backends": available,
        "recommended": recommended,
    }
