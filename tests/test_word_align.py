from __future__ import annotations

import json
import sys
import wave
from collections.abc import Generator
from itertools import pairwise
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from ctc_fakes import HI_BYE_HOT, HI_BYE_TOKENS, FakeBackend, RecordingBackend
from model_pin_helpers import pin_word_aligner_to_fake_snapshot
from pcm_fakes import FakeStreamEngine
from podcast_mcp.engines.audio_audit import load_mono_full
from podcast_mcp.engines.ctc_forced_align import (
    ALIGNMENT_SCORE_METHOD,
    SAMPLE_RATE_WAV2VEC2,
    CtcVocab,
    retime_spans,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.word_align import (
    OnnxCtcBackend,
    WordAligner,
    apply_word_spans,
)
from podcast_mcp.models.episode import TranscriptWord
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.word_aligner_models import (
    WordAlignerMissingError,
    WordAlignerPinMismatchError,
    word_aligner_model,
)


def test_onnx_backend_names_missing_onnxruntime(monkeypatch, tmp_path) -> None:
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    with pytest.raises(RuntimeError, match="onnxruntime"):
        OnnxCtcBackend(tmp_path / "m.onnx")


class _FakeSession:
    def __init__(self, path, opts, providers) -> None:
        self.opts = opts
        self.feed = None

    def get_inputs(self):
        return [SimpleNamespace(name="input_values")]

    def run(self, output_names, feed):
        self.feed = feed
        return [np.zeros((1, 5, 4))]


def _fake_onnxruntime():
    sessions: list[_FakeSession] = []

    def make_session(path, opts, providers):
        session = _FakeSession(path, opts, providers)
        sessions.append(session)
        return session

    fake = SimpleNamespace(SessionOptions=lambda: SimpleNamespace(), InferenceSession=make_session)
    return fake, sessions


def test_onnx_backend_normalizes_input_and_returns_log_probs(monkeypatch, tmp_path) -> None:
    fake, sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)

    backend = OnnxCtcBackend(tmp_path / "m.onnx", threads=2)
    out = backend.log_probs(np.arange(100, dtype=np.float32))

    session = sessions[0]
    feed_value = session.feed["input_values"]
    assert feed_value.shape == (1, 100)
    assert feed_value.dtype == np.float32
    assert feed_value.mean() == pytest.approx(0.0, abs=1e-4)
    assert session.opts.intra_op_num_threads == 2
    assert np.exp(out).sum(axis=1) == pytest.approx(np.ones(5))


def _snapshot(root, onnx_bytes: bytes = b""):
    (root / "onnx").mkdir(parents=True)
    (root / "vocab.json").write_text(json.dumps(HI_BYE_TOKENS))
    (root / "onnx" / "model.onnx").write_bytes(onnx_bytes)
    return root


def test_word_aligner_load_uses_env_dir_and_vocab(tmp_path, monkeypatch) -> None:
    model_dir = _snapshot(tmp_path / "snapshot")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(model_dir))
    fake, _sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)

    aligner = WordAligner.load()

    assert aligner.model.id == "onnx-base"
    assert aligner.supports_language("en")
    assert aligner.supports_language(None)
    assert not aligner.supports_language("de")
    assert aligner.cache_identity()["revision"] == aligner.model.revision
    assert aligner.cache_identity()["local_source"]["dir"] == str(model_dir.resolve())
    assert aligner.cache_identity()["score"] == ALIGNMENT_SCORE_METHOD


def test_word_aligner_load_without_model_raises_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")

    with pytest.raises(WordAlignerMissingError):
        WordAligner.load()


