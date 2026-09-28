from __future__ import annotations

import wave
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.ctc_forced_align import RetimeStats
from podcast_mcp.engines.transcribe import TranscribeJob, TranscriptionEngine, cached_audio_keys
from podcast_mcp.engines.word_align import WordAlignResult
from podcast_mcp.models import Transcript, TranscriptWord, load_project
from podcast_mcp.word_aligner_models import WordAlignerMissingError, word_aligner_model


class StubAligner:
    def __init__(self, spans, n_aligned, n_unaligned):
        self.model = word_aligner_model()
        self.calls = 0
        self._spans = spans
        self._stats = RetimeStats(1, 0, n_aligned, n_unaligned)

    def supports_language(self, language):
        return (language or "en") == "en"

    def cache_identity(self):
        return {"model": "stub"}

    def align(self, audio_path, words):
        self.calls += 1
        return WordAlignResult(list(self._spans), self._stats, 0.01)


class RaisingAligner(StubAligner):
    def align(self, audio_path, words):
        self.calls += 1
        raise RuntimeError("decode")


def _write_wav(path, *, duration_sec: float = 1.0, sample_rate: int = 16000) -> None:
    n = round(duration_sec * sample_rate)
    t = np.arange(n) / sample_rate
    tone = np.round(0.3 * 32767 * np.sin(2 * np.pi * 440 * t)).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sample_rate)
        f.writeframes(tone.tobytes())


def _setup(
    minimal_project,
    tmp_path,
    *,
    words,
    duration_sec: float = 1.0,
    language: str = "en",
    forced_alignment_enabled: bool = True,
):
    proj = load_project(minimal_project)
    wav = tmp_path / "clip.wav"
    _write_wav(wav, duration_sec=duration_sec)
    job = TranscribeJob(track_id="host", source_id=None, audio=wav)
    engine = TranscriptionEngine(
        options=AsrOptions(forced_alignment_enabled=forced_alignment_enabled)
    )

    def _fresh_asr(*args, **kwargs):
        return Transcript(
            track_id="",
            language=language,
            words=[TranscriptWord(text=w[0], start=w[1], end=w[2]) for w in words],
        )

    patcher = patch.object(engine, "transcribe_file", side_effect=_fresh_asr)
    return proj, job, engine, patcher


HI_BYE_WORDS = [("hi", 0.0, 0.5), ("bye", 0.5, 1.0)]


