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
that scope and the relevant gains, placement, and selected-media revisions, so an
evidence-input change re-flags once. Peer levels follow each lane clip's selected
``source_id`` and source offset; an unavailable selected source is unknown evidence
rather than a fallback to unrelated primary media. It is still flag-only and never retimed.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

import numpy as np

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.models import Clip, EpisodeProject, TranscriptWord
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

    ``evidence`` is ``SpeechLevels.fingerprint_term(track_id)``. It records the applicable
    scope, relevant gains, settled placement, and selected-media revisions. It only counts
    once a word carries a score.
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


def _primary_media_key(project: EpisodeProject, track_id: str) -> str | None:
    from podcast_mcp.util.tracks import track_audio_path

    try:
        return str(track_audio_path(project, track_id).resolve(strict=False))
    except (OSError, ValueError):
        return None


def _unavailable_clip_media_key(project: EpisodeProject, clip: Clip) -> str:
    """Stable selected-media key when a clip cannot currently resolve to a file."""
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
    from podcast_mcp.util.workspace_paths import resolve_under_workspace

    track = project.track_by_id(clip.track_id)
    try:
        if track is not None:
            return str(resolve_clip_audio_path(project, track, clip).resolve(strict=False))
    except (OSError, ValueError):
        pass
    if clip.source_id:
        source = project.source_by_id(clip.source_id)
        if source is not None:
            try:
                return str(resolve_under_workspace(project, source.path).resolve(strict=False))
            except (OSError, ValueError):
                return f"source:{clip.source_id}"
        return f"source:{clip.source_id}"
    return _primary_media_key(project, clip.track_id) or f"track:{clip.track_id}:missing"


def _selected_media_keys(
    project: EpisodeProject, track_id: str, *, bleed_check: bool
) -> tuple[str, ...]:
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
    from podcast_mcp.util.tracks import dialogue_track_ids

    keys: set[str] = set()
    primary = _primary_media_key(project, track_id)
    if primary is not None:
        keys.add(primary)
    else:
        keys.add(f"track:{track_id}:missing")
    if not bleed_check:
        return tuple(sorted(keys))

    timeline = SessionTimeline(project)
    for lane_id in dialogue_track_ids(project):
        lane = project.track_by_id(lane_id)
        if lane is None:
            continue
        spans = timeline.lane_clip_spans(lane_id)
        if not spans:
            keys.add(_primary_media_key(project, lane_id) or f"track:{lane_id}:missing")
            continue
        for span in spans:
            try:
                key = str(resolve_clip_audio_path(project, lane, span.clip).resolve(strict=False))
            except (OSError, ValueError):
                key = _unavailable_clip_media_key(project, span.clip)
            keys.add(key)
    return tuple(sorted(keys))


def _media_keys_digest(keys: Sequence[str], revisions: dict[str, FileRevision | None]) -> str:
    identity: list[tuple[str, FileRevision | None]] = []
    for key in keys:
        revision = revisions.get(key)
        identity.append((key, revision))
    return sha256(repr(tuple(identity)).encode()).hexdigest()[:16]


def _evidence_term(
    gains_db: Mapping[str, float],
    track_id: str,
    *,
    bleed_check: bool,
    placement: str | None = None,
    media_digest: str = "",
) -> str:
    """Fingerprint the applicable gains, placement and selected-media identity."""
    relevant_gains = (
        sorted(gains_db.items()) if bleed_check else [(track_id, gains_db.get(track_id, 0.0))]
    )
    gain_digest = sha256(
        repr(tuple((tid, float(gain).hex()) for tid, gain in relevant_gains)).encode()
    ).hexdigest()[:16]
    if bleed_check:
        return f"bleed:{placement or ''}:{gain_digest}:{media_digest}"
    return f"own:{gain_digest}:{media_digest}"


def evidence_term(
    project: EpisodeProject,
    track_id: str,
    *,
    bleed_check: bool,
) -> str:
    """Fingerprint the gain, placement and selected-media scope without decoding."""
    from podcast_mcp.util.tracks import dialogue_track_ids

    keys = _selected_media_keys(project, track_id, bleed_check=bleed_check)
    revision_map: dict[str, FileRevision | None] = {}
    for key in keys:
        try:
            revision_map[key] = file_revision(Path(key))
        except OSError:
            revision_map[key] = None
    media = _media_keys_digest(keys, revision_map)
    gains_db = {
        tid: float(track.gain_db) if (track := project.track_by_id(tid)) is not None else 0.0
        for tid in dialogue_track_ids(project)
    }
    return _evidence_term(
        gains_db,
        track_id,
        bleed_check=bleed_check,
        placement=placement_digest(project) if bleed_check else None,
        media_digest=media,
    )


