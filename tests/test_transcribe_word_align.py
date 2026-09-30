from __future__ import annotations

import json
import wave
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines.asr_options import AsrOptions, ForcedAlignment
from podcast_mcp.engines.ctc_forced_align import RetimeStats
from podcast_mcp.engines.transcribe import (
    TranscribeJob,
    TranscriptionEngine,
    cached_audio_keys,
    forced_alignment_succeeded,
)
from podcast_mcp.engines.word_align import WordAlignResult
from podcast_mcp.models import Transcript, TranscriptWord, load_project
from podcast_mcp.word_aligner_models import WordAlignerMissingError, word_aligner_model
from two_mic_project import two_mic_project


@pytest.mark.parametrize(
    ("entry", "expected"),
    [
        ({"status": "aligned", "aligned_words": 3}, True),
        ({"status": "cached", "aligned_words": 1}, True),
        ({"status": "aligned", "aligned_words": 0}, False),
        ({"status": "failed", "aligned_words": 0}, False),
        ({"status": "skipped", "aligned_words": 0}, False),
        ({"label": "Track host"}, False),
    ],
)
def test_forced_alignment_succeeded(entry, expected) -> None:
    assert forced_alignment_succeeded(entry) is expected


def _options(enabled: bool = True, **kwargs) -> AsrOptions:
    """Engine options with forced alignment resolved as if the model were installed (or off)."""
    return AsrOptions(forced_alignment=ForcedAlignment(requested=enabled, installed=True), **kwargs)


class StubAligner:
    def __init__(self, spans, n_aligned, n_unaligned, scores=None):
        self.model = word_aligner_model()
        self.calls = 0
        self._spans = spans
        self._stats = RetimeStats(1, 0, n_aligned, n_unaligned)
        self._scores = (
            tuple(scores)
            if scores is not None
            else tuple(None if s is None else 0.9 for s in spans)
        )

    def supports_language(self, language):
        return (language or "en") == "en"

    def cache_identity(self):
        return {"model": "stub"}

    def align(self, audio_path, words):
        self.calls += 1
        return WordAlignResult(list(self._spans), self._stats, 0.01, self._scores)


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
    engine = TranscriptionEngine(options=_options(forced_alignment_enabled))

    def _fresh_asr(*args, **kwargs):
        return Transcript(
            track_id="",
            language=language,
            words=[TranscriptWord(text=w[0], start=w[1], end=w[2]) for w in words],
        )

    patcher = patch.object(engine, "transcribe_file", side_effect=_fresh_asr)
    return proj, job, engine, patcher


HI_BYE_WORDS = [("hi", 0.0, 0.5), ("bye", 0.5, 1.0)]


def test_fresh_alignment_keeps_own_speech_under_a_wrong_track_placement(tmp_workspace):
    project = two_mic_project(tmp_workspace, host_timeline_start=1.0)
    engine = TranscriptionEngine(options=_options(silence_filter_enabled=False))
    engine._word_aligner = StubAligner([(0.70, 0.72)], n_aligned=1, n_unaligned=0, scores=[0.0])
    job = TranscribeJob(track_id="host", source_id=None, audio=tmp_workspace / "raw/host.wav")
    transcript = Transcript(
        track_id="host", words=[TranscriptWord(text="real", start=0.70, end=0.72)]
    )

    with patch.object(engine, "transcribe_file", return_value=transcript):
        result = engine.transcribe_job(project, job, language="en", use_cache=False)

    assert result.words[0].text == "real"
    assert result.words[0].alignment_score == 0.0
    assert result.words[0].suspect_hallucination is False
    assert engine.forced_alignment_jobs[0]["no_evidence_words"] == 0


