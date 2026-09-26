"""Decide which transcription jobs reuse a stored transcript and which run ASR."""

from __future__ import annotations

from dataclasses import dataclass, field

from podcast_mcp.engines.transcribe import TranscribeJob, cached_audio_keys
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptKey
from podcast_mcp.util.hashing import sha256_file


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


def _audio_identity(job: TranscribeJob, current: Transcript | None) -> tuple[str, tuple[int, int]]:
    """Hash ``job.audio`` unless its size and mtime match what ``current`` recorded."""
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
        sha, stats = _audio_identity(job, current)
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
