"""Opt-in CTC forced-alignment pass over Whisper's words (#714).

Re-times Whisper's word boundaries with a local wav2vec2 CTC aligner
(``word_aligner_models.WORD_ALIGNER_CATALOG``). Words the aligner cannot
place keep Whisper's times — this module never invents a boundary.
``align`` streams the 16 kHz decode once, forward-only, through
``FFmpegEngine.stream_mono_f32`` + ``util.pcm_stream.SequentialWindowReader``
rather than holding the whole track in memory (#730).
"""

from __future__ import annotations

import contextlib
import json
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.engines.ctc_forced_align import (
    ALIGNMENT_SCORE_METHOD,
    DEFAULT_MAX_GAP_SEC,
    DEFAULT_MAX_WINDOW_SEC,
    DEFAULT_PAD_SEC,
    SAMPLE_RATE_WAV2VEC2,
    CtcVocab,
    LogProbBackend,
    RetimeStats,
    log_softmax,
    normalize_waveform,
    place_spans_stream,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models.episode import TranscriptWord
from podcast_mcp.util.dsp import clamp
from podcast_mcp.util.pcm_stream import NoAudioDecodedError, SequentialWindowReader
from podcast_mcp.word_aligner_models import (
    DEFAULT_WORD_ALIGNER,
    WordAlignerModel,
    resolve_word_aligner_dir,
    verify_word_aligner_snapshot,
    word_aligner_model,
    word_aligner_override_dir,
)

# The #641 measurement setting.
DEFAULT_ALIGNER_THREADS = 4


class OnnxCtcBackend:
    def __init__(self, model_path: Path, *, threads: int = DEFAULT_ALIGNER_THREADS) -> None:
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError(
                "word alignment needs onnxruntime (a core dependency): run uv sync"
            ) from exc

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        self._session = ort.InferenceSession(
            str(model_path), opts, providers=["CPUExecutionProvider"]
        )
        self._input_name = self._session.get_inputs()[0].name

    def log_probs(self, samples: np.ndarray) -> np.ndarray:
        feed = {self._input_name: normalize_waveform(samples)[None, :].astype(np.float32)}
        return log_softmax(self._session.run(None, feed)[0][0])


@dataclass(frozen=True)
class WordAlignResult:
    spans: list[tuple[float, float] | None]
    stats: RetimeStats
    runtime_sec: float
    # One per word, None when not placed; empty = no scores (test stubs).
    scores: tuple[float | None, ...] = ()


class WordAligner:
    def __init__(
        self,
        model: WordAlignerModel,
        backend: LogProbBackend,
        vocab: CtcVocab,
        *,
        local_source: dict[str, Any] | None = None,
    ) -> None:
        self.model = model
        self._backend = backend
        self._vocab = vocab
        # Set when PODCAST_MCP_WORD_ALIGNER_MODEL loaded a local dir instead of the pinned snapshot.
        self._local_source = local_source
        # Built on the first align() without engine=, then reused (one aligner per run).
        self._default_engine: FFmpegEngine | None = None

    @classmethod
    def load(
        cls, model_id: str = DEFAULT_WORD_ALIGNER, *, threads: int | None = None
    ) -> WordAligner:
        model = word_aligner_model(model_id)
        model_dir = resolve_word_aligner_dir(model.id)
        onnx_path = model_dir / model.onnx_file
        local_source: dict[str, Any] | None = None
        if word_aligner_override_dir() is not None:
            stat = onnx_path.stat()
            local_source = {
                "dir": str(model_dir.resolve()),
                "onnx_size": stat.st_size,
                "onnx_mtime_ns": stat.st_mtime_ns,
            }
        else:
            # User-supplied override dirs are not the pinned bytes; only the pinned
            # snapshot is verified, every file (#728).
            verify_word_aligner_snapshot(model_dir, model)
        vocab = CtcVocab.from_token_map(
            json.loads((model_dir / "vocab.json").read_text(encoding="utf-8"))
        )
        backend = OnnxCtcBackend(
            onnx_path,
            threads=threads or min(DEFAULT_ALIGNER_THREADS, os.cpu_count() or 1),
        )
        return cls(model, backend, vocab, local_source=local_source)

    def supports_language(self, language: str | None) -> bool:
        return self.model.supports_language(language)

    def cache_identity(self) -> dict[str, Any]:
        identity: dict[str, Any] = {
            "model": self.model.id,
            "repo": self.model.hf_repo,
            "revision": self.model.revision,
            "onnx_file": self.model.onnx_file,
            "max_gap_sec": DEFAULT_MAX_GAP_SEC,
            "max_window_sec": DEFAULT_MAX_WINDOW_SEC,
            "pad_sec": DEFAULT_PAD_SEC,
            "score": ALIGNMENT_SCORE_METHOD,
        }
        if self._local_source is not None:
            identity["local_source"] = self._local_source
        return identity

    def align(
        self,
        audio_path: Path,
        words: Sequence[TranscriptWord],
        *,
        engine: FFmpegEngine | None = None,
    ) -> WordAlignResult:
        start = time.perf_counter()
        if engine is None:
            if self._default_engine is None:
                self._default_engine = FFmpegEngine()
            engine = self._default_engine
        chunks = engine.stream_mono_f32(audio_path, sample_rate=SAMPLE_RATE_WAV2VEC2)
        with contextlib.closing(SequentialWindowReader(chunks, SAMPLE_RATE_WAV2VEC2)) as reader:
            placed, stats = place_spans_stream(
                reader, [(w.text, w.start, w.end) for w in words], self._backend, self._vocab
            )
            # Only a decode with no samples at all, and only once a window read drained
            # the stream (end_sec stays None if every padded window ended at sample <= 0,
            # which ASR timestamps cannot produce). Not full decode validation: a short
            # but nonzero decode (truncated media) is not an error; its windows fall
            # under MIN_WINDOW_SAMPLES and those words keep Whisper's times.
            if words and reader.end_sec == 0.0:
                raise NoAudioDecodedError(audio_path)
        spans = [None if p is None else (p.start, p.end) for p in placed]
        scores = tuple(None if p is None else p.score for p in placed)
        return WordAlignResult(spans, stats, time.perf_counter() - start, scores)


def apply_word_spans(
    words: list[TranscriptWord],
    spans: Sequence[tuple[float, float] | None],
    scores: Sequence[float | None] = (),
) -> int:
    """Re-time non-None spans onto ``words`` in place; return the count re-timed.

    A retimed word loses the ``deferred`` status that Whisper's stretched span
    gave it, since an ASR result only carries the status that
    ``flag_anomalous_asr_durations`` set on Whisper's span, and the backstop
    re-judges the aligned span afterwards.

    A word the aligner could not place (``None``, e.g. ``1990`` has no wav2vec2
    encoding) keeps Whisper's times clamped between its nearest re-timed
    neighbours, so ``words`` stays in time order for consumers that read gaps
    pairwise. A kept word the clamp collapses to zero length is flagged
    ``deferred`` for refine / audition.

    A placed word takes its evidence score from ``scores`` (empty = no scores,
    e.g. test stubs); every unplaced word's ``alignment_score`` is cleared.
    """
    if len(words) != len(spans):
        raise ValueError(f"words/spans length mismatch: {len(words)} != {len(spans)}")
    if scores and len(scores) != len(words):
        raise ValueError(f"words/scores length mismatch: {len(words)} != {len(scores)}")
    retimed = 0
    for i, (word, span) in enumerate(zip(words, spans, strict=True)):
        if span is None:
            word.alignment_score = None
            continue
        word.start, word.end = span
        word.alignment_score = scores[i] if scores else None
        if word.audibility_status == "deferred":
            word.audibility_status = None
        retimed += 1
    _clamp_unaligned_runs(words, spans)
    return retimed


def _clamp_unaligned_runs(
    words: list[TranscriptWord], spans: Sequence[tuple[float, float] | None]
) -> None:
    n = len(words)
    i = 0
    while i < n:
        if spans[i] is not None:
            i += 1
            continue
        j = i
        while j < n and spans[j] is None:
            j += 1
        # words[i:j] kept Whisper's times; words[i - 1] and words[j] (when present) were re-timed.
        lo = words[i - 1].end if i > 0 else None
        hi = words[j].start if j < n else None
        if lo is not None and hi is not None and hi < lo:
            hi = lo
        for word in words[i:j]:
            had_length = word.end > word.start
            word.start = clamp(word.start, lo, hi)
            word.end = clamp(word.end, lo, hi)
            if had_length and word.end <= word.start and word.audibility_status is None:
                word.audibility_status = "deferred"
        i = j
