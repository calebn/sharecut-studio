from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.transcript_correct import correct_word
from podcast_mcp.edits.transcript_reuse import (
    TranscribePlan,
    TranscriptOverwriteRefused,
    merge_transcripts_by_key,
    needs_retime,
    plan_retime,
    plan_transcription,
    refresh_reused_silence_flags,
    refresh_settled_silence_flags,
    run_transcribe_plan,
    stamp_audio_identity,
)
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import silence_filter_fingerprint
from podcast_mcp.engines.ctc_forced_align import ALIGNMENT_SCORE_METHOD
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


def test_run_transcribe_plan_warns_when_primer_truncates_saved_vocabulary(job, tmp_path, caplog):
    from unittest.mock import MagicMock

    from podcast_mcp.transcript_context import TranscriptContext

    p = _project(workspace=str(tmp_path))
    p.workspace_path().mkdir(parents=True, exist_ok=True)
    # 380 chars of vocabulary fit under the old (unprimed) 400-char budget but not
    # alongside the new punctuation primer (#769).
    TranscriptContext(terms=["a" * 380]).save(p.workspace_path())
    plan = plan_transcription(p, [job], overwrite=True, unattended=False)
    engine = MagicMock()
    engine.transcribe_all_dialogue.return_value = []

    with caplog.at_level("WARNING"):
        run_transcribe_plan(p, plan, lambda: engine, use_cache=False, language="en")

    assert "drops saved vocabulary" in caplog.text


def test_run_transcribe_plan_does_not_warn_when_vocabulary_fits(job, tmp_path, caplog):
    from unittest.mock import MagicMock

    from podcast_mcp.transcript_context import TranscriptContext

    p = _project(workspace=str(tmp_path))
    p.workspace_path().mkdir(parents=True, exist_ok=True)
    TranscriptContext(terms=["Kaczynski"]).save(p.workspace_path())
    plan = plan_transcription(p, [job], overwrite=True, unattended=False)
    engine = MagicMock()
    engine.transcribe_all_dialogue.return_value = []

    with caplog.at_level("WARNING"):
        run_transcribe_plan(p, plan, lambda: engine, use_cache=False, language="en")

    assert "drops saved vocabulary" not in caplog.text


def test_needs_retime_truth_table(job):
    model = word_aligner_model()
    assert needs_retime(_tr(), model)
    assert not needs_retime(Transcript(track_id="host", words=[]), model)
    assert not needs_retime(_tr(language="de"), model)
    # Re-timed before scores existed (#195): no score method recorded.
    assert needs_retime(_tr(word_aligner=model.id), model)
    scored = _tr(word_aligner=model.id, alignment_score_method=ALIGNMENT_SCORE_METHOD)
    scored.words[0].alignment_score = 0.9
    assert not needs_retime(scored, model)
    # A bumped score definition re-scores stored transcripts.
    stale = _tr(word_aligner=model.id, alignment_score_method="mean_emitting_posterior_v0")
    stale.words[0].alignment_score = 0.9
    assert needs_retime(stale, model)


class _FixedEvidence:
    def __init__(self, speech: bool) -> None:
        self.speech = speech
        self.builds = 0

    def has_speech(self, track_id: str, start: float, end: float) -> bool:
        return self.speech

    def fingerprint_term(self, track_id: str) -> str:
        del track_id
        return "own"


@pytest.mark.parametrize("speech", [False, True])
def test_refresh_reused_silence_flags_keeps_evidence_flags(job, monkeypatch, speech):
    """A reused low-score word is re-flagged through the #780 gate: only when its own
    track carries no speech there."""
    from podcast_mcp.engines import asr_silence

    transcript = _tr()
    transcript.words[0].alignment_score = 0.001
    transcript.silence_filter_fingerprint = None
    p, plan = _reused_plan(job, transcript)

    monkeypatch.setattr(asr_silence, "flag_silent_words_in_file", lambda *a, **k: 0)
    evidence = _FixedEvidence(speech)

    def build(cls, project, options, *, bleed_check):
        assert bleed_check is False
        evidence.builds += 1
        return evidence

    monkeypatch.setattr(asr_silence.SpeechLevels, "for_project", classmethod(build))

    skipped = refresh_reused_silence_flags(p, plan, AsrOptions())

    assert skipped == []
    assert evidence.builds == 1
    assert transcript.words[0].suspect_hallucination is (not speech)
    assert transcript.silence_filter_fingerprint is not None