def test_word_aligner_align_decodes_audio_and_retimes(tmp_path) -> None:
    wav_path = tmp_path / "clip.wav"
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\x00\x00" * round(1.2 * 16000))

    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)
    aligner = WordAligner(word_aligner_model(), backend, vocab)
    words = [
        TranscriptWord(text="hi", start=0.0, end=0.5),
        TranscriptWord(text="42", start=0.5, end=0.7),
        TranscriptWord(text="bye", start=0.7, end=1.2),
    ]

    result = aligner.align(wav_path, words)

    assert result.spans[0] == pytest.approx((0.0, 0.04))
    assert result.spans[1] is None
    assert result.spans[2] == pytest.approx((0.08, 0.14))
    assert result.stats.aligned_words == 2
    assert result.runtime_sec >= 0


def test_word_aligner_align_returns_one_score_per_placed_word(tmp_path) -> None:
    wav_path = tmp_path / "clip.wav"
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\x00\x00" * round(1.2 * 16000))

    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)
    aligner = WordAligner(word_aligner_model(), backend, vocab)
    words = [
        TranscriptWord(text="hi", start=0.0, end=0.5),
        TranscriptWord(text="42", start=0.5, end=0.7),
        TranscriptWord(text="bye", start=0.7, end=1.2),
    ]

    result = aligner.align(wav_path, words)

    assert len(result.scores) == len(result.spans)
    for span, score in zip(result.spans, result.scores, strict=True):
        assert (span is None) == (score is None)


def test_word_aligner_align_streams_the_decode_once(monkeypatch, tmp_path) -> None:
    def _boom(*args, **kwargs):
        raise AssertionError("align() must not decode the whole file up front")

    monkeypatch.setattr("podcast_mcp.engines.audio_audit.load_mono_full", _boom)

    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)
    aligner = WordAligner(word_aligner_model(), backend, vocab)
    words = [
        TranscriptWord(text="hi", start=0.0, end=0.5),
        TranscriptWord(text="42", start=0.5, end=0.7),
        TranscriptWord(text="bye", start=0.7, end=1.2),
    ]
    samples = np.zeros(round(1.2 * SAMPLE_RATE_WAV2VEC2), dtype=np.float32)
    fake = FakeStreamEngine(samples, SAMPLE_RATE_WAV2VEC2)

    result = aligner.align(tmp_path / "clip.wav", words, engine=fake)

    assert fake.calls == 1
    assert fake.closed

    expected_spans, expected_stats = retime_spans(
        samples, [(w.text, w.start, w.end) for w in words], backend, vocab
    )
    assert result.spans == expected_spans
    assert result.stats == expected_stats


def test_word_aligner_align_over_real_ffmpeg_stream_matches_whole_file_decode(tmp_path) -> None:
    # Small real-ffmpeg chunks so windows straddle chunk boundaries; the backend must
    # see exactly the samples the old whole-file load_mono_full decode gave it.
    sr = SAMPLE_RATE_WAV2VEC2
    rng = np.random.default_rng(11)
    pcm = (rng.standard_normal(round(12.0 * sr)) * 3000).clip(-32768, 32767).astype("<i2")
    wav_path = tmp_path / "noise.wav"
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        handle.writeframes(pcm.tobytes())

    words = [TranscriptWord(text="hi", start=t, end=t + 0.3) for t in (0.2, 2.5, 4.8, 7.1, 9.4)]
    words.append(TranscriptWord(text="bye", start=11.8, end=12.6))  # straddles EOF
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)

    class SmallChunkFFmpeg(FFmpegEngine):
        def stream_mono_f32(
            self, path: Path, *, sample_rate: int, chunk_frames: int = 1_001
        ) -> Generator[np.ndarray, None, None]:
            return super().stream_mono_f32(path, sample_rate=sample_rate, chunk_frames=chunk_frames)

    stream_backend = RecordingBackend(FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7))
    result = WordAligner(word_aligner_model(), stream_backend, vocab).align(
        wav_path, words, engine=SmallChunkFFmpeg()
    )

    legacy_backend = RecordingBackend(FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7))
    legacy_spans, legacy_stats = retime_spans(
        load_mono_full(wav_path, sample_rate=sr),
        [(w.text, w.start, w.end) for w in words],
        legacy_backend,
        vocab,
    )

    assert result.spans == legacy_spans
    assert result.stats == legacy_stats
    assert len(stream_backend.calls) == len(legacy_backend.calls) > 1
    for streamed, legacy in zip(stream_backend.calls, legacy_backend.calls, strict=True):
        np.testing.assert_array_equal(streamed, legacy)


