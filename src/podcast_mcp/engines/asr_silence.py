"""Flag ASR words that sit over digital silence (issue #521).

Whisper sometimes invents text over silent stretches. A word whose own-track
peak is below a very low floor cannot have been spoken on that track, so it is
marked ``suspect_hallucination``. Words are never deleted or retimed.

The track is streamed at its native rate and layout, so there is no resampling and
energy above 4 kHz still counts. It is reduced to a per-block peak envelope, so
memory stays small on long tracks.

Analyze (``suggest_pipeline_tuning``) reuses the same envelope to flag a dialogue
source that is mostly digital silence, a sign of a gated stem worth VAD. The
resulting fraction is cached in-process per file version.

``refresh_silence_flags`` also ORs in the forced aligner's evidence signal (#195):
an aligned word whose ``alignment_score`` is below `transcribe.forced_alignment.
min_word_score` is flagged too, but only when the audio agrees (#780): the word's own
track carries no speech over the aligned span, or another dialogue track is louder
there (``SpeechLevels``). The score alone never flags: it is a mean character posterior
over emitting frames, low by construction on one-to-four-frame words such as "um" and
"to". The other-track half reads the session placement, which ``align_tracks`` settles
after ASR, so ``transcribe_tracks`` applies the own-track half only (``bleed_check``
off) and ``reconcile_transcript`` re-flags with the full gate; the fingerprint carries
that scope and a digest of the dialogue clips' placement, so a placement change
re-flags once. It is still flag-only and never retimed.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

import numpy as np

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.models import EpisodeProject, TranscriptWord
from podcast_mcp.util.dsp import db_to_amplitude
from podcast_mcp.util.hashing import sha256_head_tail
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.project_state import FileRevision, file_revision

if TYPE_CHECKING:
    from podcast_mcp.engines.session_timeline import SessionTimeline

log = logging.getLogger(__name__)

PEAK_BLOCK_SEC = 0.01
MIN_SPAN_SEC = 0.05
# The evidence gate's level resolution: 10 ms frames at 8 kHz, about 80x smaller than samples.
LEVEL_FRAME_SEC = 0.01
LEVEL_SAMPLE_RATE = 8000
# A frame at or below this is digital silence: it never counts toward a track's noise floor.
SILENT_FRAME_DB = -80.0


def silence_filter_fingerprint(
    words: Sequence[TranscriptWord],
    audio_sha256: str,
    options: AsrOptions,
    *,
    evidence: str = "own",
) -> str:
    """Identify the media, filter policy, spans, stored flag state and evidence scope.

    ``evidence`` is ``SpeechLevels.fingerprint_term()``: ``"own"`` when only the own-track
    half of the aligner gate applied, ``"bleed:<placement digest>"`` after the full gate ran
    on a settled placement. It only counts once a word carries a score.
    """
    digest = sha256()
    digest.update(f"v2:{audio_sha256}:{options.silence_filter_enabled}:".encode())
    if options.silence_filter_enabled:
        digest.update(f"{float(options.silence_peak_dbfs).hex()}:".encode())
    for word in words:
        digest.update(
            f"{word.start.hex()}:{word.end.hex()}:{int(word.suspect_hallucination)};".encode()
        )
    # Aligner evidence (#195) counts only once a word carries a score, so fingerprints
    # stored before it stay valid and unchanged reused transcripts are not re-decoded.
    if any(w.alignment_score is not None for w in words):
        digest.update(
            "ctc3:"
            f"{float(options.forced_alignment_min_word_score).hex()}:"
            f"{float(options.forced_alignment_speech_margin_db).hex()}:"
            f"{float(options.forced_alignment_bleed_margin_db).hex()}:"
            f"{evidence}:".encode()
        )
    return digest.hexdigest()


def placement_digest(project: EpisodeProject) -> str:
    """A digest of where every dialogue clip sits (source range and timeline start).

    The bleed half of the evidence gate compares tracks on the session clock, so its
    flags are only as good as this placement; a change to it re-flags.
    """
    from podcast_mcp.util.tracks import dialogue_track_ids

    dialogue = set(dialogue_track_ids(project))
    rows = sorted(
        (c.track_id, c.source_id or "", c.source_start, c.source_end, c.timeline_start)
        for c in project.clips
        if c.track_id in dialogue
    )
    return sha256(repr(rows).encode()).hexdigest()[:16]


def evidence_term(project: EpisodeProject, *, bleed_check: bool) -> str:
    """The fingerprint's evidence scope without decoding any audio."""
    return f"bleed:{placement_digest(project)}" if bleed_check else "own"


