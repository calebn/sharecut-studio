from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp import settings
from podcast_mcp.engines.asr_options import normalize_language
from podcast_mcp.engines.asr_timing import DEFAULT_MAX_WORD_DURATION_SEC
from podcast_mcp.engines.models import whisper_cpp_models
from podcast_mcp.engines.models.whisper import resolve_whisper_model
from podcast_mcp.engines.models.whisper_cpp_models import whisper_cpp_cache_dir
from podcast_mcp.engines.transcribe import flag_anomalous_asr_durations
from podcast_mcp.models import Transcript, TranscriptWord
from podcast_mcp.util import host_platform, native_whisper
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.process import IN_PROCESS_WHISPER, run
from podcast_mcp.util.wav import PCM_SAMPLE_WIDTH_BYTES, WAV_HEADER_BYTES, pcm_wav_header

log = logging.getLogger(__name__)

WHISPER_SAMPLE_RATE = 16_000
DESKTOP_MODEL_NAME = "ggml-base.en.bin"
IOS_MODEL_NAME = "ggml-small.en-q5_1.bin"
MAX_IOS_THREADS = 4
_ENGLISH_ONLY_MODEL = re.compile(r"\.en(?:[-.]|$)")


def default_model_name() -> str:
    """The env name, else on a whisper.cpp host the selected variant's file, else the desktop file."""
    if host_platform.current().transcription == "whisper_cpp":
        fallback = whisper_cpp_models.variant_for(resolve_whisper_model()).filename
    else:
        fallback = DESKTOP_MODEL_NAME
    return settings.value("WHISPER_CPP_MODEL_NAME", fallback)


def resolve_whisper_cli() -> Path | str:
    if host_platform.current().media_tools == "in_process" and native_whisper.is_installed():
        return IN_PROCESS_WHISPER
    env = settings.raw("WHISPER_CPP_BIN")
    if env:
        path = Path(env).expanduser()
        if path.is_file():
            return path
    found = shutil.which("whisper-cli")
    if found:
        return Path(found)
    brew = Path("/opt/homebrew/bin/whisper-cli")
    if brew.is_file():
        return brew
    raise FileNotFoundError(
        "whisper-cli not found; install whisper-cpp (brew install whisper-cpp) "
        "or set WHISPER_CPP_BIN"
    )


def resolve_model_path(model: str | None = None) -> Path:
    override = settings.raw("WHISPER_CPP_MODEL")
    if override:
        path = Path(override).expanduser()
        if path.is_file():
            return path
    name = model or default_model_name()
    path = whisper_cpp_cache_dir() / name
    if path.is_file():
        return path
    raise FileNotFoundError(
        f"whisper.cpp model not found: {path}. "
        "Download from https://huggingface.co/ggerganov/whisper.cpp/tree/main"
    )


def _is_special_token(text: str) -> bool:
    t = text.strip()
    return not t or t.startswith("[") or t.startswith("<|")


@dataclass
class _Draft:
    text: str
    start: float | None = None
    end: float | None = None
    confidence: float | None = None

    def add(self, text: str, span: tuple[float, float] | None, p: float | None) -> None:
        self.text += text
        if span is not None:
            self.start = span[0] if self.start is None else min(self.start, span[0])
            self.end = span[1] if self.end is None else max(self.end, span[1])
        if p is not None:
            self.confidence = p if self.confidence is None else min(self.confidence, p)


def _token_span(token: dict[str, Any]) -> tuple[float, float] | None:
    offsets = token.get("offsets")
    if not isinstance(offsets, dict):
        return None
    try:
        start_ms = float(offsets["from"])
        end_ms = float(offsets["to"])
    except (KeyError, TypeError, ValueError):
        return None
    if start_ms < 0 or end_ms <= start_ms:
        return None
    return start_ms / 1000.0, end_ms / 1000.0


def _token_probability(token: dict[str, Any]) -> float | None:
    p = token.get("p")
    return float(p) if isinstance(p, int | float) else None


def _drafts(data: dict[str, Any]) -> tuple[list[_Draft], int]:
    drafts: list[_Draft] = []
    untimed_tokens = 0
    for segment in data.get("transcription", []):
        current: _Draft | None = None
        for token in segment.get("tokens", []):
            raw = str(token.get("text", ""))
            if _is_special_token(raw):
                continue
            span = _token_span(token)
            untimed_tokens += span is None
            if current is None or raw[:1].isspace():
                current = _Draft(text="")
                drafts.append(current)
            current.add(raw.strip(), span, _token_probability(token))
    return drafts, untimed_tokens


def _join(first: str, second: str) -> str:
    return f"{first} {second}" if first else second


