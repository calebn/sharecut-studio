from __future__ import annotations

import atexit
import contextlib
import json
import logging
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import Lock

import numpy as np

from podcast_mcp.edits.track_ids import SAFE_TRACK_ID
from podcast_mcp.models import EpisodeProject, Track
from podcast_mcp.util.binaries import resolve_ffmpeg
from podcast_mcp.util.process import run
from podcast_mcp.util.progress import progress_task
from podcast_mcp.util.timeline_zoom import (
    overview_bins_per_sec,
    overview_decode_hz,
    overview_samples_per_pixel,
)
from podcast_mcp.util.workspace_paths import resolve_under_workspace, resolve_within

log = logging.getLogger(__name__)

PEAKS_FFMPEG_TIMEOUT_SEC = 120.0

_PEAKS_POOL: ThreadPoolExecutor | None = None
_PEAKS_POOL_LOCK = Lock()
_PEAKS_JOBS: list[Future[Path | None]] = []
_PEAKS_JOBS_LOCK = Lock()
# Pending (peaks_out, audio) jobs, and the source stamp of the last failed
# attempt per peaks_out path. Both guarded by _PEAKS_JOBS_LOCK.
_PEAKS_PENDING: set[tuple[Path, Path]] = set()
_PEAKS_FAILED: dict[Path, tuple[str, int, int]] = {}


def _peaks_pool() -> ThreadPoolExecutor:
    global _PEAKS_POOL
    with _PEAKS_POOL_LOCK:
        if _PEAKS_POOL is None:
            _PEAKS_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="peaks")
        return _PEAKS_POOL


def wait_peaks_jobs() -> None:
    """Block until scheduled background peak jobs finish (tests and process exit)."""
    with _PEAKS_JOBS_LOCK:
        jobs = list(_PEAKS_JOBS)
        _PEAKS_JOBS.clear()
    for fut in jobs:
        fut.result()


def _forget_peaks_job(fut: Future[Path | None]) -> None:
    with _PEAKS_JOBS_LOCK, contextlib.suppress(ValueError):
        _PEAKS_JOBS.remove(fut)


def _shutdown_peaks_pool() -> None:
    wait_peaks_jobs()
    global _PEAKS_POOL
    with _PEAKS_POOL_LOCK:
        pool = _PEAKS_POOL
        _PEAKS_POOL = None
    if pool is not None:
        pool.shutdown(wait=False)


atexit.register(_shutdown_peaks_pool)


def _payload_bins_per_sec(payload: dict[str, object]) -> float | None:
    raw = payload.get("bins_per_sec")
    if isinstance(raw, (int, float)) and raw > 0:
        return float(raw)
    sample_rate = payload.get("sample_rate")
    spp = payload.get("samples_per_pixel")
    if (
        isinstance(sample_rate, (int, float))
        and sample_rate > 0
        and isinstance(spp, (int, float))
        and spp > 0
    ):
        return float(sample_rate) / float(spp)
    return None


def generate_peaks(
    audio_path: Path,
    output_json: Path,
    samples_per_pixel: int | None = None,
) -> Path:
    """Downsample audio to uint8 peak values for UI waveform overview."""
    decode_hz = overview_decode_hz()
    spp = samples_per_pixel if samples_per_pixel is not None else overview_samples_per_pixel()
    spp = max(1, int(spp))
    output_json.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        resolve_ffmpeg(),
        "-hide_banner",
        "-threads",
        "1",
        "-v",
        "quiet",
        "-i",
        str(audio_path),
        "-threads",
        "1",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        str(decode_hz),
        "pipe:1",
    ]
    r = run(cmd, capture_output=True, check=True, timeout=PEAKS_FFMPEG_TIMEOUT_SEC)
    data = np.frombuffer(r.stdout, dtype=np.float32)
    if len(data) == 0:
        peaks: list[int] = []
        duration_sec = 0.0
    else:
        n = max(1, len(data) // spp)
        trimmed = data[: n * spp].reshape(n, spp)
        abs_max = np.abs(trimmed).max(axis=1)
        peaks = np.clip(np.round(abs_max * 255.0), 0, 255).astype(np.uint8).tolist()
        duration_sec = len(data) / float(decode_hz)

    return _write_peaks_payload(
        audio_path,
        output_json,
        peaks=peaks,
        duration_sec=duration_sec,
        decode_hz=decode_hz,
        spp=spp,
    )


def write_silent_peaks(
    audio_path: Path,
    output_json: Path,
    duration_sec: float,
    *,
    source: Path | None = None,
) -> Path:
    """Write all-zero overview peaks for media known to be silent, without decoding.

    ``source`` overrides the recorded source path (for trees built in a staging
    directory and renamed into place); size and mtime still come from ``audio_path``.
    """
    decode_hz = overview_decode_hz()
    spp = max(1, int(overview_samples_per_pixel()))
    bins = int(duration_sec * decode_hz) // spp
    output_json.parent.mkdir(parents=True, exist_ok=True)
    return _write_peaks_payload(
        audio_path,
        output_json,
        peaks=[0] * bins,
        duration_sec=duration_sec,
        decode_hz=decode_hz,
        spp=spp,
        source=source,
    )


def _write_peaks_payload(
    audio_path: Path,
    output_json: Path,
    *,
    peaks: list[int],
    duration_sec: float,
    decode_hz: int,
    spp: int,
    source: Path | None = None,
) -> Path:
    st = audio_path.stat()
    payload = {
        "source": str(source or audio_path),
        "source_mtime_ns": st.st_mtime_ns,
        "source_size": st.st_size,
        "sample_rate": decode_hz,
        "samples_per_pixel": spp,
        "bins_per_sec": decode_hz / spp,
        "duration_sec": duration_sec,
        "encoding": "uint8",
        "peaks": peaks,
    }
    tmp = output_json.with_name(f".{output_json.name}.tmp")
    try:
        tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        tmp.replace(output_json)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return output_json


def _peaks_out_path(project: EpisodeProject, track: Track) -> Path | None:
    if not track.media:
        return None
    if not SAFE_TRACK_ID.fullmatch(track.id):
        log.debug("peaks skipped for unsafe track id %s", track.id)
        return None
    try:
        path = resolve_under_workspace(project, track.media.path)
    except ValueError:
        return None
    if not path.is_file():
        return None
    peaks_dir = (project.artifacts_dir() / "peaks").resolve()
    try:
        peaks_out = resolve_within(peaks_dir, f"{track.id}.json")
    except ValueError:
        log.debug("peaks path escaped artifacts/peaks for %s", track.id)
        return None
    return peaks_out


def _peaks_are_current(peaks_out: Path, audio_path: Path) -> bool:
    if not peaks_out.is_file() or not audio_path.is_file():
        return False
    try:
        payload = json.loads(peaks_out.read_text(encoding="utf-8"))
        st = audio_path.stat()
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict):
        return False
    stored = _payload_bins_per_sec(payload)
    if stored is None:
        return False
    if abs(stored - overview_bins_per_sec()) >= 1e-6:
        return False
    if payload.get("source") != str(audio_path):
        return False
    if payload.get("source_mtime_ns") != st.st_mtime_ns:
        return False
    return payload.get("source_size") == st.st_size


