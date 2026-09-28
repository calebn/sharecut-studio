from __future__ import annotations

import json
import sys
import wave
from itertools import pairwise
from types import SimpleNamespace

import numpy as np
import pytest

from ctc_fakes import HI_BYE_HOT, HI_BYE_TOKENS, FakeBackend
from podcast_mcp.engines.ctc_forced_align import CtcVocab
from podcast_mcp.engines.word_align import (
    OnnxCtcBackend,
    WordAligner,
    apply_word_spans,
)
from podcast_mcp.models.episode import TranscriptWord
from podcast_mcp.word_aligner_models import WordAlignerMissingError, word_aligner_model


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


def test_word_aligner_load_uses_env_dir_and_vocab(tmp_path, monkeypatch) -> None:
    model_dir = tmp_path / "snapshot"
    (model_dir / "onnx").mkdir(parents=True)
    (model_dir / "vocab.json").write_text(json.dumps(HI_BYE_TOKENS))
    (model_dir / "onnx" / "model.onnx").write_bytes(b"")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(model_dir))
    fake, _sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)

    aligner = WordAligner.load()

    assert aligner.model.id == "onnx-base"
    assert aligner.supports_language("en")
    assert aligner.supports_language(None)
    assert not aligner.supports_language("de")
    assert aligner.cache_identity()["revision"] == aligner.model.revision


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