def evidence_applies(
    words: Sequence[TranscriptWord], options: AsrOptions, *, source_id: str | None
) -> bool:
    """Whether scored primary-media words use the acoustic evidence gate."""
    return (
        options.forced_alignment_min_word_score > 0
        and source_id is None
        and any(word.alignment_score is not None for word in words)
    )


def evidence_terms(
    project: EpisodeProject,
    track_id: str,
    words: Sequence[TranscriptWord],
    options: AsrOptions,
    *,
    bleed_check: bool,
    source_id: str | None = None,
) -> tuple[str, ...]:
    """Fingerprint accepted scopes for the acoustic evidence that applies here."""
    if not evidence_applies(words, options, source_id=source_id):
        return ("own",)
    own = evidence_term(project, track_id, bleed_check=False)
    settled = evidence_term(project, track_id, bleed_check=True)
    return (settled,) if bleed_check else (own, settled)


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


@dataclass(frozen=True)
class MediaEnergy:
    """Decoded levels for one selected media file revision."""

    revision: FileRevision
    energy: TrackEnergy


@dataclass
class SpeechLevels:
    """Dialogue-track levels for the aligner evidence gate (#780).

    A word has speech evidence when its own track's level over the aligned span (the
    recording's level plus the track gain, the same rule reconcile's audibility uses) sits
    at least ``speech_margin_db`` above that track's noise floor and, with ``bleed_check``,
    no other dialogue track is ``bleed_margin_db`` louder over the same session-clock span.
    ``bleed_check`` is off at transcribe time, before ``align_tracks`` has placed the tracks
    against each other, and on when ``reconcile_transcript`` re-flags afterwards; the
    fingerprint records the gains, placement and selected-media revisions measured by
    the gate. Peer levels follow each lane clip's selected recording and offset. Spans are
    widened to ``MIN_SPAN_SEC`` like the silence filter, so a one-frame aligned word still
    measures something. A track that could not be decoded, or a span cut from the
    timeline, counts as evidence: the flag never fires on the score alone.
    """

    project: EpisodeProject
    timeline: SessionTimeline
    tracks: dict[str, TrackEnergy]
    media: dict[str, MediaEnergy]
    media_revisions: dict[str, FileRevision | None]
    selected_media_keys: dict[str, tuple[str, ...]]
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
        """Decode selected dialogue media once per resolved file revision."""
        from podcast_mcp.engines.session_timeline import SessionTimeline
        from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
        from podcast_mcp.util.project_state import file_revision
        from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

        timeline = SessionTimeline(project)
        media: dict[str, MediaEnergy] = {}
        media_revisions: dict[str, FileRevision | None] = {}
        selected_media_keys = {
            tid: _selected_media_keys(project, tid, bleed_check=bleed_check)
            for tid in dialogue_track_ids(project)
        }
        tracks: dict[str, TrackEnergy] = {}
        gains_db = {
            tid: float(track.gain_db)
            for tid in dialogue_track_ids(project)
            if (track := project.track_by_id(tid)) is not None
        }
        skipped: list[str] = []

        def decode_once(path: Path, track_id: str) -> TrackEnergy | None:
            resolved: Path | None = None
            attempted_revision: FileRevision | None = None
            try:
                resolved = path.resolve(strict=True)
                revision = file_revision(resolved)
                attempted_revision = revision
                key = str(resolved)
                current = media.get(key)
                if current is not None and current.revision == revision:
                    return current.energy
                if current is None and media_revisions.get(key) == revision:
                    return None
                media_revisions[key] = revision
                energy = TrackEnergy.decode(resolved)
                if file_revision(resolved) != revision:
                    raise OSError("media changed while evidence levels were decoded")
            except Exception as exc:
                if resolved is not None:
                    media_revisions[str(resolved)] = attempted_revision
                log.warning("aligner evidence levels skipped for track %s: %s", track_id, exc)
                skipped.append(track_id)
                return None
            media[key] = MediaEnergy(revision=revision, energy=energy)
            return energy

        levels = cls(
            timeline=timeline,
            project=project,
            tracks=tracks,
            media=media,
            media_revisions=media_revisions,
            selected_media_keys=selected_media_keys,
            gains_db=gains_db,
            speech_margin_db=options.forced_alignment_speech_margin_db,
            bleed_margin_db=options.forced_alignment_bleed_margin_db,
            bleed_check=bleed_check,
            placement=placement_digest(project),
            skipped=skipped,
        )
        for tid in dialogue_track_ids(project):
            track = project.track_by_id(tid)
            if track is None:
                continue
            try:
                primary = track_audio_path(project, tid)
            except Exception as exc:
                log.warning("aligner evidence levels skipped for track %s: %s", tid, exc)
                skipped.append(tid)
            else:
                energy = decode_once(primary, tid)
                if energy is not None:
                    tracks[tid] = energy
            if not bleed_check:
                continue
            for span in timeline.lane_clip_spans(tid):
                try:
                    selected = resolve_clip_audio_path(project, track, span.clip)
                    decode_once(selected, tid)
                except Exception as exc:
                    selected_key = _unavailable_clip_media_key(project, span.clip)
                    media_revisions[selected_key] = None
                    log.warning("aligner evidence levels skipped for track %s: %s", tid, exc)
                    skipped.append(tid)
        levels.skipped[:] = list(dict.fromkeys(skipped))
        return levels

    @property
    def floors_db(self) -> dict[str, float]:
        return {tid: energy.floor_db for tid, energy in self.tracks.items()}

    def fingerprint_term(self, track_id: str) -> str:
        """What ``silence_filter_fingerprint`` records about the gate these flags came from."""
        return _evidence_term(
            self.gains_db,
            track_id,
            bleed_check=self.bleed_check,
            placement=self.placement,
            media_digest=_media_keys_digest(
                self.selected_media_keys.get(track_id, ()), self.media_revisions
            ),
        )

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
        for other_id in self.gains_db:
            if other_id == track_id:
                continue
            other = self._lane_level_db(other_id, tl_start, tl_end)
            if other is not None and other >= own + self.bleed_margin_db:
                return False
        return True

    def _lane_level_db(
        self, track_id: str, timeline_start: float, timeline_end: float
    ) -> float | None:
        """RMS of the audio actually selected on a lane over a timeline span."""
        from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
        from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
        from podcast_mcp.util.intervals import merge_intervals

        centre = (timeline_start + timeline_end) / 2.0
        half = max(timeline_end - timeline_start, MIN_SPAN_SEC) / 2.0
        timeline_start = max(0.0, centre - half)
        timeline_end = centre + half
        spans = self.timeline.lane_clip_spans(track_id)
        if not spans:
            return self._level_db(track_id, timeline_start, timeline_end)

        track = self.project.track_by_id(track_id)
        if track is None:
            return None
        powers: list[tuple[float, float]] = []
        coverage: list[tuple[float, float]] = []
        for span in spans:
            overlap_start = max(timeline_start, float(span.timeline_start))
            overlap_end = min(timeline_end, float(span.timeline_end))
            if overlap_end <= overlap_start:
                continue
            coverage.append((overlap_start, overlap_end))
            source_bounds = clip_timeline_overlap_to_source(span.clip, overlap_start, overlap_end)
            if source_bounds is None:
                continue
            try:
                path = resolve_clip_audio_path(self.project, track, span.clip)
                resolved = str(path.resolve(strict=True))
            except (OSError, ValueError):
                return None
            selected = self.media.get(resolved)
            if selected is None:
                return None
            try:
                if file_revision(Path(resolved)) != selected.revision:
                    return None
            except OSError:
                return None
            level = selected.energy.level_db(*source_bounds)
            if level is None:
                return None
            powers.append((float(level), overlap_end - overlap_start))

        if not powers:
            return None
        covered = merge_intervals(coverage, gap=1e-6)
        if (
            len(covered) != 1
            or covered[0][0] > timeline_start + 1e-6
            or covered[0][1] < timeline_end - 1e-6
        ):
            return None
        total_duration = sum(duration for _, duration in powers)
        mean_power = sum(10.0 ** (level / 10.0) * duration for level, duration in powers)
        mean_power /= total_duration
        level = 10.0 * np.log10(mean_power) if mean_power > 0.0 else SILENT_FRAME_DB
        return level + self.gains_db[track_id]


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