def flag_words_over_silence(
    words: Sequence[TranscriptWord],
    peaks: np.ndarray,
    rate: float,
    *,
    peak_dbfs: float,
) -> int:
    """Set ``suspect_hallucination`` on every word; return how many are True.

    ``peaks`` holds absolute sample peaks at ``rate`` values per second (raw samples,
    or a block envelope from :func:`peak_envelope`).
    """
    floor = db_to_amplitude(peak_dbfs)
    total = int(peaks.size)
    flagged = 0
    for w in words:
        w.suspect_hallucination = False
        centre = (w.start + w.end) / 2.0
        half = max(w.end - w.start, MIN_SPAN_SEC) / 2.0
        lo = max(0, int((centre - half) * rate))
        hi = min(total, int(np.ceil((centre + half) * rate)))
        if lo >= hi:
            continue  # span outside the decoded audio: no evidence either way
        if float(np.max(peaks[lo:hi])) < floor:
            w.suspect_hallucination = True
            flagged += 1
    return flagged


def below_evidence_floor(score: float | None, min_score: float) -> bool:
    """True when an aligned word's ``score`` is below ``min_score`` (``min_score <= 0`` = off)."""
    return min_score > 0 and score is not None and score < min_score


class SpeechEvidence(Protocol):
    """Whether a track carries its own speech over a source span (the #780 evidence gate)."""

    def has_speech(self, track_id: str, start: float, end: float) -> bool: ...


@dataclass
class TrackEnergy:
    """One dialogue track as 10 ms frame levels (dBFS, float32) and its noise floor.

    The gate only reads span RMS, so frames replace samples: a 28-minute track is 0.7 MB
    instead of 54 MB, and the decode streams so nothing larger than one chunk is resident.
    """

    frames_db: np.ndarray
    floor_db: float

    @classmethod
    def decode(cls, path: Path, *, floor_percentile: float = 5.0) -> TrackEnergy:
        from podcast_mcp.engines.ffmpeg import FFmpegEngine
        from podcast_mcp.util.dsp import frame_rms_db_stream

        frame = round(LEVEL_SAMPLE_RATE * LEVEL_FRAME_SEC)
        chunks = FFmpegEngine().stream_mono_f32(path, sample_rate=LEVEL_SAMPLE_RATE)
        frames_db = frame_rms_db_stream(chunks, frame, frame, floor_db=SILENT_FRAME_DB).astype(
            np.float32
        )
        if frames_db.size == 0:
            raise NoAudioDecodedError(path)
        heard = frames_db[frames_db > SILENT_FRAME_DB]
        floor = float(np.percentile(heard, floor_percentile)) if heard.size else SILENT_FRAME_DB
        return cls(frames_db=frames_db, floor_db=floor)

    def level_db(self, start: float, end: float) -> float | None:
        """RMS over ``[start, end)`` source seconds from the frames it covers; None past the end."""
        i0 = max(0, int(start / LEVEL_FRAME_SEC))
        i1 = max(i0 + 1, int(np.ceil(end / LEVEL_FRAME_SEC)))
        if i0 >= self.frames_db.size:
            return None
        seg = self.frames_db[i0 : min(i1, self.frames_db.size)].astype(np.float64)
        power = float(np.mean(10.0 ** (seg / 10.0)))
        return 10.0 * np.log10(power) if power > 0.0 else SILENT_FRAME_DB


