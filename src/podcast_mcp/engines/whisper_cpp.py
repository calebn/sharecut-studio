from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

from podcast_mcp.config import cache_dir
from podcast_mcp.engines.asr_timing import DEFAULT_MAX_WORD_DURATION_SEC
from podcast_mcp.engines.transcribe import flag_anomalous_asr_durations
from podcast_mcp.models import Transcript, TranscriptWord
from podcast_mcp.util.process import run


def whisper_cpp_cache_dir() -> Path:
    d = cache_dir() / "whisper-cpp" / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def resolve_whisper_cli() -> Path:
    env = os.environ.get("WHISPER_CPP_BIN")
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
    override = os.environ.get("WHISPER_CPP_MODEL")
    if override:
        path = Path(override).expanduser()
        if path.is_file():
            return path
    name = model or os.environ.get("WHISPER_CPP_MODEL_NAME", "ggml-base.en.bin")
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


def parse_whisper_cpp_json(
    data: dict,
    *,
    language: str = "en",
    max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
) -> Transcript:
    words: list[TranscriptWord] = []
    for segment in data.get("transcription", []):
        for token in segment.get("tokens", []):
            text = str(token.get("text", "")).strip()
            if _is_special_token(text):
                continue
            offsets = token.get("offsets") or {}
            start_ms = float(offsets.get("from", 0))
            end_ms = float(offsets.get("to", start_ms))
            if end_ms <= start_ms:
                continue
            words.append(
                TranscriptWord(
                    text=text,
                    start=start_ms / 1000.0,
                    end=end_ms / 1000.0,
                    confidence=float(token["p"]) if token.get("p") is not None else None,
                )
            )
    flag_anomalous_asr_durations(words, max_word_sec=max_word_sec)
    return Transcript(track_id="", language=language, words=words)


def transcribe_file_whisper_cpp(
    audio_path: Path,
    *,
    language: str | None = "en",
    initial_prompt: str | None = None,
    model: str | None = None,
    threads: int | None = None,
    cli_path: Path | None = None,
    max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
) -> Transcript:
    audio_path = audio_path.resolve()
    if not audio_path.is_file():
        raise FileNotFoundError(audio_path)

    cli = cli_path or resolve_whisper_cli()
    model_path = resolve_model_path(model)

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
