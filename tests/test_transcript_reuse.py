from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.transcript_reuse import (
    TranscribePlan,
    TranscriptOverwriteRefused,
    merge_transcripts_by_key,
    needs_retime,
    plan_retime,
    plan_transcription,
    refresh_reused_silence_flags,
    run_transcribe_plan,
    stamp_audio_identity,
)
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.transcribe import TranscribeJob
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.word_aligner_models import word_aligner_model


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


def test_run_transcribe_plan_without_jobs_only_stamps(job):
    p = _project(_tr())
    plan = plan_transcription(p, [job], overwrite=False, unattended=True)

    def no_engine():
        raise AssertionError("engine must not be built when nothing runs")

    assert run_transcribe_plan(p, plan, no_engine, use_cache=True) == []
    assert p.transcripts[0].audio_sha256 == sha256_file(job.audio)


def test_run_transcribe_plan_forwards_stamps_and_merges(job, tmp_path, caplog):
    from unittest.mock import MagicMock

    from podcast_mcp.transcript_context import TranscriptContext

    other = Transcript(track_id="guest", words=[])
    p = _project(
        _tr(audio_sha256=sha256_file(job.audio), user_edited=True),
        other,
        workspace=str(tmp_path),
    )
    p.workspace_path().mkdir(parents=True, exist_ok=True)
    TranscriptContext(terms=["Kaczynski"], vocabulary_revision="rev-1").save(p.workspace_path())
    plan = plan_transcription(p, [job], overwrite=True, unattended=False)
    engine = MagicMock()
    engine.transcribe_all_dialogue.return_value = [
        Transcript(track_id="host", words=[TranscriptWord(text="asr", start=0, end=0.5)])
    ]
    with caplog.at_level("WARNING"):
        out = run_transcribe_plan(p, plan, lambda: engine, use_cache=False, language="en")
    kwargs = engine.transcribe_all_dialogue.call_args.kwargs
    assert kwargs["jobs"] == [job] and kwargs["audio_hashes"] == plan.audio_hashes
    assert kwargs["use_cache"] is False and kwargs["language"] == "en"
    assert "Kaczynski" in kwargs["initial_prompt"]
    assert [t.vocabulary_revision for t in out] == ["rev-1"]
    keys = {t.key: t for t in p.transcripts}
    assert keys[("host", None)].words[0].text == "asr"
    assert keys[("guest", None)] is other
    assert "overwrites edited transcript for track host" in caplog.text


def test_needs_retime_truth_table(job):
    model = word_aligner_model()
    assert needs_retime(_tr(), model)
    assert not needs_retime(Transcript(track_id="host", words=[]), model)
    assert not needs_retime(_tr(language="de"), model)
    # Re-timed before scores existed (#195): no word has alignment_score yet.
    assert needs_retime(_tr(word_aligner=model.id), model)
    scored = _tr(word_aligner=model.id)
    scored.words[0].alignment_score = 0.9
    assert not needs_retime(scored, model)


def test_refresh_reused_silence_flags_keeps_evidence_flags(job, monkeypatch):
    from podcast_mcp.engines import asr_silence

    transcript = _tr()
    transcript.words[0].alignment_score = 0.001
    transcript.silence_filter_fingerprint = None
    p, plan = _reused_plan(job, transcript)

    monkeypatch.setattr(asr_silence, "flag_silent_words_in_file", lambda *a, **k: 0)

    skipped = refresh_reused_silence_flags(p, plan, AsrOptions())

    assert skipped == []
    assert transcript.words[0].suspect_hallucination is True
    assert transcript.silence_filter_fingerprint is not None


class _FakeEngine:
    """A stand-in for ``TranscriptionEngine.read_asr_cache`` in ``plan_retime`` tests."""

    def __init__(self, cached: Transcript | None) -> None:
        self.cached = cached
        self.calls = 0

    def read_asr_cache(self, project, job, *, language, initial_prompt, audio_sha256):
        self.calls += 1
        return (job.audio, self.cached)


def _reused_plan(job, *transcripts: Transcript) -> tuple[EpisodeProject, TranscribePlan]:
    p = _project(*transcripts)
    plan = TranscribePlan(overwrite=False, reused=[job], audio_hashes={job.key: "sha"})
    return p, plan


def test_plan_retime_moves_a_cached_unedited_job_to_run(job):
    cached = Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0, end=0.5)])
    p, plan = _reused_plan(job, _tr())
    engine = _FakeEngine(cached)
    plan_retime(p, plan, engine, language="en", allow_edited=False)
    assert plan.run == [job]
    assert plan.retime == [job]
    assert plan.reused == []
    assert plan.overwrite_edited == []


def test_plan_retime_skips_edited_without_confirmation(job):
    p, plan = _reused_plan(job, _tr(user_edited=True))
    engine = _FakeEngine(Transcript(track_id="host", words=[]))
    plan_retime(p, plan, engine, language="en", allow_edited=False)
    assert plan.reused == [job]
    assert plan.run == []
    assert plan.retime_skipped_edited == [job.label]
    assert engine.calls == 0


def test_plan_retime_moves_edited_job_with_allow_edited(job):
    cached = Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0, end=0.5)])
    p, plan = _reused_plan(job, _tr(user_edited=True))
    engine = _FakeEngine(cached)
    plan_retime(p, plan, engine, language="en", allow_edited=True)
    assert plan.run == [job]
    assert plan.retime == [job]
    assert plan.overwrite_edited == [job.track_id]


def test_plan_retime_reports_missing_asr_cache(job):
    p, plan = _reused_plan(job, _tr())
    engine = _FakeEngine(None)
    plan_retime(p, plan, engine, language="en", allow_edited=False)
    assert plan.reused == [job]
    assert plan.run == []
    assert plan.retime_skipped_no_cache == [job.label]


def test_plan_retime_never_probes_jobs_that_do_not_need_it(job):
    model = word_aligner_model()
    already_scored = _tr(word_aligner=model.id)
    already_scored.words[0].alignment_score = 0.9

    class _RaisingEngine(_FakeEngine):
        def read_asr_cache(self, *a, **k):
            raise AssertionError("read_asr_cache must not run when re-timing is not needed")

    for transcript in (
        Transcript(track_id="host", words=[]),
        _tr(language="de"),
        already_scored,
    ):
        p, plan = _reused_plan(job, transcript)
        plan_retime(p, plan, _RaisingEngine(None), language="en", allow_edited=False)
        assert plan.reused == [job]
        assert plan.run == []


def test_plan_retime_context_is_reused_by_run_transcribe_plan(job, monkeypatch):
    from unittest.mock import MagicMock

    from podcast_mcp.transcript_context import TranscriptContext

    calls = []
    ctx = TranscriptContext()

    def fake_load(workspace_path):
        calls.append(workspace_path)
        return ctx

    monkeypatch.setattr("podcast_mcp.edits.transcript_reuse.load_transcript_context", fake_load)

    cached = Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0, end=0.5)])
    p, plan = _reused_plan(job, _tr())
    engine = _FakeEngine(cached)
    plan_retime(p, plan, engine, language="en", allow_edited=False)
    plan.audio_stats[job.key] = (0, 0)

    stub = MagicMock()
    stub.transcribe_all_dialogue.return_value = []
    run_transcribe_plan(p, plan, lambda: stub, use_cache=True, language="en")

    assert len(calls) == 1
    assert plan.context is ctx
    assert (
        stub.transcribe_all_dialogue.call_args.kwargs["initial_prompt"]
        == plan.context.initial_prompt_text()
    )
