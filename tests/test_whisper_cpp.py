from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.engines.whisper_cpp import (
    parse_whisper_cpp_json,
    resolve_model_path,
    resolve_whisper_cli,
    transcribe_file_whisper_cpp,
)


def test_parse_whisper_cpp_json_skips_special_tokens() -> None:
    data = {
        "transcription": [
            {
                "tokens": [
                    {
                        "text": "[_BEG_]",
                        "offsets": {"from": 0, "to": 0},
                        "p": 1.0,
                    },
                    {
                        "text": "Hello",
                        "offsets": {"from": 1000, "to": 1500},
                        "p": 0.9,
                    },
                    {
                        "text": " world",
                        "offsets": {"from": 1500, "to": 2000},
                        "p": 0.85,
                    },
                ]
            }
        ]
    }
    tr = parse_whisper_cpp_json(data)
    assert len(tr.words) == 2
    assert tr.words[0].text == "Hello"
    assert tr.words[0].start == 1.0
    assert tr.words[1].text == "world"


def test_parse_whisper_cpp_json_skips_zero_duration_tokens() -> None:
    data = {
        "transcription": [
            {
                "tokens": [
                    {
                        "text": "bad",
                        "offsets": {"from": 500, "to": 500},
                    },
                    {
                        "text": "ok",
                        "offsets": {"from": 600, "to": 800},
                    },
                ]
            }
        ]
    }
    tr = parse_whisper_cpp_json(data)
    assert len(tr.words) == 1
    assert tr.words[0].text == "ok"


def test_parse_whisper_cpp_json_flags_stretched_tokens() -> None:
    data = {
        "transcription": [
            {
                "tokens": [
                    {
                        "text": "don't",
                        "offsets": {"from": 1000, "to": 10500},
                        "p": 0.4,
                    },
                ]
            }
        ]
    }
    tr = parse_whisper_cpp_json(data)
    assert len(tr.words) == 1
    assert tr.words[0].start == 1.0
    assert tr.words[0].end == 10.5
    assert tr.words[0].audibility_status == "deferred"


def test_parse_whisper_cpp_json_honors_max_word_sec() -> None:
    data = {
        "transcription": [
            {
                "tokens": [
                    {
                        "text": "don't",
                        "offsets": {"from": 1000, "to": 10500},
                        "p": 0.4,
                    },
                ]
            }
        ]
    }
    tr = parse_whisper_cpp_json(data, max_word_sec=20.0)
    assert tr.words[0].audibility_status is None


def test_resolve_whisper_cli_paths(tmp_path: Path, monkeypatch) -> None:
    cli = tmp_path / "whisper-cli"
    cli.write_bytes(b"bin")
    monkeypatch.setenv("WHISPER_CPP_BIN", str(cli))
    assert resolve_whisper_cli() == cli

    monkeypatch.setenv("WHISPER_CPP_BIN", str(tmp_path / "missing-cli"))
    with patch("podcast_mcp.engines.whisper_cpp.shutil.which", return_value=str(cli)):
        assert resolve_whisper_cli() == cli

    monkeypatch.delenv("WHISPER_CPP_BIN", raising=False)
    with patch("podcast_mcp.engines.whisper_cpp.shutil.which", return_value=str(cli)):
        assert resolve_whisper_cli() == cli

    with (
        patch("podcast_mcp.engines.whisper_cpp.shutil.which", return_value=None),
        patch.object(
            Path,
            "is_file",
            lambda self: str(self) == "/opt/homebrew/bin/whisper-cli",
        ),
    ):
        assert resolve_whisper_cli() == Path("/opt/homebrew/bin/whisper-cli")

    with patch("podcast_mcp.engines.whisper_cpp.shutil.which", return_value=None):
        with patch.object(Path, "is_file", return_value=False):
            with pytest.raises(FileNotFoundError, match="whisper-cli not found"):
                resolve_whisper_cli()


def test_resolve_model_path_and_cache_dir(tmp_path: Path, monkeypatch) -> None:
    model = tmp_path / "ggml-tiny.bin"
    model.write_bytes(b"model")
    monkeypatch.setenv("WHISPER_CPP_MODEL", str(model))
    assert resolve_model_path() == model

    monkeypatch.setenv("WHISPER_CPP_MODEL", str(tmp_path / "missing-model.bin"))
    cache = tmp_path / "models"
    cache.mkdir()
    cached = cache / "ggml-base.en.bin"
    cached.write_bytes(b"cached")
    monkeypatch.setattr(
        "podcast_mcp.engines.whisper_cpp.whisper_cpp_cache_dir",
        lambda: cache,
    )
    assert resolve_model_path() == cached

    with pytest.raises(FileNotFoundError, match=r"whisper\.cpp model not found"):
        resolve_model_path("missing-model.bin")


def test_transcribe_file_whisper_cpp_mocked(tmp_path: Path, monkeypatch) -> None:
    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"wav")
    cli = tmp_path / "whisper-cli"
    cli.write_bytes(b"bin")
    model = tmp_path / "model.bin"
    model.write_bytes(b"model")

    payload = {
        "transcription": [
            {
                "tokens": [
                    {
                        "text": "Test",
                        "offsets": {"from": 0, "to": 500},
                        "p": 0.95,
                    }
                ]
            }
        ]
    }

    def fake_run(cmd, **kwargs):
        out_prefix = Path(cmd[cmd.index("-of") + 1])
        json_path = Path(f"{out_prefix}.json")
        json_path.write_text(json.dumps(payload), encoding="utf-8")
        return MagicMock(returncode=0)

    monkeypatch.setattr(
        "podcast_mcp.engines.whisper_cpp.run",
        fake_run,
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.whisper_cpp.resolve_model_path",
        lambda model=None: model,
    )
    tr = transcribe_file_whisper_cpp(
        audio,
        language="en",
        initial_prompt="podcast",
        threads=2,
        cli_path=cli,
        model=model,
    )
    assert tr.words[0].text == "Test"

    with pytest.raises(FileNotFoundError):
        transcribe_file_whisper_cpp(tmp_path / "missing.wav", cli_path=cli, model=model)

    def no_json_run(cmd, **kwargs):
        return MagicMock(returncode=0)

    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.run", no_json_run)
    with pytest.raises(RuntimeError, match="did not write"):
        transcribe_file_whisper_cpp(audio, cli_path=cli, model=model)


@pytest.mark.slow
def test_whisper_cpp_fixture_roundtrip() -> None:
    from podcast_mcp.engines.whisper_cpp import (
        resolve_model_path,
        resolve_whisper_cli,
        transcribe_file_whisper_cpp,
    )

    try:
        resolve_whisper_cli()
        resolve_model_path()
    except FileNotFoundError as exc:
        pytest.skip(str(exc))
    audio = (
        Path(__file__).resolve().parents[1]
        / "fixtures"
        / "aligned_dialogue"
        / "raw"
        / "reference.wav"
    )
    if not audio.is_file():
        pytest.skip("aligned_dialogue fixture missing")
    tr = transcribe_file_whisper_cpp(audio, language="en")
    assert tr.words  # fixture may be sparse (humming/music)


def test_benchmark_report_fixture_exists() -> None:
    path = (
        Path(__file__).resolve().parents[1]
        / "fixtures"
        / "aligned_dialogue"
        / "artifacts"
        / "transcribe_benchmark.json"
    )
    if not path.is_file():
        pytest.skip("run scripts/benchmark_transcribe_backends.py first")
    data = json.loads(path.read_text())
    assert "results" in data
    assert len(data["results"]) >= 2
