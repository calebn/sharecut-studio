from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.transcript_reuse import (
    TranscriptOverwriteRefused,
    merge_transcripts_by_key,
    plan_transcription,
    stamp_audio_identity,
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


def _project(*transcripts: Transcript, workspace: str = "/tmp") -> EpisodeProject:
    p = EpisodeProject.create("t", workspace)
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
    stamp_audio_identity(p, plan)
    assert p.transcripts[0].audio_sha256 == sha256_file(job.audio)
    assert p.transcripts[0].audio_size == job.audio.stat().st_size


def test_changed_audio_reruns_unedited(job):
    p = _project(_tr(audio_sha256="0" * 64))
    plan = plan_transcription(p, [job], overwrite=False, unattended=True)
    assert plan.run == [job] and not plan.reused


def test_overwrite_reruns_and_edited_is_refused_unattended(job):
    p = _project(_tr(audio_sha256=sha256_file(job.audio)))
    assert plan_transcription(p, [job], overwrite=True, unattended=True).run == [job]
    p.transcripts[0].user_edited = True
    assert transcript_has_user_edits(p.transcripts[0])
    with pytest.raises(TranscriptOverwriteRefused, match="re-transcription was requested"):
        plan_transcription(p, [job], overwrite=True, unattended=True)


def test_edited_overwrite_attended_is_reported(job):
    p = _project(_tr(audio_sha256=sha256_file(job.audio), user_edited=True))
    plan = plan_transcription(p, [job], overwrite=True, unattended=False)
    assert plan.run == [job] and plan.overwrite_edited == ["host"]


def test_transcript_key_is_track_and_source():
    assert Transcript(track_id="host").key == ("host", None)
    assert Transcript(track_id="host", source_id="b").key == ("host", "b")


def test_merge_transcripts_by_key_replaces_and_keeps_others():
    guest = Transcript(track_id="guest")
    src = Transcript(track_id="host", source_id="b")
    p = _project(guest, _tr(), src)
    fresh = Transcript(track_id="host", words=[TranscriptWord(text="new", start=0, end=0.5)])
    added = Transcript(track_id="cohost")
    merge_transcripts_by_key(p, [fresh, added])
    assert [t.key for t in p.transcripts] == [
        ("guest", None),
        ("host", None),
        ("host", "b"),
        ("cohost", None),
    ]
    assert p.transcripts[1] is fresh and p.transcripts[2] is src


def _cache_files(p: EpisodeProject, *names: str) -> None:
    p.transcripts_dir().mkdir(parents=True, exist_ok=True)
    for name in names:
        (p.transcripts_dir() / name).write_text("{}", encoding="utf-8")


def test_legacy_transcript_with_only_other_audio_caches_reruns(job, tmp_path):
    p = _project(_tr(), workspace=str(tmp_path))
    _cache_files(p, f"host_{'a' * 16}_{'b' * 16}.json")
    plan = plan_transcription(p, [job], overwrite=False, unattended=False)
    assert plan.run == [job] and not plan.adopted


def test_legacy_transcript_with_matching_cache_is_adopted(job, tmp_path):
    p = _project(_tr(), workspace=str(tmp_path))
    sha = sha256_file(job.audio)
    _cache_files(p, f"host_{'a' * 16}.json", f"host_{sha[:16]}.json")
    plan = plan_transcription(p, [job], overwrite=False, unattended=True)
    assert plan.reused == [job] and plan.adopted == [job.key]


def test_legacy_edited_transcript_with_stale_caches_is_refused_unattended(job, tmp_path):
    p = _project(_tr(user_edited=True), workspace=str(tmp_path))
    _cache_files(p, f"host_{'a' * 16}.json")
    with pytest.raises(TranscriptOverwriteRefused, match="audio changed"):
        plan_transcription(p, [job], overwrite=False, unattended=True)


def test_matching_size_and_mtime_skip_hashing(job, monkeypatch):
    st = job.audio.stat()
    p = _project(_tr(audio_sha256="f" * 64, audio_size=st.st_size, audio_mtime_ns=st.st_mtime_ns))

    def no_hash(_path):
        raise AssertionError("hashed")

    monkeypatch.setattr("podcast_mcp.edits.transcript_reuse.sha256_file", no_hash)
    plan = plan_transcription(p, [job], overwrite=False, unattended=True)
    assert plan.reused == [job] and plan.audio_hashes[job.key] == "f" * 64


def test_changed_mtime_rehashes_and_restamps(job):
    st = job.audio.stat()
    p = _project(
        _tr(
            audio_sha256=sha256_file(job.audio),
            audio_size=st.st_size,
            audio_mtime_ns=st.st_mtime_ns - 1,
        )
    )
    plan = plan_transcription(p, [job], overwrite=False, unattended=True)
    assert plan.reused == [job]
    stamp_audio_identity(p, plan)
    assert p.transcripts[0].audio_mtime_ns == st.st_mtime_ns


def test_changed_audio_edited_is_refused_unattended_with_reason(job):
    p = _project(_tr(audio_sha256="0" * 64, user_edited=True))
    with pytest.raises(TranscriptOverwriteRefused, match="audio changed") as err:
        plan_transcription(p, [job], overwrite=False, unattended=True)
    assert "host" in str(err.value) and "Batch mode" in str(err.value)


def test_changed_audio_edited_attended_reruns_and_reports(job):
    p = _project(_tr(audio_sha256="0" * 64, user_edited=True))
    plan = plan_transcription(p, [job], overwrite=False, unattended=False)
    assert plan.run == [job] and plan.overwrite_edited == ["host"]


def test_allow_edited_overwrites_in_unattended_run(job):
    p = _project(_tr(audio_sha256=sha256_file(job.audio), user_edited=True))
    plan = plan_transcription(p, [job], overwrite=True, unattended=True, allow_edited=True)
    assert plan.run == [job] and plan.overwrite_edited == ["host"]