def test_word_aligner_align_closes_the_stream_when_the_backend_raises(tmp_path) -> None:
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)

    class ExplodingBackend:
        def log_probs(self, samples: np.ndarray) -> np.ndarray:
            raise RuntimeError("boom")

    aligner = WordAligner(word_aligner_model(), ExplodingBackend(), vocab)
    words = [TranscriptWord(text="hi", start=0.0, end=0.5)]
    samples = np.zeros(round(1.0 * SAMPLE_RATE_WAV2VEC2), dtype=np.float32)
    fake = FakeStreamEngine(samples, SAMPLE_RATE_WAV2VEC2)

    with pytest.raises(RuntimeError, match="boom"):
        aligner.align(tmp_path / "clip.wav", words, engine=fake)

    assert fake.closed


def test_word_aligner_reuses_one_default_ffmpeg_engine(monkeypatch, tmp_path) -> None:
    samples = np.zeros(round(1.2 * SAMPLE_RATE_WAV2VEC2), dtype=np.float32)
    fake = FakeStreamEngine(samples, SAMPLE_RATE_WAV2VEC2)
    built: list[FakeStreamEngine] = []

    def factory() -> FakeStreamEngine:
        built.append(fake)
        return fake

    monkeypatch.setattr("podcast_mcp.engines.word_align.FFmpegEngine", factory)
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    aligner = WordAligner(
        word_aligner_model(), FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7), vocab
    )
    words = [TranscriptWord(text="hi", start=0.0, end=0.5)]

    aligner.align(tmp_path / "a.wav", words)
    aligner.align(tmp_path / "b.wav", words)

    assert len(built) == 1
    assert fake.calls == 2


def test_word_aligner_align_raises_on_empty_decode(tmp_path) -> None:
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)
    aligner = WordAligner(word_aligner_model(), backend, vocab)
    fake = FakeStreamEngine(np.zeros(0, dtype=np.float32), SAMPLE_RATE_WAV2VEC2)

    words = [TranscriptWord(text="hi", start=0.0, end=0.5)]
    with pytest.raises(NoAudioDecodedError, match="no audio decoded from"):
        aligner.align(tmp_path / "clip.wav", words, engine=fake)

    # No words: an empty decode is not an error, and the result is empty.
    result = aligner.align(
        tmp_path / "clip.wav",
        [],
        engine=FakeStreamEngine(np.zeros(0, dtype=np.float32), SAMPLE_RATE_WAV2VEC2),
    )
    assert result.spans == []


def test_word_aligner_align_short_decode_keeps_whisper_times(tmp_path) -> None:
    # Truncated media: 0.1 s decoded, words at 5-6.3 s. Not an error; the window
    # past EOF is too short for the model and counts as failed.
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)
    aligner = WordAligner(word_aligner_model(), backend, vocab)
    fake = FakeStreamEngine(
        np.zeros(round(0.1 * SAMPLE_RATE_WAV2VEC2), dtype=np.float32), SAMPLE_RATE_WAV2VEC2
    )
    words = [
        TranscriptWord(text="hi", start=5.0, end=5.5),
        TranscriptWord(text="bye", start=6.0, end=6.3),
    ]

    result = aligner.align(tmp_path / "clip.wav", words, engine=fake)

    assert result.spans == [None, None]
    assert result.stats.windows == 1
    assert result.stats.failed_windows == 1
    assert result.stats.aligned_words == 0
    assert result.stats.unaligned_words == 2
    assert fake.closed