@dataclass
class SpeechLevels:
    """Dialogue-track levels for the aligner evidence gate (#780).

    A word has speech evidence when its own track's level over the aligned span (the
    recording's level plus the track gain, the same rule reconcile's audibility uses) sits
    at least ``speech_margin_db`` above that track's noise floor and, with ``bleed_check``,
    no other dialogue track is ``bleed_margin_db`` louder over the same session-clock span.
    ``bleed_check`` is off at transcribe time, before ``align_tracks`` has placed the tracks
    against each other, and on when ``reconcile_transcript`` re-flags afterwards; the
    ``placement`` digest ties those flags to the placement they were read from. Spans are
    widened to ``MIN_SPAN_SEC`` like the silence filter, so a one-frame aligned word still
    measures something. A track that could not be decoded, or a span cut from the
    timeline, counts as evidence: the flag never fires on the score alone.
    """

    timeline: SessionTimeline
    tracks: dict[str, TrackEnergy]
    gains_db: dict[str, float]
    speech_margin_db: float
    bleed_margin_db: float
    bleed_check: bool
    placement: str
    skipped: list[str] = field(default_factory=list)

    @classmethod
    def for_project(
        cls, project: EpisodeProject, options: AsrOptions, *, bleed_check: bool
    ) -> SpeechLevels:
        """Decode every dialogue track's primary media once (a few seconds per hour)."""
        from podcast_mcp.engines.session_timeline import SessionTimeline
        from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

        levels = cls(
            timeline=SessionTimeline(project),
            tracks={},
            gains_db={},
            speech_margin_db=options.forced_alignment_speech_margin_db,
            bleed_margin_db=options.forced_alignment_bleed_margin_db,
            bleed_check=bleed_check,
            placement=placement_digest(project),
        )
        for tid in dialogue_track_ids(project):
            try:
                energy = TrackEnergy.decode(track_audio_path(project, tid))
            except Exception as exc:
                log.warning("aligner evidence levels skipped for track %s: %s", tid, exc)
                levels.skipped.append(tid)
                continue
            track = project.track_by_id(tid)
            levels.tracks[tid] = energy
            levels.gains_db[tid] = float(track.gain_db) if track else 0.0
        return levels

    @property
    def floors_db(self) -> dict[str, float]:
        return {tid: energy.floor_db for tid, energy in self.tracks.items()}

    def fingerprint_term(self) -> str:
        """What ``silence_filter_fingerprint`` records about the gate these flags came from."""
        return f"bleed:{self.placement}" if self.bleed_check else "own"

    def _level_db(self, track_id: str, start: float, end: float) -> float | None:
        energy = self.tracks.get(track_id)
        if energy is None:
            return None
        centre = (start + end) / 2.0
        half = max(end - start, MIN_SPAN_SEC) / 2.0
        level = energy.level_db(max(0.0, centre - half), centre + half)
        return None if level is None else level + self.gains_db[track_id]

    def has_speech(self, track_id: str, start: float, end: float) -> bool:
        from podcast_mcp.util.source_spans import source_span_timeline_bounds
        from podcast_mcp.util.timebase import TimelineSec

        own = self._level_db(track_id, start, end)
        if own is None:
            return True
        if own < self.tracks[track_id].floor_db + self.speech_margin_db:
            return False
        if not self.bleed_check:
            return True
        tl_start, tl_end = source_span_timeline_bounds(self.timeline, track_id, start, end)
        if tl_start is None or tl_end is None:
            return True
        for other_id in self.tracks:
            if other_id == track_id:
                continue
            src_start = self.timeline.timeline_to_source(other_id, TimelineSec(tl_start))
            src_end = self.timeline.timeline_to_source(other_id, TimelineSec(tl_end))
            if src_start is None or src_end is None:
                continue
            other = self._level_db(other_id, float(src_start), float(src_end))
            if other is not None and other >= own + self.bleed_margin_db:
                return False
        return True


def flag_words_without_acoustic_evidence(
    words: Sequence[TranscriptWord],
    *,
    min_score: float,
    evidence: SpeechEvidence | None,
    track_id: str,
) -> int:
    """Set ``suspect_hallucination`` on aligned words scoring below ``min_score`` whose
    ``evidence`` finds no own speech over the span; never clears.

    ``alignment_score`` is None for words the forced aligner did not place (no evidence either
    way). ``min_score <= 0`` turns the signal off, and so does ``evidence=None`` (no levels to
    check, so a low score alone never flags). Returns how many words it flagged.
    """
    if evidence is None:
        return 0
    flagged = 0
    for w in words:
        if below_evidence_floor(w.alignment_score, min_score) and not evidence.has_speech(
            track_id, w.start, w.end
        ):
            w.suspect_hallucination = True
            flagged += 1
    return flagged


