"""Per-track prosody profile cache: compute once (pipeline), read many (audition context).

``engines/prosody.py`` computes; this module owns the cache file naming (mirrors the
ASR transcript cache: ``transcripts/prosody/{track_id}_{audio16}_{inputs16}.json``),
audio-identity reuse (``edits.transcript_reuse.audio_identity``), and the
timeline-mapped window handed to ``audition_context`` (see #196).

The reader (:func:`load_track_profile`) never hashes audio: it lists this track's
cache files (one after the writer prunes), picks the newest, and compares its stored
``audio_size``/``audio_mtime_ns`` against ``stat()`` plus a words fingerprint, and,
when the caller passes its staged ``prosody.*`` params, compares the stored ``params``
with them (``params=None``, i.e. nothing staged, trusts the stored params). The
writer (:func:`run_prosody_analysis`) is the only thing that hashes audio or reruns
Praat, and refreshes those stat fields on a reuse (e.g. a touch with no content
change).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.edits.transcript_reuse import audio_identity
from podcast_mcp.engines.prosody import (
    ProsodyParams,
    WordSpan,
    analyze_prosody_file,
    parselmouth_version,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.transcribe import TranscribeJob, cache_id_part, track_transcribe_job
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.file_locks import shared_file_lock
from podcast_mcp.util.intervals import HalfOpenIntervalIndex
from podcast_mcp.util.progress import raise_if_cancel_requested, resolve_progress_task
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.tracks import dialogue_track_ids
from podcast_mcp.util.workspace_paths import resolve_cache_file

log = logging.getLogger(__name__)

PROFILE_SCHEMA = "prosody_profile.v1"
ALGORITHM_VERSION = 4  # 4: per-segment windowed Praat over a streamed decode (#727)
MAX_WINDOW_SEGMENTS = 6
# Waiters time out only behind a track tens of hours long at ~0.31s/audio-min (docs/pipeline.md).
PROSODY_LOCK_TIMEOUT_SEC = 600.0
# ``_{audio16}_{inputs16}.json`` after the track's cache id, so ``host`` never matches ``host_b``.
_PROFILE_SUFFIX_RE = re.compile(r"_[0-9a-f]{16}_[0-9a-f]{16}\.json")


def prosody_dir(project: EpisodeProject) -> Path:
    return project.transcripts_dir() / "prosody"


def profile_words(project: EpisodeProject, track_id: str) -> list[WordSpan]:
    """Word timings for ``track_id``: not suppressed, not a suspected hallucination."""
    tr = project.transcript_for_source(track_id, None)
    if tr is None:
        return []
    return [
        WordSpan(w.text, w.start, w.end)
        for w in tr.words
        if not w.suppressed and not w.suspect_hallucination
    ]


def words_fingerprint(words: list[WordSpan]) -> str:
    """A short hash of word text+timing, stable regardless of list order."""
    rows = sorted((round(w.start, 3), round(w.end, 3), w.text) for w in words)
    payload = json.dumps(rows, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def inputs_key(params: ProsodyParams, words_fp: str) -> str:
    payload = json.dumps(
        {
            "algo_version": ALGORITHM_VERSION,
            "params": params.key(),
            "parselmouth": parselmouth_version(),
            "words": words_fp,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def profile_path(project: EpisodeProject, track_id: str, audio16: str, inputs16: str) -> Path:
    name = f"{cache_id_part(track_id)}_{audio16}_{inputs16}.json"
    return resolve_cache_file(prosody_dir(project), name, kind="prosody", cache_id=track_id)


def _lock_path(project: EpisodeProject, track_id: str) -> Path:
    return resolve_cache_file(
        prosody_dir(project), f"{cache_id_part(track_id)}.lock", kind="prosody", cache_id=track_id
    )


@dataclass
class ProsodyProfile:
    """One track's cached prosody profile. No absolute paths are stored in it."""

    track_id: str
    schema: str = PROFILE_SCHEMA
    audio_sha256: str | None = None
    audio_size: int | None = None
    audio_mtime_ns: int | None = None
    words_fingerprint: str = ""
    algorithm_version: int = 0
    params: dict[str, Any] = field(default_factory=dict)
    engine: dict[str, Any] = field(default_factory=dict)
    segments: list[dict[str, Any]] = field(default_factory=list)
    computed_at: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "track_id": self.track_id,
            "audio_sha256": self.audio_sha256,
            "audio_size": self.audio_size,
            "audio_mtime_ns": self.audio_mtime_ns,
            "words_fingerprint": self.words_fingerprint,
            "algorithm_version": self.algorithm_version,
            "params": self.params,
            "engine": self.engine,
            "segments": self.segments,
            "computed_at": self.computed_at,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ProsodyProfile:
        return cls(
            track_id=str(data.get("track_id", "")),
            schema=str(data.get("schema", PROFILE_SCHEMA)),
            audio_sha256=data.get("audio_sha256"),
            audio_size=data.get("audio_size"),
            audio_mtime_ns=data.get("audio_mtime_ns"),
            words_fingerprint=str(data.get("words_fingerprint", "")),
            algorithm_version=int(data.get("algorithm_version") or 0),
            params=dict(data.get("params") or {}),
            engine=dict(data.get("engine") or {}),
            segments=list(data.get("segments") or []),
            computed_at=float(data.get("computed_at") or 0.0),
        )