def test_apply_word_spans_keeps_unaligned_and_clears_deferred_only_when_retimed() -> None:
    words = [
        TranscriptWord(text="a", start=0.0, end=5.0, audibility_status="deferred"),
        TranscriptWord(text="b", start=5.0, end=9.0, audibility_status="deferred"),
    ]
    spans: list[tuple[float, float] | None] = [(0.1, 0.3), None]

    retimed = apply_word_spans(words, spans)

    assert retimed == 1
    assert words[0].start == pytest.approx(0.1)
    assert words[0].end == pytest.approx(0.3)
    assert words[0].audibility_status is None
    assert words[1].start == pytest.approx(5.0)
    assert words[1].end == pytest.approx(9.0)
    assert words[1].audibility_status == "deferred"


def test_apply_word_spans_sets_scores_only_on_placed_words() -> None:
    words = [
        TranscriptWord(text="a", start=0.0, end=5.0),
        TranscriptWord(text="b", start=5.0, end=9.0, alignment_score=0.3),
    ]
    spans: list[tuple[float, float] | None] = [(0.0, 0.5), None]

    apply_word_spans(words, spans, [0.7, None])

    assert words[0].alignment_score == pytest.approx(0.7)
    assert words[1].alignment_score is None


def test_apply_word_spans_rejects_score_length_mismatch() -> None:
    words = [TranscriptWord(text="a", start=0.0, end=0.5)]
    with pytest.raises(ValueError, match="words/scores"):
        apply_word_spans(words, [(0.0, 0.5)], [0.5, 0.6])


def test_apply_word_spans_rejects_length_mismatch() -> None:
    words = [TranscriptWord(text="a", start=0.0, end=0.5)]
    with pytest.raises(ValueError, match="length mismatch"):
        apply_word_spans(words, [])


def _monotonic(words):
    return all(a.end <= b.start for a, b in pairwise(words))


def test_apply_word_spans_clamps_unaligned_word_between_aligned_neighbours() -> None:
    words = [
        TranscriptWord(text="hi", start=0.0, end=0.5),
        TranscriptWord(text="1990", start=0.5, end=0.9),
        TranscriptWord(text="bye", start=0.9, end=1.2),
    ]
    assert apply_word_spans(words, [(0.0, 0.6), None, (0.8, 1.1)]) == 2
    assert (words[1].start, words[1].end) == pytest.approx((0.6, 0.8))
    assert words[1].audibility_status is None
    assert _monotonic(words)


def test_apply_word_spans_flags_collapsed_unaligned_word_deferred() -> None:
    words = [
        TranscriptWord(text="hi", start=0.0, end=0.5),
        TranscriptWord(text="1990", start=0.5, end=0.9),
        TranscriptWord(text="bye", start=0.9, end=1.2),
    ]
    apply_word_spans(words, [(0.0, 0.95), None, (1.0, 1.1)])
    assert (words[1].start, words[1].end) == pytest.approx((0.95, 0.95))
    assert words[1].audibility_status == "deferred"
    assert _monotonic(words)


def test_apply_word_spans_clamps_runs_and_leaves_open_edges() -> None:
    words = [
        TranscriptWord(text="a", start=0.0, end=0.4),
        TranscriptWord(text="$5", start=0.4, end=0.8),
        TranscriptWord(text="%", start=0.8, end=1.0),
        TranscriptWord(text="b", start=1.0, end=1.5),
        TranscriptWord(text="42", start=1.5, end=2.0),
    ]
    apply_word_spans(words, [(0.0, 0.5), None, None, (0.9, 1.4), None])
    assert [(w.start, w.end) for w in words] == pytest.approx(
        [(0.0, 0.5), (0.5, 0.8), (0.8, 0.9), (0.9, 1.4), (1.5, 2.0)]
    )
    assert _monotonic(words)


def test_apply_word_spans_overlapping_aligned_neighbours_collapse_kept_word() -> None:
    words = [
        TranscriptWord(text="hi", start=0.0, end=0.5),
        TranscriptWord(text="1990", start=0.5, end=0.9),
        TranscriptWord(text="bye", start=0.9, end=1.2),
    ]
    apply_word_spans(words, [(0.0, 0.7), None, (0.6, 1.1)])
    assert (words[1].start, words[1].end) == pytest.approx((0.7, 0.7))
    assert words[1].audibility_status == "deferred"