def peak_envelope(path: Path, *, block_sec: float = PEAK_BLOCK_SEC) -> tuple[np.ndarray, float]:
    """Stream ``path``; return ``(peaks, rate)``: max |sample| over all channels per block."""
    from podcast_mcp.engines.waveform_pyramid import decode_media

    sample_rate, _channels, chunks = decode_media(path)
    block = max(1, round(sample_rate * block_sec))
    parts: list[np.ndarray] = []
    carry = np.zeros(0, dtype=np.float32)
    try:
        for chunk in chunks:
            frame_peaks = np.abs(chunk).max(axis=1) if chunk.ndim == 2 else np.abs(chunk)
            buf = np.concatenate([carry, frame_peaks.astype(np.float32, copy=False)])
            whole = buf.size // block
            if whole:
                parts.append(buf[: whole * block].reshape(whole, block).max(axis=1))
            carry = buf[whole * block :]
    finally:
        chunks.close()
    if carry.size:
        parts.append(np.array([carry.max()], dtype=np.float32))
    if not parts:
        raise NoAudioDecodedError(path)
    return np.concatenate(parts), sample_rate / block


def silent_fraction(peaks: np.ndarray, *, peak_dbfs: float) -> float:
    """Share of ``peaks`` blocks below ``peak_dbfs`` (0.0 for an empty envelope)."""
    if peaks.size == 0:
        return 0.0
    return float(np.count_nonzero(peaks < db_to_amplitude(peak_dbfs)) / peaks.size)


@lru_cache(maxsize=64)
def _cached_silent_fraction(
    path: str, revision: FileRevision, head_tail: str, peak_dbfs: float
) -> float:
    """Decode ``path`` once per (``file_revision``, head/tail digest, peak_dbfs).

    ``revision`` and ``head_tail`` are only cache keys.
    """
    del revision, head_tail  # cache key only
    peaks, _rate = peak_envelope(Path(path))
    return silent_fraction(peaks, peak_dbfs=peak_dbfs)


def digital_silence_fraction(path: Path, *, peak_dbfs: float) -> float | None:
    """Share of ``path``'s ``PEAK_BLOCK_SEC`` blocks that are digital silence.

    Cached in-process per resolved path, ``file_revision`` (device, inode, size, mtime),
    a SHA-256 of the first and last 64 KiB (``util.hashing.sha256_head_tail``) and
    ``peak_dbfs``, so a re-run Analyze (GUI button, MCP) does not decode an unchanged
    file again. An atomic replace or in-place rewrite re-measures when it changes the
    inode, size, mtime or either 64 KiB end; only a same-size edit confined to the middle
    of the file that also keeps inode and mtime stays cached until the process restarts.
    ``None`` (a warning is logged) when the media cannot be read or decoded; failures
    are not cached.
    """
    try:
        return _cached_silent_fraction(
            str(path.resolve()), file_revision(path), sha256_head_tail(path), float(peak_dbfs)
        )
    except Exception as exc:
        log.warning("digital silence measure skipped for %s: %s", path, exc)
        return None


def flag_silent_words_in_file(
    words: Sequence[TranscriptWord],
    path: Path,
    *,
    peak_dbfs: float,
) -> int | None:
    """Flag silent words in ``path``; ``None`` (logged as a warning) when it cannot be decoded."""
    try:
        peaks, rate = peak_envelope(path)
    except Exception as exc:
        log.warning("silence filter skipped for %s: %s", path, exc)
        return None
    return flag_words_over_silence(words, peaks, rate, peak_dbfs=peak_dbfs)


def refresh_silence_flags(
    words: Sequence[TranscriptWord],
    path: Path,
    options: AsrOptions,
    *,
    evidence: SpeechEvidence | None = None,
    track_id: str = "",
) -> int | None:
    """Recompute ``suspect_hallucination`` on ``words`` from both signals in ``options``.

    Every flag is cleared first; the silence filter (when on) sets its flags, then aligned
    words without acoustic evidence (low score and ``evidence`` finds no own speech on
    ``track_id``) are OR-ed in. Returns the flagged count, or ``None`` when ``path`` cannot be
    decoded (silence flags stay cleared, the evidence flags still apply and are the only
    flags, a warning is logged). Callers store no fingerprint on ``None``, so the next run
    retries the decode.
    """
    for w in words:
        w.suspect_hallucination = False
    silent: int | None = 0
    if options.silence_filter_enabled:
        silent = flag_silent_words_in_file(words, path, peak_dbfs=options.silence_peak_dbfs)
    flag_words_without_acoustic_evidence(
        words,
        min_score=options.forced_alignment_min_word_score,
        evidence=evidence,
        track_id=track_id,
    )
    if silent is None:
        return None
    return sum(1 for w in words if w.suspect_hallucination)