def _peaks_job_paths(project: EpisodeProject, track: Track) -> tuple[Path, Path] | None:
    """Resolve the (peaks_out, audio) key used to dedupe/track a peaks job."""
    peaks_out = _peaks_out_path(project, track)
    if peaks_out is None or track.media is None:
        return None
    try:
        audio = resolve_under_workspace(project, track.media.path)
    except ValueError:
        return None
    return peaks_out, audio


def _source_stamp(audio: Path) -> tuple[str, int, int]:
    st = audio.stat()
    return (str(audio), st.st_mtime_ns, st.st_size)


def peaks_generation_pending(project: EpisodeProject, track: Track) -> bool:
    """True while a background job for this track's peaks is queued or running."""
    paths = _peaks_job_paths(project, track)
    if paths is None:
        return False
    with _PEAKS_JOBS_LOCK:
        return paths in _PEAKS_PENDING


def ensure_track_peaks(project: EpisodeProject, track: Track) -> Path | None:
    """Best-effort write ``artifacts/peaks/{track.id}.json`` for GUI waveforms.

    Returns the peaks path on success, or ``None`` when media is missing or
    generation fails (logged at debug). Skips rewrite when bins rate, source
    path, and media mtime/size already match.
    """
    peaks_out = _peaks_out_path(project, track)
    if peaks_out is None or track.media is None:
        return None
    try:
        path = resolve_under_workspace(project, track.media.path)
    except ValueError:
        return None
    if _peaks_are_current(peaks_out, path):
        return peaks_out
    try:
        with progress_task(
            "peaks.generate",
            f"Waveform overview {track.id}",
            total=1,
        ) as prog:
            out = generate_peaks(path, peaks_out)
            prog.advance(1)
    except Exception as exc:
        log.debug("peaks generation failed for %s: %s", track.id, exc)
        with _PEAKS_JOBS_LOCK:
            _PEAKS_FAILED[peaks_out] = _source_stamp(path)
        return None
    with _PEAKS_JOBS_LOCK:
        _PEAKS_FAILED.pop(peaks_out, None)
    return out


def _run_peaks_job(project: EpisodeProject, track: Track, key: tuple[Path, Path]) -> Path | None:
    try:
        return ensure_track_peaks(project, track)
    finally:
        with _PEAKS_JOBS_LOCK:
            _PEAKS_PENDING.discard(key)


def schedule_track_peaks(project: EpisodeProject, track: Track) -> bool:
    """Queue background peak generation (one worker; does not block ingest).

    Returns ``True`` when a job is already pending or was just queued, and
    ``False`` when the track has no usable media or its source already
    failed to decode and has not changed since.
    """
    paths = _peaks_job_paths(project, track)
    if paths is None:
        return False
    peaks_out, audio = paths
    try:
        stamp = _source_stamp(audio)
    except OSError:
        return False
    with _PEAKS_JOBS_LOCK:
        if paths in _PEAKS_PENDING:
            return True
        if _PEAKS_FAILED.get(peaks_out) == stamp:
            return False
        _PEAKS_PENDING.add(paths)
    fut = _peaks_pool().submit(_run_peaks_job, project, track, paths)
    with _PEAKS_JOBS_LOCK:
        _PEAKS_JOBS.append(fut)
    fut.add_done_callback(_forget_peaks_job)
    return True