def test_apply_word_spans_real_decode_keeps_unencodable_word_monotonic(tmp_path) -> None:
    wav_path = tmp_path / "clip.wav"
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\x00\x00" * round(1.2 * 16000))

    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)
    aligner = WordAligner(word_aligner_model(), backend, vocab)
    words = [
        TranscriptWord(text="hi", start=0.0, end=0.5),
        TranscriptWord(text="42", start=0.5, end=0.7),
        TranscriptWord(text="bye", start=0.7, end=1.2),
    ]

    result = aligner.align(wav_path, words)
    apply_word_spans(words, result.spans)

    assert _monotonic(words)
    assert words[1].start == pytest.approx(0.08)
    assert words[1].end == pytest.approx(0.08)
    assert words[1].audibility_status == "deferred"


def test_override_snapshot_changes_cache_identity_and_key(
    tmp_path, monkeypatch, minimal_project
) -> None:
    from podcast_mcp.engines.transcribe import TranscriptionEngine
    from podcast_mcp.models import load_project
    from podcast_mcp.models.episode import TranscriptWord as _TranscriptWord

    fake, _sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)
    words = [_TranscriptWord(text="hi", start=0.0, end=0.5)]
    proj = load_project(minimal_project)
    engine = TranscriptionEngine()
    asr_cache = proj.transcripts_dir() / "host_0000000000000000_1111111111111111.json"

    keys = []
    for name in ("a", "b"):
        monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(_snapshot(tmp_path / name)))
        aligner = WordAligner.load()
        assert aligner.cache_identity()["local_source"]["dir"].endswith(name)
        keys.append(engine.word_align_cache_path(proj, "host", asr_cache, aligner, words))
    assert keys[0] != keys[1]


def test_pinned_snapshot_cache_identity_has_no_local_source(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    monkeypatch.setattr(
        "podcast_mcp.engines.word_align.resolve_word_aligner_dir",
        lambda _id: _snapshot(tmp_path / "pinned"),
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.word_align.verify_word_aligner_snapshot",
        lambda d, m, **k: None,
    )
    fake, _sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)

    assert "local_source" not in WordAligner.load().cache_identity()


def test_pinned_snapshot_load_rejects_sha256_mismatch(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    monkeypatch.setattr(
        "podcast_mcp.engines.word_align.resolve_word_aligner_dir",
        lambda _id: _snapshot(tmp_path / "pinned"),
    )
    monkeypatch.setattr("podcast_mcp.util.model_manifest.sha256_file", lambda p: "0" * 64)
    fake, _sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)

    with pytest.raises(WordAlignerMissingError, match="sha256"):
        WordAligner.load()


def test_pinned_snapshot_load_rejects_a_tampered_vocab_json(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    snap = pin_word_aligner_to_fake_snapshot(tmp_path / "pinned", monkeypatch)
    (snap / "vocab.json").write_bytes(b"tampered")
    monkeypatch.setattr("podcast_mcp.engines.word_align.resolve_word_aligner_dir", lambda _id: snap)
    fake, sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)

    with pytest.raises(WordAlignerPinMismatchError, match=r"vocab\.json"):
        WordAligner.load()
    assert sessions == []


def test_override_load_does_not_hash_the_onnx_file(tmp_path, monkeypatch) -> None:
    model_dir = _snapshot(tmp_path / "snapshot")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(model_dir))

    def _boom(p):
        raise AssertionError("override dirs are not hashed")

    monkeypatch.setattr("podcast_mcp.util.model_manifest.sha256_file", _boom)
    fake, _sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)

    aligner = WordAligner.load()
    assert aligner.cache_identity()["local_source"]["dir"] == str(model_dir.resolve())
