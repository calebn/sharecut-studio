"""Decide which transcription jobs reuse a stored transcript and which run ASR."""

from __future__ import annotations

from dataclasses import dataclass, field

from podcast_mcp.engines.transcribe import (
    TranscribeJob,
    TranscriptKey,
    transcript_key,
)
from podcast_mcp.models import EpisodeProject, Transcript
from podcast_mcp.util.hashing import sha256_file


class TranscriptOverwriteRefused(RuntimeError):
    """An unattended run would replace a hand-edited transcript."""


def transcript_has_user_edits(transcript: Transcript) -> bool:
    return bool(transcript.user_edited)


@dataclass
class TranscribePlan:
    overwrite: bool
    audio_hashes: dict[TranscriptKey, str] = field(default_factory=dict)
    run: list[TranscribeJob] = field(default_factory=list)
    reused: list[TranscribeJob] = field(default_factory=list)
    adopted: list[TranscriptKey] = field(default_factory=list)
    overwrite_edited: list[str] = field(default_factory=list)


def plan_transcription(
    project: EpisodeProject,
    jobs: list[TranscribeJob],
    *,
    overwrite: bool,
    unattended: bool,
) -> TranscribePlan:
    """Reuse stored transcripts unless overwrite is requested or the audio changed."""
    existing = {transcript_key(t): t for t in project.transcripts}
    plan = TranscribePlan(overwrite=overwrite)
    refused: list[str] = []
    for job in jobs:
        sha = sha256_file(job.audio)
        plan.audio_hashes[job.key] = sha
        current = existing.get(job.key)
        if current is None or (current.audio_sha256 is None and not current.words):
            plan.run.append(job)
            continue
        if not overwrite and current.audio_sha256 in (None, sha):
            plan.reused.append(job)
            if current.audio_sha256 is None:
                plan.adopted.append(job.key)
            continue
        if transcript_has_user_edits(current):
            if unattended:
                refused.append(job.label)
                continue
            plan.overwrite_edited.append(job.track_id)
        plan.run.append(job)
    if refused:
        raise TranscriptOverwriteRefused(
            "refusing to overwrite edited transcript(s) in an unattended run: "
            + ", ".join(refused)
            + ". Re-transcribe from an attended session (Studio Re-transcribe) to replace them."
        )
    return plan


def stamp_adopted_transcripts(project: EpisodeProject, plan: TranscribePlan) -> None:
    """Record the current audio hash on legacy or seeded transcripts that were reused."""
    adopted = set(plan.adopted)
    for t in project.transcripts:
        key = transcript_key(t)
        if key in adopted:
            t.audio_sha256 = plan.audio_hashes[key]