@dataclass
class ProsodyRunResult:
    computed: list[str] = field(default_factory=list)
    reused: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    compute_sec: float = 0.0
    unavailable: bool = False

    def summary(self) -> str:
        if self.unavailable:
            return (
                "skipped (praat-parselmouth not installed; "
                "install the 'prosody' extra to compute prosody profiles)"
            )
        parts = [f"{len(self.computed)} computed", f"{len(self.reused)} reused"]
        if self.skipped:
            parts.append(f"{len(self.skipped)} skipped")
        parts.append(f"{self.compute_sec:.1f}s")
        return ", ".join(parts)


def _track_profile_paths(project: EpisodeProject, track_id: str) -> list[Path]:
    """This track's cache files only (exact ``{id}_{audio16}_{inputs16}.json`` names)."""
    stem = cache_id_part(track_id)
    directory = prosody_dir(project)
    if not directory.is_dir():
        return []
    return [
        p
        for p in directory.glob(f"{stem}_*.json")
        if _PROFILE_SUFFIX_RE.fullmatch(p.name[len(stem) :])
    ]


def _existing_profile(project: EpisodeProject, track_id: str) -> ProsodyProfile | None:
    stamped: list[tuple[int, Path]] = []
    for path in _track_profile_paths(project, track_id):
        try:
            stamped.append((path.stat().st_mtime_ns, path))
        except OSError:  # removed between listing and stat (a concurrent prune)
            continue
    for _mtime, path in sorted(stamped, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or data.get("schema") != PROFILE_SCHEMA:
            continue
        return ProsodyProfile.from_json(data)
    return None


def _prune_superseded(project: EpisodeProject, track_id: str, keep: Path) -> None:
    """Delete this track's other cache files once ``keep`` is written."""
    for path in _track_profile_paths(project, track_id):
        if path.name != keep.name:
            with contextlib.suppress(OSError):
                path.unlink()


def _engine_matches(profile: ProsodyProfile) -> bool:
    """The profile came from this algorithm and, when installed, this parselmouth."""
    if profile.algorithm_version != ALGORITHM_VERSION:
        return False
    installed = parselmouth_version()
    return installed is None or profile.engine.get("version") == installed


def _analyze_track(
    project: EpisodeProject,
    track_id: str,
    job: TranscribeJob,
    params: ProsodyParams,
    cancel_check: Callable[[], bool] | None = None,
) -> Literal["computed", "reused"]:
    """Compute or reuse one track's profile under a per-track lock, then prune."""
    lock_path = _lock_path(project, track_id)
    with shared_file_lock(lock_path, timeout=PROSODY_LOCK_TIMEOUT_SEC):
        existing = _existing_profile(project, track_id)
        sha, (size, mtime_ns) = audio_identity(job, existing)
        words = profile_words(project, track_id)
        words_fp = words_fingerprint(words)
        path = profile_path(project, track_id, sha[:16], inputs_key(params, words_fp))
        outcome: Literal["computed", "reused"]
        if (
            existing is not None
            and existing.audio_sha256 == sha
            and existing.words_fingerprint == words_fp
            and existing.params == params.key()
            and _engine_matches(existing)
        ):
            existing.audio_size = size
            existing.audio_mtime_ns = mtime_ns
            write_json_atomic(path, existing.to_json())
            outcome = "reused"
        else:
            analysis = analyze_prosody_file(job.audio, words, params, cancel_check=cancel_check)
            after = job.audio.stat()
            if (after.st_size, after.st_mtime_ns) != (size, mtime_ns):
                # Rewritten after hashing (e.g. between the two no-transcript decodes):
                # the profile no longer matches the audio identity it would be cached under.
                raise RuntimeError(
                    f"{track_id}: media changed during prosody analysis; re-run the step"
                )
            profile = ProsodyProfile(
                track_id=track_id,
                audio_sha256=sha,
                audio_size=size,
                audio_mtime_ns=mtime_ns,
                words_fingerprint=words_fp,
                algorithm_version=ALGORITHM_VERSION,
                params=params.key(),
                engine=analysis["engine"],
                segments=analysis["segments"],
                computed_at=time.time(),
            )
            write_json_atomic(path, profile.to_json())
            outcome = "computed"
        _prune_superseded(project, track_id, keep=path)
        return outcome


def run_prosody_analysis(
    project: EpisodeProject,
    defaults: dict[str, Any] | None = None,
) -> ProsodyRunResult:
    """Compute (or reuse) each dialogue track's prosody profile.

    A no-op (``ProsodyRunResult(unavailable=True)``) when ``praat-parselmouth`` is
    not installed. Reads primary track media only (not per-clip sources).
    """
    defaults = defaults or {}
    params = ProsodyParams.from_defaults(defaults)
    if parselmouth_version() is None:
        return ProsodyRunResult(unavailable=True)

    cancel_check = defaults.get("_pipeline_cancel_check")
    if cancel_check is not None and not callable(cancel_check):
        cancel_check = None

    track_ids = dialogue_track_ids(project)
    result = ProsodyRunResult()
    started = time.monotonic()

    with resolve_progress_task(
        "analyze_prosody",
        "Analyzing prosody",
        total=len(track_ids) or None,
        prefer_parent=True,
    ) as task:
        for n, track_id in enumerate(track_ids, start=1):
            raise_if_cancel_requested(cancel_check, "Prosody analysis cancelled")
            task.set_phase("track", track_id)
            try:
                job: TranscribeJob = track_transcribe_job(project, track_id)
            except ValueError:
                result.skipped.append(track_id)
                task.advance(n, total=len(track_ids), message=f"{track_id}: no media")
                continue

            outcome = _analyze_track(project, track_id, job, params, cancel_check)
            (result.computed if outcome == "computed" else result.reused).append(track_id)
            message = "analyzed" if outcome == "computed" else "reused"
            task.advance(n, total=len(track_ids), message=f"{track_id}: {message}")

    result.compute_sec = time.monotonic() - started
    return result


@dataclass(frozen=True)
class ProfileLookup:
    profile: ProsodyProfile | None
    status: Literal["fresh", "stale", "missing"]
    hint: str | None = None


def load_track_profile(
    project: EpisodeProject, track_id: str, *, params: ProsodyParams | None = None
) -> ProfileLookup:
    """Read the newest cached profile for ``track_id`` without hashing audio.

    Per call: a listing of this track's cache files (normally one, since
    :func:`run_prosody_analysis` prunes superseded profiles), one JSON read, one
    ``stat`` of the media, and an O(words) fingerprint of the track's transcript,
    checked cheapest first. No Praat run and no audio decode. When ``params`` is given
    (the staged pipeline working set's ``prosody.*`` settings), it also compares the
    stored ``params`` with it. ``None`` (nothing staged) trusts the stored params,
    because the working set is process-local and an unstaged process cannot know what
    the last run used.
    """
    profile = _existing_profile(project, track_id)
    if profile is None:
        return ProfileLookup(
            None,
            "missing",
            "No prosody profile yet; run the pipeline's analyze_prosody step "
            "(podcast pipeline run --only analyze_prosody, after reconcile/precorrect) or enable "
            "prosody.enabled and re-run the pipeline.",
        )
    if not _engine_matches(profile):
        return ProfileLookup(
            profile,
            "stale",
            "Prosody algorithm or engine changed since the profile was computed; "
            "re-run analyze_prosody.",
        )
    if params is not None and profile.params != params.key():
        return ProfileLookup(
            profile,
            "stale",
            "The staged prosody.* settings differ from the ones the profile was computed "
            "with; re-run analyze_prosody.",
        )
    track = project.track_by_id(track_id)
    if track is None or not track.media:
        return ProfileLookup(profile, "stale", "Track has no media; re-run analyze_prosody.")
    try:
        from podcast_mcp.util.tracks import track_audio_path

        st = track_audio_path(project, track_id).stat()
    except (OSError, ValueError):
        return ProfileLookup(profile, "stale", "Track media is unreadable; re-run analyze_prosody.")
    if (profile.audio_size, profile.audio_mtime_ns) != (st.st_size, st.st_mtime_ns):
        return ProfileLookup(
            profile,
            "stale",
            "Track audio changed since the profile was computed; re-run analyze_prosody.",
        )
    current_words_fp = words_fingerprint(profile_words(project, track_id))
    if profile.words_fingerprint != current_words_fp:
        return ProfileLookup(
            profile,
            "stale",
            "Transcript changed since the profile was computed; re-run analyze_prosody.",
        )
    return ProfileLookup(profile, "fresh")


def _segment_line(segment: dict[str, Any]) -> str:
    f0 = segment.get("f0", {})
    rate = segment.get("rate", {})
    energy = segment.get("energy", {})
    vq = segment.get("voice_quality", {})
    parts = [
        f"F0 {f0.get('mean_hz', 0.0):.0f}Hz (±{f0.get('sd_st', 0.0):.1f}st)",
        f"rate {rate.get('speech_rate', 0.0):.1f} syll/s",
        f"energy {energy.get('trend', 'flat')} ({energy.get('drop_db', 0.0):.1f}dB)",
        f"HNR {vq.get('hnr_db', 0.0):.0f}dB",
    ]
    flags = [
        name
        for name, is_set in (
            ("jitter", vq.get("jitter_high")),
            ("shimmer", vq.get("shimmer_high")),
        )
        if is_set
    ]
    if flags:
        parts.append("high " + "/".join(flags))
    return ", ".join(parts)


def prosody_window(
    project: EpisodeProject,
    st: SessionTimeline,
    track_id: str,
    source_spans: list[tuple[SourceSec, SourceSec]],
    *,
    params: ProsodyParams | None = None,
) -> dict[str, Any]:
    """The prosody segments overlapping ``source_spans``, mapped to the timeline.

    Returns ``{"status": "missing"|"stale", "hint": ...}`` when no fresh profile is
    cached. Caps at :data:`MAX_WINDOW_SEGMENTS` segments (``truncated`` marks more).
    """
    lookup = load_track_profile(project, track_id, params=params)
    if lookup.status != "fresh" or lookup.profile is None:
        out: dict[str, Any] = {"status": lookup.status}
        if lookup.hint:
            out["hint"] = lookup.hint
        return out

    index = HalfOpenIntervalIndex.build((float(a), float(b)) for a, b in source_spans)
    overlapping = [
        seg
        for seg in lookup.profile.segments
        if index.overlaps(float(seg["start"]), float(seg["end"]))
    ]
    truncated = len(overlapping) > MAX_WINDOW_SEGMENTS
    shown = overlapping[:MAX_WINDOW_SEGMENTS]

    out_segments: list[dict[str, Any]] = []
    for seg in shown:
        tl_start = st.source_to_timeline(track_id, SourceSec(seg["start"]))
        tl_end = st.source_to_timeline(track_id, SourceSec(seg["end"]))
        prominent = []
        for w in seg.get("prominent_words", []):
            tl = st.source_to_timeline(track_id, SourceSec(w["start"]))
            if tl is None:
                continue
            prominent.append({**w, "timeline_start": float(tl)})
        boundaries = []
        for b in seg.get("boundaries", []):
            tl = st.source_to_timeline(track_id, SourceSec(b["time"]))
            if tl is None:
                continue
            boundaries.append({**b, "timeline_time": float(tl)})
        out_segments.append(
            {
                "source_start": seg["start"],
                "source_end": seg["end"],
                "timeline_start": float(tl_start) if tl_start is not None else None,
                "timeline_end": float(tl_end) if tl_end is not None else None,
                "f0": seg.get("f0"),
                "rate": seg.get("rate"),
                "pauses": seg.get("pauses"),
                "energy": seg.get("energy"),
                "voice_quality": seg.get("voice_quality"),
                "prominent_words": prominent,
                "boundaries": boundaries,
                "line": _segment_line(seg),
            }
        )

    return {
        "status": "fresh",
        "segments": out_segments,
        "truncated": truncated,
    }