def _scored_two_mic(tmp_workspace, *, host_timeline_start: float = 0.0):
    """The two-mic project with a stored, aligner-scored host transcript: a real word
    (0.70-0.72 s), the guest's bleed (1.6-1.9 s) and a silent span (2.5-2.6 s), all
    scoring below the evidence floor."""
    from two_mic_project import two_mic_project

    project = two_mic_project(tmp_workspace, host_timeline_start=host_timeline_start)
    words = [
        TranscriptWord(text="um", start=0.70, end=0.72, alignment_score=0.0),
        TranscriptWord(text="yeah", start=1.6, end=1.9, alignment_score=0.003),
        TranscriptWord(text="so", start=2.5, end=2.6, alignment_score=0.0),
    ]
    host = Transcript(
        track_id="host",
        words=words,
        word_aligner="onnx-base",
        alignment_score_method=ALIGNMENT_SCORE_METHOD,
        audio_sha256=sha256_file(tmp_workspace / "raw" / "host.wav"),
    )
    project.transcripts = [host]
    return project, host


def _flags(transcript):
    return [w.suspect_hallucination for w in transcript.words]


def test_transcribe_time_reflag_does_not_flag_a_real_word_under_a_wrong_placement(
    tmp_workspace,
):
    """#780 lane (c): host placed 1.0 s late so its real word sits under the guest's line."""
    project, host = _scored_two_mic(tmp_workspace, host_timeline_start=1.0)
    job = TranscribeJob("host", None, tmp_workspace / "raw" / "host.wav")
    plan = TranscribePlan(overwrite=False, reused=[job], audio_hashes={job.key: host.audio_sha256})
    options = AsrOptions(silence_filter_enabled=False)

    assert refresh_reused_silence_flags(project, plan, options) == []
    assert _flags(host) == [False, False, True]
    own_fp = host.silence_filter_fingerprint
    from podcast_mcp.engines.asr_silence import evidence_term

    assert own_fp == silence_filter_fingerprint(
        host.words,
        host.audio_sha256,
        options,
        evidence=evidence_term(project, "host", bleed_check=False),
    )

    # The same run again is a no-op: the own-scope fingerprint matches.
    assert refresh_reused_silence_flags(project, plan, options) == []
    assert host.silence_filter_fingerprint == own_fp


def test_settled_reflag_reads_placement_and_fixing_it_reflags(tmp_workspace):
    """#780 lane (c): the full gate on a wrong placement flags the real word; fixing the
    placement re-flags and clears it, and a correct placement gives the true bleed flags."""
    from podcast_mcp.engines.asr_silence import evidence_term

    project, host = _scored_two_mic(tmp_workspace, host_timeline_start=1.0)
    options = AsrOptions(silence_filter_enabled=False)

    skipped, reflagged = refresh_settled_silence_flags(project, options)
    assert (skipped, reflagged) == ([], 1)
    assert _flags(host) == [True, False, True]
    wrong_fp = host.silence_filter_fingerprint
    assert wrong_fp == silence_filter_fingerprint(
        host.words,
        host.audio_sha256,
        options,
        evidence=evidence_term(project, "host", bleed_check=True),
    )
    assert refresh_settled_silence_flags(project, options) == ([], 0)

    project.clips[0].timeline_start = 0.0
    assert refresh_settled_silence_flags(project, options) == ([], 1)
    assert _flags(host) == [False, True, True]
    assert host.silence_filter_fingerprint != wrong_fp

    # A later transcribe-time refresh keeps reconcile's bleed flag: the settled fingerprint
    # on the current placement is accepted there too.
    job = TranscribeJob("host", None, tmp_workspace / "raw" / "host.wav")
    plan = TranscribePlan(overwrite=False, reused=[job], audio_hashes={job.key: host.audio_sha256})
    assert refresh_reused_silence_flags(project, plan, options) == []
    assert _flags(host) == [False, True, True]


def test_settled_reflag_tracks_selected_peer_media_revision_once(tmp_workspace):
    from podcast_mcp.models import Clip, SourceRecording
    from two_mic_project import SR, write_wav

    project, host = _scored_two_mic(tmp_workspace)
    extra_path = tmp_workspace / "raw" / "extra.wav"
    write_wav(extra_path, np.zeros(3 * SR, dtype=np.float32))
    project.sources = [SourceRecording(id="extra", path="raw/extra.wav", duration_sec=3.0)]
    project.clips = [clip for clip in project.clips if clip.track_id != "guest"]
    project.clips.append(
        Clip(
            id="guest-extra",
            track_id="guest",
            source_id="extra",
            source_start=1.5,
            source_end=2.0,
            timeline_start=0.5,
        )
    )
    options = AsrOptions(silence_filter_enabled=False)

    assert refresh_settled_silence_flags(project, options) == ([], 1)
    assert _flags(host) == [False, False, True]
    write_wav(extra_path, np.full(3 * SR, 0.1, dtype=np.float32))
    assert refresh_settled_silence_flags(project, options) == ([], 1)
    assert _flags(host) == [True, False, True]
    assert refresh_settled_silence_flags(project, options) == ([], 0)