def test_disabled_by_default_never_loads_the_aligner(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(
        minimal_project, tmp_path, words=HI_BYE_WORDS, forced_alignment_enabled=False
    )
    with patcher, patch("podcast_mcp.engines.word_align.WordAligner.load") as load:
        load.side_effect = AssertionError("should not load when disabled")
        tr = engine.transcribe_job(proj, job, language="en")

    assert [(w.start, w.end) for w in tr.words] == [(0.0, 0.5), (0.5, 1.0)]
    assert engine.forced_alignment_jobs == []
    assert not list(proj.transcripts_dir().glob("*.word_align_*.json"))


def test_enabled_retimes_words_but_asr_cache_keeps_whisper_times(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = stub

    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")

    assert [(w.start, w.end) for w in tr.words] == [(0.1, 0.3), (0.6, 0.9)]

    from podcast_mcp.util.hashing import sha256_file

    sha = sha256_file(job.audio)
    asr_cache = engine.cache_path(proj, job.cache_id, job.audio, language="en", audio_sha256=sha)
    cached = Transcript.model_validate_json(asr_cache.read_text(encoding="utf-8"))
    assert [(w.start, w.end) for w in cached.words] == [(0.0, 0.5), (0.5, 1.0)]

    align_files = list(proj.transcripts_dir().glob("*.word_align_*.json"))
    assert len(align_files) == 1
    assert align_files[0].name.startswith(asr_cache.stem)

    assert engine.forced_alignment_jobs[0]["status"] == "aligned"
    assert engine.forced_alignment_jobs[0]["aligned_words"] == 2
    assert engine.forced_alignment_jobs[0]["unaligned_words"] == 0


def test_second_run_reuses_alignment_cache_and_use_cache_false_realigns(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = stub

    with patcher:
        engine.transcribe_job(proj, job, language="en", use_cache=True)
        tr2 = engine.transcribe_job(proj, job, language="en", use_cache=True)
        assert stub.calls == 1
        assert engine.forced_alignment_jobs[-1]["status"] == "cached"
        assert [(w.start, w.end) for w in tr2.words] == [(0.1, 0.3), (0.6, 0.9)]

        engine.transcribe_job(proj, job, language="en", use_cache=False)
        assert stub.calls == 2
        assert engine.forced_alignment_jobs[-1]["status"] == "aligned"


def test_stretched_word_is_undeferred_only_when_aligned(minimal_project, tmp_path):
    from podcast_mcp.engines.transcribe import flag_anomalous_asr_durations

    words = [("long", 0.0, 5.0), ("longer", 5.0, 9.0)]
    proj, job, engine, _patcher = _setup(minimal_project, tmp_path, words=words, duration_sec=10.0)
    stub = StubAligner([(0.2, 0.6), None], n_aligned=1, n_unaligned=1)
    engine._word_aligner = stub

    # transcribe_file is patched, so pre-flag as the real transcribe_file does.
    def _fresh_asr(*args, **kwargs):
        tr = Transcript(
            track_id="",
            language="en",
            words=[TranscriptWord(text=w[0], start=w[1], end=w[2]) for w in words],
        )
        flag_anomalous_asr_durations(tr.words)
        return tr

    with patch.object(engine, "transcribe_file", side_effect=_fresh_asr):
        tr = engine.transcribe_job(proj, job, language="en")

    assert tr.words[0].audibility_status is None
    assert tr.words[0].start == pytest.approx(0.2)
    assert tr.words[0].end == pytest.approx(0.6)
    assert tr.words[1].audibility_status == "deferred"
    assert tr.words[1].start == pytest.approx(5.0)
    assert tr.words[1].end == pytest.approx(9.0)


def test_missing_model_keeps_whisper_times_and_reports(minimal_project, tmp_path, caplog):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)

    with (
        patcher,
        patch(
            "podcast_mcp.engines.word_align.WordAligner.load",
            side_effect=WordAlignerMissingError("onnx-base"),
        ) as load,
        caplog.at_level("WARNING"),
    ):
        tr = engine.transcribe_job(proj, job, language="en")
        assert [(w.start, w.end) for w in tr.words] == [(0.0, 0.5), (0.5, 1.0)]
        entry = engine.forced_alignment_jobs[0]
        assert entry["status"] == "failed"
        assert "podcast bootstrap --component word-aligner" in entry["reason"]
        assert any("keeping Whisper timestamps" in r.message for r in caplog.records)

        engine.transcribe_job(proj, job, language="en")
        assert load.call_count == 2


def test_align_error_keeps_whisper_times_and_writes_no_alignment_cache(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = RaisingAligner([], n_aligned=0, n_unaligned=2)
    engine._word_aligner = stub

    with patcher:
        from podcast_mcp.util.hashing import sha256_file

        sha = sha256_file(job.audio)
        engine.transcribe_job(proj, job, language="en")
        assert engine.forced_alignment_jobs[0]["status"] == "failed"
        assert not list(proj.transcripts_dir().glob("*.word_align_*.json"))
        assert cached_audio_keys(proj, job.cache_id) == {sha[:16]}

    engine2_stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = engine2_stub
    with patcher:
        engine.transcribe_job(proj, job, language="en", use_cache=False)
    assert cached_audio_keys(proj, job.cache_id) == {sha[:16]}


def test_non_english_transcript_is_skipped(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(
        minimal_project, tmp_path, words=HI_BYE_WORDS, language="de"
    )
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = stub

    with patcher:
        tr = engine.transcribe_job(proj, job, language="de")

    assert [(w.start, w.end) for w in tr.words] == [(0.0, 0.5), (0.5, 1.0)]
    assert engine.forced_alignment_jobs[0]["status"] == "skipped"
    assert stub.calls == 0


@pytest.mark.parametrize(
    "cache_body",
    ['{"', '{"spans": [[0.1, 0.3]]}', '{"spans": [[0.3, 0.1], null]}'],
)
def test_corrupt_or_mismatched_alignment_cache_is_a_miss(minimal_project, tmp_path, cache_body):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = stub

    with patcher:
        from podcast_mcp.util.hashing import sha256_file

        sha = sha256_file(job.audio)
        asr_cache = engine.cache_path(
            proj, job.cache_id, job.audio, language="en", audio_sha256=sha
        )
        words = [TranscriptWord(text=w[0], start=w[1], end=w[2]) for w in HI_BYE_WORDS]
        align_path = engine.word_align_cache_path(proj, job.cache_id, asr_cache, stub, words)
        align_path.parent.mkdir(parents=True, exist_ok=True)
        align_path.write_text(cache_body, encoding="utf-8")

        engine.transcribe_job(proj, job, language="en")

    assert stub.calls == 1
    assert engine.forced_alignment_jobs[0]["status"] == "aligned"


def test_zero_aligned_words_counts_as_failed(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([None, None], n_aligned=0, n_unaligned=2)
    engine._word_aligner = stub

    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")

    assert [(w.start, w.end) for w in tr.words] == [(0.0, 0.5), (0.5, 1.0)]
    entry = engine.forced_alignment_jobs[0]
    assert entry["status"] == "failed"
    assert entry["reason"] == "no words aligned"


def test_alignment_cache_write_failure_still_retimes(minimal_project, tmp_path, caplog):
    from podcast_mcp.engines import transcribe as transcribe_mod

    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    engine._word_aligner = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    real_write = transcribe_mod.write_text_atomic

    def flaky_write(path, text, **kwargs):
        if ".word_align_" in path.name:
            raise OSError(28, "No space left on device")
        return real_write(path, text, **kwargs)

    with (
        patcher,
        patch.object(transcribe_mod, "write_text_atomic", side_effect=flaky_write),
        caplog.at_level("WARNING"),
    ):
        tr = engine.transcribe_job(proj, job, language="en")

    assert [(w.start, w.end) for w in tr.words] == [(0.1, 0.3), (0.6, 0.9)]
    assert engine.forced_alignment_jobs[0]["status"] == "aligned"
    assert not list(proj.transcripts_dir().glob("*.word_align_*.json"))
    assert any("could not update word-alignment cache" in r.message for r in caplog.records)


def test_new_alignment_prunes_stale_sidecars_of_the_same_asr_cache(minimal_project, tmp_path):
    from podcast_mcp.util.hashing import sha256_file

    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    engine._word_aligner = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    sha = sha256_file(job.audio)
    asr_cache = engine.cache_path(proj, job.cache_id, job.audio, language="en", audio_sha256=sha)
    asr_cache.parent.mkdir(parents=True, exist_ok=True)
    stale = asr_cache.with_name(f"{asr_cache.stem}.word_align_{'0' * 16}.json")
    other = asr_cache.with_name(f"guest_{'1' * 16}_{'2' * 16}.word_align_{'0' * 16}.json")
    stale.write_text("{}", encoding="utf-8")
    other.write_text("{}", encoding="utf-8")

    with patcher:
        engine.transcribe_job(proj, job, language="en")

    assert not stale.exists()
    assert other.exists()
    assert len(list(asr_cache.parent.glob(f"{asr_cache.stem}.word_align_*.json"))) == 1


def test_cancel_before_alignment_raises_without_aligning(minimal_project, tmp_path):
    from podcast_mcp.util.progress import CancelledProgress
    from podcast_mcp.util.project_state import render_cancel_scope

    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = stub
    calls = iter([False, True])  # the per-job loop check passes, the alignment check cancels
    with patcher, render_cancel_scope(lambda: next(calls)), pytest.raises(CancelledProgress):
        engine.transcribe_all_dialogue(proj, jobs=[job], language="en")
    assert stub.calls == 0


def test_cancel_stops_the_per_job_loop_before_asr(minimal_project, tmp_path):
    from podcast_mcp.util.progress import CancelledProgress
    from podcast_mcp.util.project_state import render_cancel_scope

    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    with patcher as asr, render_cancel_scope(lambda: True), pytest.raises(CancelledProgress):
        engine.transcribe_all_dialogue(proj, jobs=[job], language="en")
    asr.assert_not_called()
