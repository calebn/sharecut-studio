from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.transcript_reuse import (
    TranscriptOverwriteRefused,
    plan_transcription,
    stamp_adopted_transcripts,
    transcript_has_user_edits,
)
from podcast_mcp.engines.transcribe import TranscribeJob
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord
from podcast_mcp.util.hashing import sha256_file


@pytest.fixture
def job(tmp_path: Path) -> TranscribeJob:
    audio = tmp_path / "host.wav"
    audio.write_bytes(b"audio-bytes")
    return TranscribeJob("host", None, audio)


def _project(*transcripts: Transcript) -> EpisodeProject:
    p = EpisodeProject.create("t", "/tmp")
    p.transcripts = list(transcripts)
    return p


def _tr(**kw) -> Transcript:
    return Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0, end=0.5)], **kw)


def test_no_transcript_runs(job):
    plan = plan_transcription(_project(), [job], overwrite=False, unattended=False)
    assert plan.run == [job] and not plan.reused
    assert plan.audio_hashes[job.key] == sha256_file(job.audio)


def test_empty_unhashed_transcript_runs(job):
    p = _project(Transcript(track_id="host", words=[]))
    plan = plan_transcription(p, [job], overwrite=False, unattended=False)
    assert plan.run == [job]


def test_matching_hash_is_reused(job):
    p = _project(_tr(audio_sha256=sha256_file(job.audio)))
    plan = plan_transcription(p, [job], overwrite=False, unattended=True)
    assert plan.reused == [job] and not plan.run and not plan.adopted


def test_legacy_transcript_is_adopted_and_stamped(job):
    p = _project(_tr())
    plan = plan_transcription(p, [job], overwrite=False, unattended=True)
    assert plan.reused == [job] and plan.adopted == [job.key]
    stamp_adopted_transcripts(p, plan)
    assert p.transcripts[0].audio_sha256 == sha256_file(job.audio)


def test_changed_audio_reruns_unedited(job):
    p = _project(_tr(audio_sha256="0" * 64))
    plan = plan_transcription(p, [job], overwrite=False, unattended=True)
    assert plan.run == [job] and not plan.reused


def test_overwrite_reruns_and_edited_is_refused_unattended(job):
    p = _project(_tr(audio_sha256=sha256_file(job.audio)))
    assert plan_transcription(p, [job], overwrite=True, unattended=True).run == [job]
    p.transcripts[0].user_edited = True
    assert transcript_has_user_edits(p.transcripts[0])
    with pytest.raises(TranscriptOverwriteRefused, match="host"):
        plan_transcription(p, [job], overwrite=True, unattended=True)


def test_edited_overwrite_attended_is_reported(job):
    p = _project(_tr(audio_sha256=sha256_file(job.audio), user_edited=True))
    plan = plan_transcription(p, [job], overwrite=True, unattended=False)
    assert plan.run == [job] and plan.overwrite_edited == ["host"]