def test_reused_reflag_tracks_own_gain_and_reuses_unchanged_evidence(tmp_workspace, monkeypatch):
    from podcast_mcp.edits import transcript_reuse

    project, host = _scored_two_mic(tmp_workspace)
    job = TranscribeJob("host", None, tmp_workspace / "raw" / "host.wav")
    plan = TranscribePlan(overwrite=False, reused=[job], audio_hashes={job.key: host.audio_sha256})
    options = AsrOptions(silence_filter_enabled=False)
    refresh_count = 0
    refresh = transcript_reuse.refresh_silence_flags

    def count_refresh(*args, **kwargs):
        nonlocal refresh_count
        refresh_count += 1
        return refresh(*args, **kwargs)

    monkeypatch.setattr(transcript_reuse, "refresh_silence_flags", count_refresh)

    assert refresh_reused_silence_flags(project, plan, options) == []
    assert refresh_count == 1
    assert refresh_reused_silence_flags(project, plan, options) == []
    assert refresh_count == 1

    project.track_by_id("host").gain_db = 25.0
    assert refresh_reused_silence_flags(project, plan, options) == []
    assert refresh_count == 2
    assert _flags(host) == [False, False, False]
    assert refresh_reused_silence_flags(project, plan, options) == []
    assert refresh_count == 2


def test_settled_reflag_tracks_peer_gain_and_reuses_unchanged_evidence(tmp_workspace):
    project, host = _scored_two_mic(tmp_workspace)
    options = AsrOptions(silence_filter_enabled=False)

    assert refresh_settled_silence_flags(project, options) == ([], 1)
    assert _flags(host) == [False, True, True]
    assert refresh_settled_silence_flags(project, options) == ([], 0)

    project.track_by_id("guest").gain_db = -20.0
    assert refresh_settled_silence_flags(project, options) == ([], 1)
    assert _flags(host) == [False, False, True]
    assert refresh_settled_silence_flags(project, options) == ([], 0)


def test_unchanged_undecodable_selected_peer_media_does_not_refresh_again(
    tmp_workspace, monkeypatch
):
    from podcast_mcp.engines.asr_silence import TrackEnergy
    from podcast_mcp.models import Clip, SourceRecording

    project, _host = _scored_two_mic(tmp_workspace)
    extra_path = tmp_workspace / "raw" / "extra.wav"
    extra_path.write_bytes(b"not audio")
    project.sources = [SourceRecording(id="extra", path="raw/extra.wav", duration_sec=3.0)]
    project.clips = [clip for clip in project.clips if clip.track_id != "guest"]
    project.clips.append(
        Clip(
            id="guest-extra",
            track_id="guest",
            source_id="extra",
            source_start=1.5,
            source_end=2.0,
            timeline_start=1.5,
        )
    )
    calls = 0
    decode = TrackEnergy.decode

    def count_selected_decode(cls, path, **kwargs):
        nonlocal calls
        if path.name == "extra.wav":
            calls += 1
        return decode(path, **kwargs)

    monkeypatch.setattr(TrackEnergy, "decode", classmethod(count_selected_decode))
    options = AsrOptions(silence_filter_enabled=False)

    assert refresh_settled_silence_flags(project, options) == ([], 1)
    assert calls == 1
    assert refresh_settled_silence_flags(project, options) == ([], 0)
    assert calls == 1


def test_settled_reflag_skips_unscored_and_hashless_transcripts(tmp_workspace):
    project, host = _scored_two_mic(tmp_workspace)
    for w in host.words:
        w.alignment_score = None
    options = AsrOptions(silence_filter_enabled=False)
    assert refresh_settled_silence_flags(project, options) == ([], 1)
    assert _flags(host) == [False, False, False]
    assert refresh_settled_silence_flags(project, options) == ([], 0)

    host.audio_sha256 = None
    host.silence_filter_fingerprint = None
    assert refresh_settled_silence_flags(project, options) == ([], 0)


