"""Decide which transcription jobs reuse a stored transcript and which run ASR."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import refresh_silence_flags, silence_filter_fingerprint
from podcast_mcp.engines.transcribe import TranscribeJob, TranscriptionEngine, cached_audio_keys
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptKey
from podcast_mcp.transcript_context import TranscriptContext, load_transcript_context
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.word_aligner_models import WordAlignerModel, word_aligner_model

log = logging.getLogger(__name__)


class TranscriptOverwriteRefused(RuntimeError):
    """An unattended run would replace a hand-edited transcript."""


@dataclass
class TranscribePlan:
    overwrite: bool
    audio_hashes: dict[TranscriptKey, str] = field(default_factory=dict)
    audio_stats: dict[TranscriptKey, tuple[int, int]] = field(default_factory=dict)
    run: list[TranscribeJob] = field(default_factory=list)
    reused: list[TranscribeJob] = field(default_factory=list)
    adopted: list[TranscriptKey] = field(default_factory=list)
    overwrite_edited: list[str] = field(default_factory=list)
    retime: list[TranscribeJob] = field(default_factory=list)
    retime_skipped_edited: list[str] = field(default_factory=list)
    retime_skipped_no_cache: list[str] = field(default_factory=list)
    # The context plan_retime built its ASR-cache prompt from; run_transcribe_plan reuses it so
    # the prompt, cache key and vocabulary_revision all come from one load.
    context: TranscriptContext | None = None


class HasAudioIdentity(Protocol):
    """Anything that records the audio hash/size/mtime an ASR-style cache reused."""

    audio_sha256: str | None
    audio_size: int | None
    audio_mtime_ns: int | None


def audio_identity(
    job: TranscribeJob, current: HasAudioIdentity | None
) -> tuple[str, tuple[int, int]]:
    """Hash ``job.audio`` unless its size and mtime match what ``current`` recorded.

    Shared by transcript reuse and prosody profile reuse (both cache a per-track
    analysis keyed on the same track's primary media).
    """
    st = job.audio.stat()
    stats = (st.st_size, st.st_mtime_ns)
    if (
        current is not None
        and current.audio_sha256
        and (current.audio_size, current.audio_mtime_ns) == stats
    ):
        return current.audio_sha256, stats
    return sha256_file(job.audio), stats


def _audio_matches(
    project: EpisodeProject, job: TranscribeJob, current: Transcript, sha: str
) -> bool:
    """Whether ``current``'s words came from the media hashed as ``sha``.

    A legacy or seeded transcript has no hash: trust it unless the ASR caches show this
    job was only ever transcribed from other audio (re-trimmed or re-aligned since).
    """
    if current.audio_sha256 is not None:
        return current.audio_sha256 == sha
    seen = cached_audio_keys(project, job.cache_id)
    return not seen or sha[:16] in seen


def _refusal_message(forced: list[str], changed: list[str]) -> str:
    reasons: list[str] = []
    if changed:
        reasons.append(
            "the audio changed since these edited transcripts were made, so their word "
            "times are stale: " + ", ".join(changed)
        )
    if forced:
        reasons.append(
            "re-transcription was requested for these edited transcripts: " + ", ".join(forced)
        )
    return (
        "refusing to replace edited transcripts in an unattended run; "
        + "; ".join(reasons)
        + ". Run attended (turn off Batch mode in Studio, or drop --unattended / PODCAST_BATCH) "
        "or click Studio Re-transcribe to replace them."
    )


def plan_transcription(
    project: EpisodeProject,
    jobs: list[TranscribeJob],
    *,
    overwrite: bool,
    unattended: bool,
    allow_edited: bool = False,
) -> TranscribePlan:
    """Reuse stored transcripts unless overwrite is requested or the audio changed.

    Replacing a ``user_edited`` transcript is refused when ``unattended`` unless
    ``allow_edited`` (an explicit confirmation such as Studio Re-transcribe).
    """
    existing = {t.key: t for t in project.transcripts}
    plan = TranscribePlan(overwrite=overwrite)
    refused_forced: list[str] = []
    refused_changed: list[str] = []
    for job in jobs:
        current = existing.get(job.key)
        sha, stats = audio_identity(job, current)
        plan.audio_hashes[job.key] = sha
        plan.audio_stats[job.key] = stats
        if current is None or (current.audio_sha256 is None and not current.words):
            plan.run.append(job)
            continue
        matches = _audio_matches(project, job, current, sha)
        if matches and not overwrite:
            plan.reused.append(job)
            if current.audio_sha256 is None:
                plan.adopted.append(job.key)
            continue
        if current.user_edited:
            if unattended and not allow_edited:
                (refused_forced if matches else refused_changed).append(job.label)
                continue
            plan.overwrite_edited.append(job.track_id)
        plan.run.append(job)
    if refused_forced or refused_changed:
        raise TranscriptOverwriteRefused(_refusal_message(refused_forced, refused_changed))
    return plan


def needs_retime(transcript: Transcript, model: WordAlignerModel) -> bool:
    """Words ``model`` could re-time that it has not, or re-timed before scores existed (#195)."""
    return (
        bool(transcript.words)
        and model.supports_language(transcript.language)
        and (
            transcript.word_aligner != model.id
            or all(w.alignment_score is None for w in transcript.words)
        )
    )


def plan_retime(
    project: EpisodeProject,
    plan: TranscribePlan,
    engine: TranscriptionEngine,
    *,
    language: str | None,
    allow_edited: bool,
) -> None:
    """Move reused jobs whose ASR cache is on disk into ``plan.run`` so only alignment runs.

    ``run_transcribe_plan`` then reads Whisper's cached words (``use_cache`` stays true) and
    re-aligns them, replacing the stored transcript. Hand-edited transcripts move only with
    ``allow_edited`` (Studio's confirmation); jobs with no ASR cache for the current model,
    language, vocabulary prompt and decode options stay reused and are reported.

    The context loaded here is kept on ``plan.context`` and reused by ``run_transcribe_plan``,
    so a vocabulary save during the step cannot turn a re-time into a Whisper run. The
    re-timed transcripts are stamped with this load's revision and show as stale in Studio.
    """
    model = word_aligner_model()
    stored = {t.key: t for t in project.transcripts}
    plan.context = load_transcript_context(project.workspace_path())
    prompt = plan.context.initial_prompt_text()
    kept: list[TranscribeJob] = []
    for job in plan.reused:
        current = stored.get(job.key)
        if current is None or not needs_retime(current, model):
            kept.append(job)
            continue
        if current.user_edited and not allow_edited:
            plan.retime_skipped_edited.append(job.label)
            kept.append(job)
            continue
        _, cached = engine.read_asr_cache(
            project,
            job,
            language=language,
            initial_prompt=prompt,
            audio_sha256=plan.audio_hashes[job.key],
        )
        if cached is None:
            plan.retime_skipped_no_cache.append(job.label)
            kept.append(job)
            continue
        if current.user_edited:
            plan.overwrite_edited.append(job.track_id)
        plan.retime.append(job)
        plan.run.append(job)
    plan.reused = kept


def merge_transcripts_by_key(project: EpisodeProject, new: list[Transcript]) -> None:
    """Replace stored transcripts that share a ``(track, source)`` key with ``new``.

    Other transcripts keep their order; transcripts with a new key are appended.
    """
    by_key = {t.key: t for t in project.transcripts}
    for t in new:
        by_key[t.key] = t
    project.transcripts = list(by_key.values())


def stamp_audio_identity(project: EpisodeProject, plan: TranscribePlan) -> None:
    """Record hash, size and mtime on transcripts that now match this run's media.

    Adopted legacy/seeded transcripts get the hash; reused and freshly transcribed ones
    (whose hash already matches) get the size and mtime that let the next run skip hashing.
    """
    adopted = set(plan.adopted)
    for t in project.transcripts:
        sha = plan.audio_hashes.get(t.key)
        if sha is None:
            continue
        if t.key in adopted:
            t.audio_sha256 = sha
        if t.audio_sha256 == sha:
            t.audio_size, t.audio_mtime_ns = plan.audio_stats[t.key]


def run_transcribe_plan(
    project: EpisodeProject,
    plan: TranscribePlan,
    make_engine: Callable[[], TranscriptionEngine],
    *,
    use_cache: bool,
    **asr_options: Any,
) -> list[Transcript]:
    """Run ASR for ``plan.run``, apply the results to ``project`` and return them.

    Warns for each edited transcript being replaced, stamps the vocabulary revision the
    prompt came from, merges by ``(track, source)`` key, then records audio identity on
    every planned transcript (reused ones too). ``make_engine`` is called only when ASR
    runs; ``asr_options`` (``language``, ``max_word_sec``) go to ``transcribe_all_dialogue``.
    """
    for track_id in plan.overwrite_edited:
        log.warning("re-transcribing overwrites edited transcript for track %s", track_id)
    transcripts: list[Transcript] = []
    if plan.run:
        ctx = plan.context or load_transcript_context(project.workspace_path())
        # Prompt and vocabulary_revision must come from this one load: a concurrent
        # edit mints a newer revision, so these transcripts stay stale in Studio.
        transcripts = make_engine().transcribe_all_dialogue(
            project,
            initial_prompt=ctx.initial_prompt_text(),
            jobs=plan.run,
            audio_hashes=plan.audio_hashes,
            use_cache=use_cache,
            **asr_options,
        )
        for t in transcripts:
            t.vocabulary_revision = ctx.vocabulary_revision
        # A correction saved to one of these transcripts during ASR is not lost: the
        # runner's save_merged merges words as one value, so both changing them conflicts.
        merge_transcripts_by_key(project, transcripts)
    stamp_audio_identity(project, plan)
    return transcripts


def refresh_reused_silence_flags(
    project: EpisodeProject, plan: TranscribePlan, options: AsrOptions
) -> list[str]:
    """Re-flag ``suspect_hallucination`` on ``plan.reused`` transcripts from ``options``.

    Reused transcripts skip ASR. Decode an envelope only when their stored flags do not
    match the current media, settings, word spans and flag state. Legacy transcripts
    have no fingerprint and are checked once. Returns labels whose audio could not be decoded.
    """
    stored = {t.key: t for t in project.transcripts}
    skipped: list[str] = []
    for job in plan.reused:
        transcript = stored.get(job.key)
        if transcript is None:
            continue
        audio_hash = plan.audio_hashes[job.key]
        if transcript.silence_filter_fingerprint == silence_filter_fingerprint(
            transcript.words, audio_hash, options
        ):
            continue
        if refresh_silence_flags(transcript.words, job.audio, options) is None:
            skipped.append(job.label)
            transcript.silence_filter_fingerprint = None
        else:
            transcript.silence_filter_fingerprint = silence_filter_fingerprint(
                transcript.words, audio_hash, options
            )
    return skipped