def _words_from_drafts(drafts: list[_Draft]) -> tuple[list[TranscriptWord], int, int]:
    """Timed words in order, never overlapping; text of a word with no usable time joins a neighbour.

    A word with no usable span, or one a neighbour's span swallows whole, joins the previous
    word's text (or the next word's when none came before; a transcript with no timed word at
    all yields no words and the text is logged). Where a word starts inside the
    previous one, the previous word ends where it starts. Returns the words, the count that
    joined a neighbour and the count whose neighbour was trimmed.
    """
    words: list[TranscriptWord] = []
    prefix = ""
    attached = trimmed = 0
    for draft in drafts:
        if draft.start is None or draft.end is None:
            attached += 1
            if words:
                words[-1].text = _join(words[-1].text, draft.text)
            else:
                prefix = _join(prefix, draft.text)
            continue
        start, end = draft.start, draft.end
        if words:
            prev = words[-1]
            if start < prev.end:
                trimmed += 1
                if start > prev.start:
                    prev.end = start
                else:
                    start = prev.end
            if end <= start:
                attached += 1
                prev.text = _join(prev.text, draft.text)
                continue
        words.append(
            TranscriptWord(
                text=_join(prefix, draft.text),
                start=start,
                end=end,
                confidence=draft.confidence,
            )
        )
        prefix = ""
    if prefix:
        log.warning("whisper.cpp: text with no timing and no word to join was left out: %r", prefix)
    return words, attached, trimmed


def parse_whisper_cpp_json(
    data: dict,
    *,
    language: str = "en",
    max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
) -> Transcript:
    """Words from whisper.cpp's ``-ojf`` output.

    Tokens are subwords: one with a leading space, or the first kept token of a segment, opens
    a word and the rest join it. A word runs from its first token's start to its last token's
    end, with the lowest token probability as its confidence.
    """
    drafts, untimed_tokens = _drafts(data)
    words, attached, trimmed = _words_from_drafts(drafts)
    if untimed_tokens or attached or trimmed:
        log.warning(
            "whisper.cpp: %d token(s) without usable offsets kept in their word's text, "
            "%d word(s) joined a neighbour, %d overlap(s) trimmed",
            untimed_tokens,
            attached,
            trimmed,
        )
    flag_anomalous_asr_durations(words, max_word_sec=max_word_sec)
    return Transcript(track_id="", language=language, words=words)


def write_wav_16k_mono(chunks: Iterable[np.ndarray], path: Path) -> int:
    """Write mono float32 ``chunks`` (already 16 kHz) as 16-bit PCM WAV; the sample count."""
    frames = 0
    with path.open("wb") as fh:
        fh.write(b"\0" * WAV_HEADER_BYTES)
        for chunk in chunks:
            pcm = (np.clip(chunk, -1.0, 1.0) * 32767.0).astype("<i2")
            fh.write(pcm.tobytes())
            frames += len(pcm)
        fh.seek(0)
        fh.write(pcm_wav_header(frames * PCM_SAMPLE_WIDTH_BYTES, WHISPER_SAMPLE_RATE, 1))
    return frames


def _check_language(language: str | None, model_path: Path) -> None:
    requested = normalize_language(language)
    if requested and requested != "en" and _ENGLISH_ONLY_MODEL.search(model_path.name):
        raise CodedValueError(
            f"The transcription model {model_path.name} reads English only, so it can't "
            f"transcribe language {requested!r}. Set the language to English or use a "
            "multilingual model.",
            code="transcription_language_unsupported",
        )


def transcribe_file_whisper_cpp(
    audio_path: Path,
    *,
    language: str | None = "en",
    initial_prompt: str | None = None,
    model: str | None = None,
    threads: int | None = None,
    cli_path: Path | str | None = None,
    max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
) -> Transcript:
    audio_path = audio_path.resolve()
    if not audio_path.is_file():
        raise FileNotFoundError(audio_path)

    cli = cli_path or resolve_whisper_cli()
    model_path = resolve_model_path(model)
    _check_language(language, model_path)
    if threads is None and cli == IN_PROCESS_WHISPER:
        threads = min(MAX_IOS_THREADS, os.cpu_count() or MAX_IOS_THREADS)

    with tempfile.TemporaryDirectory(prefix="whisper-cpp-") as tmp:
        out_prefix = Path(tmp) / "out"
        cmd = [
            str(cli),
            "-m",
            str(model_path),
            "-f",
            str(audio_path),
            "-ojf",
            "-of",
            str(out_prefix),
            "-np",
        ]
        if language:
            cmd.extend(["-l", language])
        if initial_prompt:
            cmd.extend(["--prompt", initial_prompt])
        if threads is not None:
            cmd.extend(["-t", str(threads)])

        run(cmd, check=True, capture_output=True, text=True)
        json_path = Path(f"{out_prefix}.json")
        if not json_path.is_file():
            raise RuntimeError(f"whisper-cli did not write {json_path}")
        data = json.loads(json_path.read_text(encoding="utf-8"))

    return parse_whisper_cpp_json(
        data,
        language=language or "en",
        max_word_sec=max_word_sec,
    )