def test_corrected_silence_flag_is_rechecked_via_fingerprint(job, monkeypatch):
    from podcast_mcp.engines import asr_silence

    options = AsrOptions()
    transcript = _tr()  # one word 'hi' at 0-0.5 s, no alignment_score
    transcript.words[0].suspect_hallucination = True  # set by the silence filter alone
    p, plan = _reused_plan(job, transcript)
    transcript.silence_filter_fingerprint = silence_filter_fingerprint(
        transcript.words, plan.audio_hashes[job.key], options
    )

    correct_word(p, "host", 0, "hello")
    word = p.transcripts[0].words[0]
    assert word.suspect_hallucination is False and word.alignment_score is None
    assert transcript.silence_filter_fingerprint != silence_filter_fingerprint(
        transcript.words, plan.audio_hashes[job.key], options
    )

    # Digital silence under the word: the refresh re-flags it.
    monkeypatch.setattr(
        asr_silence, "peak_envelope", lambda path: (np.zeros(8000, dtype=np.float32), 8000.0)
    )
    assert refresh_reused_silence_flags(p, plan, options) == []
    assert word.suspect_hallucination is True
    assert transcript.silence_filter_fingerprint == silence_filter_fingerprint(
        transcript.words, plan.audio_hashes[job.key], options
    )


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
    already_scored = _tr(word_aligner=model.id, alignment_score_method=ALIGNMENT_SCORE_METHOD)
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


def test_run_transcribe_plan_reuses_fallback_prompt_when_cache_still_present(job, tmp_path):
    """A fallback job whose cache is still on disk at run time keeps the old prompt (#769)."""
    from unittest.mock import MagicMock

    from podcast_mcp.transcript_context import DEFAULT_PROMPT_PRIMER, TranscriptContext

    p = _project(workspace=str(tmp_path))
    p.workspace_path().mkdir(parents=True, exist_ok=True)
    TranscriptContext(terms=["Kaczynski"]).save(p.workspace_path())
    plan = TranscribePlan(
        overwrite=False,
        run=[job],
        retime_fallback=[job],
        audio_hashes={job.key: "sha"},
        audio_stats={job.key: (0, 0)},
    )
    engine = MagicMock()
    engine.read_asr_cache.return_value = (job.audio, object())
    engine.transcribe_all_dialogue.return_value = []

    run_transcribe_plan(p, plan, lambda: engine, use_cache=True, language="en")

    assert engine.read_asr_cache.call_args.kwargs["initial_prompt"] == "Kaczynski"
    engine.transcribe_all_dialogue.assert_called_once()
    kwargs = engine.transcribe_all_dialogue.call_args.kwargs
    assert kwargs["jobs"] == [job]
    assert kwargs["initial_prompt"] == "Kaczynski"
    assert DEFAULT_PROMPT_PRIMER not in kwargs["initial_prompt"]


def test_run_transcribe_plan_falls_back_to_primed_prompt_when_cache_evicted(job, tmp_path):
    """A fallback job whose cache disappeared between planning and running (#804): a real
    decode must use the current primed prompt, not the pre-primer one (would recreate #769).
    """
    from unittest.mock import MagicMock

    from podcast_mcp.transcript_context import DEFAULT_PROMPT_PRIMER, TranscriptContext

    p = _project(workspace=str(tmp_path))
    p.workspace_path().mkdir(parents=True, exist_ok=True)
    TranscriptContext(terms=["Kaczynski"]).save(p.workspace_path())
    plan = TranscribePlan(
        overwrite=False,
        run=[job],
        retime_fallback=[job],
        audio_hashes={job.key: "sha"},
        audio_stats={job.key: (0, 0)},
    )
    engine = MagicMock()
    engine.read_asr_cache.return_value = (job.audio, None)  # evicted since plan_retime ran
    engine.transcribe_all_dialogue.return_value = []

    run_transcribe_plan(p, plan, lambda: engine, use_cache=True, language="en")

    engine.transcribe_all_dialogue.assert_called_once()
    kwargs = engine.transcribe_all_dialogue.call_args.kwargs
    assert kwargs["jobs"] == [job]
    assert kwargs["initial_prompt"] == f"{DEFAULT_PROMPT_PRIMER} Kaczynski"


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


def test_transcribe_run_keeps_prompt_revision_snapshot_during_vocabulary_save(job, tmp_path):
    from unittest.mock import MagicMock

    from podcast_mcp.transcript_context import DEFAULT_PROMPT_PRIMER, TranscriptContext

    project = _project(workspace=str(tmp_path))
    TranscriptContext(terms=["Original"], vocabulary_revision="old").save(tmp_path)
    plan = plan_transcription(project, [job], overwrite=True, unattended=False)
    engine = MagicMock()

    def decode(*args, **kwargs):
        TranscriptContext(terms=["Changed"], vocabulary_revision="new").save(tmp_path)
        assert kwargs["initial_prompt"] == f"{DEFAULT_PROMPT_PRIMER} Original"
        return [Transcript(track_id="host", words=[])]

    engine.transcribe_all_dialogue.side_effect = decode
    result = run_transcribe_plan(project, plan, lambda: engine, use_cache=True, language="en")
    assert result[0].vocabulary_revision == "old"
