"""Cut a room-tone bed out of a track's own original audio and describe where it came from (#1216).

A track with no recorded bed has its fills picked from its own audio on every edit
(:mod:`podcast_mcp.engines.room_tone`). This module makes one such pick durable: the longest
clean stretch of the track's source audio, written once as a WAV under
``raw/room-tone-extracted/`` and described by a :class:`~podcast_mcp.models.RoomToneOrigin`
(source range, source bytes, extractor revision, measurements) so a rerun on the same audio
finds it already there.

Only original source audio is used: the track's own media, never a processed stem, generated
padding, synthetic noise or another track. The pick is the one the pad pool trusts
(:func:`podcast_mcp.engines.room_tone._pick_sample`): inside the quiet runs, passing every row
of ``CHECKS`` and leaving every other speaker at their floor. The voice detector decides
"voiced", and without it ``voiced`` would pass silently, so no bed is cut without one.

The written file is read back with the same validation a registered bed gets
(:func:`~podcast_mcp.engines.room_tone.room_tone_bed`'s verdict); a bed that would not render
is never registered. Nothing here calls the project: :func:`plan_extracted_bed` reads and
writes files, and the caller registers the result under the project lock.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.room_tone import (
    BED_MIN_USABLE_SEC,
    CHECKS,
    SAMPLE_RATE,
    BedUsable,
    DigitalSilence,
    SampleAbsent,
    Unmeasured,
    _bed_verdict,
    _no_foreign_voice,
    _pick_sample,
    _voice_detector_missing,
    track_floor,
)
from podcast_mcp.models import EpisodeProject, RoomToneOrigin
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, rms_db
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.project_state import file_stamp
from podcast_mcp.util.tracks import track_audio_path
from podcast_mcp.util.workspace_paths import resolve_under_workspace, workspace_relpath

log = logging.getLogger(__name__)

EXTRACT_DIR = "raw/room-tone-extracted"
EXTRACTOR_REV = 2
BED_TARGET_SEC = 8.0


@dataclass(frozen=True)
class ExtractedBed:
    """A bed written to ``rel`` and the origin that goes with its registration."""

    rel: str
    path: Path
    duration_sec: float
    sample_rate: int
    channels: int
    origin: RoomToneOrigin


def extract_key(
    track_id: str, source_path: str, media_sha256: str, start: float, end: float, extractor_rev: int
) -> str:
    """Names one extraction: the same track audio, range and extractor give the same key."""
    raw = f"{track_id}|{source_path}|{media_sha256}|{start:.6f}|{end:.6f}|{extractor_rev}"
    return hashlib.sha256(raw.encode()).hexdigest()


def source_matches(project: EpisodeProject, track_id: str, origin: RoomToneOrigin) -> bool:
    """Whether the current original media still matches the planned provenance."""
    try:
        path = track_audio_path(project, track_id)
        before = file_stamp(path)
        return (
            workspace_relpath(project, path) == origin.source_path
            and (before.size, before.mtime_ns) == (origin.media_size, origin.media_mtime_ns)
            and sha256_file(path) == origin.media_sha256
            and file_stamp(path) == before
        )
    except (OSError, ValueError):
        return False


def extracted_rel(track_id: str, key: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_-]", "_", track_id)
    return f"{EXTRACT_DIR}/{name}-{key[:16]}.wav"


def plan_extracted_bed(project: EpisodeProject, track_id: str) -> ExtractedBed | SampleAbsent:
    """Pick, cut and validate a bed from ``track_id``'s own audio, or say why there is none.

    Reads the project and verifies a fresh excerpt against any existing canonical bed.
    Publishes the canonical file only when absent, and changes nothing else. The track's recorded or assigned bed is not consulted: whether
    this track may take an extracted bed is the caller's rule.
    """
    track = project.track_by_id(track_id)
    if track is None:
        return SampleAbsent("missing_track")
    if track.media is None:
        return SampleAbsent("missing_media")
    if _voice_detector_missing():
        return SampleAbsent("voice_detector_missing")
    path = track_audio_path(project, track_id)
    try:
        stamp = file_stamp(path)
        media_sha = sha256_file(path)
        if file_stamp(path) != stamp:
            return SampleAbsent("unreadable_file")
    except OSError:
        return SampleAbsent("missing_media")
    source_path = workspace_relpath(project, path)
    read = track_floor(path, content_sha256=media_sha)
    if isinstance(read, Unmeasured):
        return SampleAbsent(read.cause)
    if isinstance(read, DigitalSilence):
        return SampleAbsent("digital_silence")
    if read.gated:
        return SampleAbsent("gated_live")
    if not read.floor.runs:
        return SampleAbsent("no_quiet_run")
    longest = max(read.floor.runs, key=lambda run: run[1] - run[0])
    picked = _pick_sample(
        read.floor,
        near_sec=(longest[0] + longest[1]) / 2.0,
        duration_sec=BED_TARGET_SEC,
        min_sec=BED_MIN_USABLE_SEC,
        clear=_no_foreign_voice(project, track_id),
    )
    if isinstance(picked, SampleAbsent):
        return picked
    sample = picked.sample
    start, end = round(sample.start, 3), round(sample.end, 3)
    key = extract_key(track_id, source_path, media_sha, start, end, EXTRACTOR_REV)
    rel = extracted_rel(track_id, key)
    try:
        dest = resolve_under_workspace(project, rel)
        sha = _write_excerpt(path, dest, start, end)
        if sha is None:
            return SampleAbsent("bed_changed")
        written = _validate_written(dest)
        if isinstance(written, SampleAbsent):
            return written
        if file_stamp(path) != stamp or sha256_file(path) != media_sha:
            return SampleAbsent("unreadable_file")
        duration_sec, sample_rate, channels = written
        if sha256_file(dest) != sha:
            return SampleAbsent("bed_changed")
    except Exception:
        log.warning("room tone extraction for %s failed", track_id, exc_info=True)
        return SampleAbsent("unreadable_file")
    origin = RoomToneOrigin(
        source_id=None,
        source_path=source_path,
        media_sha256=media_sha,
        source_start=start,
        source_end=end,
        media_size=stamp.size,
        media_mtime_ns=stamp.mtime_ns,
        extractor_rev=EXTRACTOR_REV,
        file_sha256=sha,
        floor_db=round(read.floor.floor_db, 2),
        bed_rms_db=round(sample.rms_db, 2),
        speech_prob=None if sample.speech_prob is None else round(sample.speech_prob, 3),
        checks=[name for name, _check in CHECKS],
    )
    return ExtractedBed(
        rel=workspace_relpath(project, dest),
        path=dest,
        duration_sec=duration_sec,
        sample_rate=sample_rate,
        channels=channels,
        origin=origin,
    )


def _write_excerpt(source: Path, dest: Path, start: float, end: float) -> str | None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(f".{dest.stem}.{uuid.uuid4().hex[:8]}.partial.wav")
    try:
        FFmpegEngine().extract_segment(source, temp, start, end)
        sha = sha256_file(temp)
        with temp.open("r+b" if os.name == "nt" else "rb") as handle:
            os.fsync(handle.fileno())
        try:
            os.link(temp, dest)
        except FileExistsError:
            return sha if sha256_file(dest) == sha else None
        if os.name == "posix":
            with contextlib.suppress(OSError):
                descriptor = os.open(dest.parent, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        return sha
    finally:
        temp.unlink(missing_ok=True)


def _validate_written(dest: Path) -> tuple[float, int, int] | SampleAbsent:
    from podcast_mcp.util.project_state import file_revision
    from podcast_mcp.util.wav import open_wav

    try:
        with open_wav(dest) as wf:
            rate, channels, frames = wf.getframerate(), wf.getnchannels(), wf.getnframes()
    except Exception:
        return SampleAbsent("unreadable_file")
    duration = frames / rate if rate else 0.0
    audio = load_mono_window(dest, start_sec=0.0, duration_sec=duration, sample_rate=SAMPLE_RATE)
    if audio.size == 0 or not np.all(np.isfinite(audio)):
        return SampleAbsent("unreadable_file")
    if rms_db(audio, floor_db=DIGITAL_SILENCE_DB) <= DIGITAL_SILENCE_DB:
        return SampleAbsent("digital_silence")
    verdict = _bed_verdict(dest, file_revision(dest), audio)
    if not isinstance(verdict, BedUsable):
        return SampleAbsent("rejected", rejected_checks=verdict)
    return duration, rate, channels