def test_disabled_by_default_never_loads_the_aligner(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(
        minimal_project, tmp_path, words=HI_BYE_WORDS, forced_alignment_enabled=False
    )
    with patcher, patch("podcast_mcp.engines.word_align.WordAligner.load") as load:
        load.side_effect = AssertionError("should not load when disabled")
        tr = engine.transcribe_job(proj, job, language="en")

    assert [(w.start, w.end) for w in tr.words] == [(0.0, 0.5), (0.5, 1.0)]
    assert tr.word_aligner is None
    assert engine.forced_alignment_jobs == []
    assert not list(proj.transcripts_dir().glob("*.word_align_*.json"))


def test_enabled_retimes_words_but_asr_cache_keeps_whisper_times(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = stub

    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")

    assert [(w.start, w.end) for w in tr.words] == [(0.1, 0.3), (0.6, 0.9)]
    assert tr.word_aligner == "onnx-base"

    from podcast_mcp.util.hashing import sha256_file

    sha = sha256_file(job.audio)
    asr_cache = engine.cache_path(proj, job.cache_id, job.audio, language="en", audio_sha256=sha)
    cached = Transcript.model_validate_json(asr_cache.read_text(encoding="utf-8"))
    assert [(w.start, w.end) for w in cached.words] == [(0.0, 0.5), (0.5, 1.0)]
    assert cached.word_aligner is None

    align_files = list(proj.transcripts_dir().glob("*.word_align_*.json"))
    assert len(align_files) == 1
    assert align_files[0].name.startswith(asr_cache.stem)

    assert engine.forced_alignment_jobs[0]["status"] == "aligned"
    assert engine.forced_alignment_jobs[0]["aligned_words"] == 2
    assert engine.forced_alignment_jobs[0]["unaligned_words"] == 0


def test_align_sec_recorded_on_fresh_run_only(minimal_project, tmp_path):
    """#715: a fresh alignment records align_sec; a cache hit or a failure does not."""
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = stub

    with patcher:
        engine.transcribe_job(proj, job, language="en", use_cache=True)
        assert engine.forced_alignment_jobs[-1]["status"] == "aligned"
        assert engine.forced_alignment_jobs[-1]["align_sec"] == 0.01

        engine.transcribe_job(proj, job, language="en", use_cache=True)
        assert engine.forced_alignment_jobs[-1]["status"] == "cached"
        assert "align_sec" not in engine.forced_alignment_jobs[-1]

        engine._word_aligner = RaisingAligner([], n_aligned=0, n_unaligned=0)
        engine.transcribe_job(proj, job, language="en", use_cache=False)
        assert engine.forced_alignment_jobs[-1]["status"] == "failed"
        assert "align_sec" not in engine.forced_alignment_jobs[-1]


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


def test_alignment_scores_are_stored_and_reused_from_cache(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0, scores=(0.8, 0.002))
    engine._word_aligner = stub

    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")

    assert [w.alignment_score for w in tr.words] == [0.8, 0.002]

    from podcast_mcp.util.hashing import sha256_file

    sha = sha256_file(job.audio)
    asr_cache = engine.cache_path(proj, job.cache_id, job.audio, language="en", audio_sha256=sha)
    align_files = list(proj.transcripts_dir().glob("*.word_align_*.json"))
    assert len(align_files) == 1
    body = json.loads(align_files[0].read_text(encoding="utf-8"))
    assert body["scores"] == [0.8, 0.002]
    assert align_files[0].name.startswith(asr_cache.stem)

    with patcher:
        tr2 = engine.transcribe_job(proj, job, language="en")
    assert stub.calls == 1
    assert engine.forced_alignment_jobs[-1]["status"] == "cached"
    assert [w.alignment_score for w in tr2.words] == [0.8, 0.002]


def test_failed_alignment_leaves_no_scores(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    engine._word_aligner = RaisingAligner([], n_aligned=0, n_unaligned=2)

    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")

    assert [w.alignment_score for w in tr.words] == [None, None]


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


def test_missing_model_keeps_whisper_times_and_loads_once_per_engine(
    minimal_project, tmp_path, caplog
):
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
        assert tr.word_aligner is None
        entry = engine.forced_alignment_jobs[0]
        assert entry["status"] == "failed"
        assert "podcast bootstrap --component word-aligner" in entry["reason"]
        assert any("keeping Whisper timestamps" in r.message for r in caplog.records)

        engine.transcribe_job(proj, job, language="en")
        assert load.call_count == 1
        assert engine.forced_alignment_jobs[1]["status"] == "failed"

        fresh = TranscriptionEngine(options=_options())
        with patch.object(
            fresh,
            "transcribe_file",
            return_value=Transcript(
                track_id="", words=[TranscriptWord(text="hi", start=0.0, end=0.5)]
            ),
        ):
            fresh.transcribe_job(proj, job, language="en")
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


def _host_track_with_tone_then_silence(proj, wav):
    """The project's host track is `wav`: a 440 Hz tone for 0.5 s over a -70 dBFS noise
    bed, then the bed alone (below the silence filter's -60 dBFS peak floor)."""
    from podcast_mcp.models import MediaAsset, Track, TrackRole

    n = 16000
    t = np.arange(n) / 16000
    samples = np.random.default_rng(780).normal(0.0, 10 ** (-70 / 20), n)
    samples[: n // 2] += 0.3 * np.sin(2 * np.pi * 440 * t[: n // 2])
    with wave.open(str(wav), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(np.round(np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(wav)),
        )
    ]


def test_no_evidence_word_is_flagged_and_counted(minimal_project, tmp_path):
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    _host_track_with_tone_then_silence(proj, job.audio)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0, scores=(0.8, 0.002))
    engine._word_aligner = stub

    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")

    assert tr.words[0].suspect_hallucination is False
    assert tr.words[1].suspect_hallucination is True
    assert engine.forced_alignment_jobs[0]["no_evidence_words"] == 1


def test_low_score_on_spoken_audio_is_not_counted_as_no_evidence(minimal_project, tmp_path):
    """#780: "hi" scores 0.002 but sits in the tone, so it is neither flagged nor counted."""
    proj, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    _host_track_with_tone_then_silence(proj, job.audio)
    stub = StubAligner([(0.1, 0.3), (0.35, 0.45)], n_aligned=2, n_unaligned=0, scores=(0.002, 0.9))
    engine._word_aligner = stub

    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")

    assert [w.suspect_hallucination for w in tr.words] == [False, False]
    assert engine.forced_alignment_jobs[0]["no_evidence_words"] == 0


def test_min_word_score_zero_never_flags_or_counts(minimal_project, tmp_path):
    proj = load_project(minimal_project)
    wav = tmp_path / "clip.wav"
    _write_wav(wav)
    job = TranscribeJob(track_id="host", source_id=None, audio=wav)
    engine = TranscriptionEngine(options=_options(forced_alignment_min_word_score=0.0))

    def _fresh_asr(*args, **kwargs):
        return Transcript(
            track_id="",
            language="en",
            words=[TranscriptWord(text=w[0], start=w[1], end=w[2]) for w in HI_BYE_WORDS],
        )

    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0, scores=(0.8, 0.002))
    engine._word_aligner = stub

    with patch.object(engine, "transcribe_file", side_effect=_fresh_asr):
        tr = engine.transcribe_job(proj, job, language="en")

    assert [w.suspect_hallucination for w in tr.words] == [False, False]
    assert "no_evidence_words" not in engine.forced_alignment_jobs[0]


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
    [
        '{"',
        '{"spans": [[0.1, 0.3]]}',
        '{"spans": [[0.3, 0.1], null]}',
        '{"spans": [[0.1, 0.3], [0.6, 0.9]]}',
        '{"spans": [[0.1, 0.3], [0.6, 0.9]], "scores": [1.5, 0.5]}',
        '{"spans": [null, [0.6, 0.9]], "scores": [0.5, 0.5]}',
    ],
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
    assert tr.word_aligner is None
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
    from podcast_mcp.models import Track

    canonical = asr_cache.with_name(f"{asr_cache.stem}.word_align_{'1' * 16}.json")
    proj.tracks.append(Track(id=canonical.stem, label="Cache-shaped track"))
    canonical.write_text("preserve")
    stale.write_text("{}", encoding="utf-8")
    other.write_text("{}", encoding="utf-8")

    with patcher:
        engine.transcribe_job(proj, job, language="en")

    assert not stale.exists()
    assert other.exists()
    assert canonical.read_text() == "preserve"
    assert len(list(asr_cache.parent.glob(f"{asr_cache.stem}.word_align_*.json"))) == 2


def test_read_asr_cache_hits_current_name_and_misses(minimal_project, tmp_path):
    from podcast_mcp.util.hashing import sha256_file

    proj = load_project(minimal_project)
    wav = tmp_path / "clip.wav"
    _write_wav(wav)
    job = TranscribeJob(track_id="host", source_id=None, audio=wav)
    engine = TranscriptionEngine()

    def _fresh_asr(*args, **kwargs):
        return Transcript(
            track_id="",
            language="en",
            words=[TranscriptWord(text=w[0], start=w[1], end=w[2]) for w in HI_BYE_WORDS],
        )

    sha = sha256_file(wav)
    with patch.object(engine, "transcribe_file", side_effect=_fresh_asr):
        engine.transcribe_job(proj, job, language="en", audio_sha256=sha)

    cache, hit = engine.read_asr_cache(
        proj, job, language="en", initial_prompt=None, audio_sha256=sha
    )
    assert hit is not None
    assert [(w.start, w.end) for w in hit.words] == [(0.0, 0.5), (0.5, 1.0)]

    # A different prompt selects a different cache key: a miss.
    _, miss = engine.read_asr_cache(
        proj, job, language="en", initial_prompt="vocabulary hint", audio_sha256=sha
    )
    assert miss is None

    cache.unlink()
    _, miss = engine.read_asr_cache(proj, job, language="en", initial_prompt=None, audio_sha256=sha)
    assert miss is None


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


def test_alignment_finishing_after_asr_eviction_keeps_result_without_orphan_cache(
    minimal_project, tmp_path
):
    project, job, engine, patcher = _setup(minimal_project, tmp_path, words=HI_BYE_WORDS)
    stub = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    engine._word_aligner = stub
    original_align = stub.align
    newer = TranscriptionEngine(options=_options(False))

    def align(audio, words):
        with patch.object(newer, "transcribe_file", return_value=Transcript(track_id="", words=[])):
            newer.transcribe_job(project, job, language="en", initial_prompt="newer")
            newer.transcribe_job(project, job, language="en", initial_prompt="newest")
        return original_align(audio, words)

    stub.align = align
    with patcher:
        result = engine.transcribe_job(project, job, language="en")
    assert [(w.start, w.end) for w in result.words] == [(0.1, 0.3), (0.6, 0.9)]
    assert engine.forced_alignment_jobs[0]["status"] == "aligned"
    assert len(list(project.transcripts_dir().glob("host_*_*.json"))) == 2
    assert not list(project.transcripts_dir().glob("*.word_align_*.json"))
