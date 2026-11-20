from __future__ import annotations

import itertools
import json
import logging
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.engines.whisper_cpp import (
    IOS_MODEL_NAME,
    parse_whisper_cpp_json,
    resolve_model_path,
    resolve_whisper_cli,
    transcribe_file_whisper_cpp,
)
from podcast_mcp.util import native_whisper
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.host_platform import IOS, MACOS
from podcast_mcp.util.process import IN_PROCESS_WHISPER


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


def test_parse_whisper_cpp_json_keeps_the_text_of_a_zero_duration_word() -> None:
    data = {
        "transcription": [
            {
                "tokens": [
                    {"text": " ok", "offsets": {"from": 600, "to": 800}},
                    {"text": " bad", "offsets": {"from": 900, "to": 900}},
                    {"text": " fine", "offsets": {"from": 950, "to": 1100}},
                ]
            }
        ]
    }
    tr = parse_whisper_cpp_json(data)
    assert [w.text for w in tr.words] == ["ok bad", "fine"]
    assert (tr.words[0].start, tr.words[0].end) == (0.6, 0.8)


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


def _token(text: str, start: int | None, end: int | None = None, p: float | None = 0.9) -> dict:
    token: dict = {"text": text}
    if start is not None:
        token["offsets"] = {"from": start, "to": end if end is not None else start + 100}
    if p is not None:
        token["p"] = p
    return token


def _segment(*tokens: dict) -> dict:
    return {"tokens": list(tokens)}


def test_parse_merges_subword_tokens_into_words() -> None:
    data = {
        "transcription": [
            _segment(
                _token("[_BEG_]", 0, 0),
                _token(" Hel", 1000, 1200, 0.9),
                _token("lo", 1200, 1500, 0.4),
                _token(" wor", 1600, 1800, 0.8),
                _token("ld", 1800, 2000, 0.7),
                _token("!", 2000, 2100, 0.95),
            )
        ]
    }
    words = parse_whisper_cpp_json(data).words
    assert [w.text for w in words] == ["Hello", "world!"]
    assert (words[0].start, words[0].end, words[0].confidence) == (1.0, 1.5, 0.4)
    assert (words[1].start, words[1].end, words[1].confidence) == (1.6, 2.1, 0.7)


def test_the_first_kept_token_of_a_segment_opens_a_word() -> None:
    data = {
        "transcription": [
            _segment(_token(" one", 0, 400)),
            _segment(_token("two", 500, 900), _token(" three", 900, 1300)),
        ]
    }
    assert [w.text for w in parse_whisper_cpp_json(data).words] == ["one", "two", "three"]


def test_tokens_without_offsets_stay_in_the_text_and_are_counted(caplog) -> None:
    data = {
        "transcription": [
            _segment(
                _token(" good", 0, 300),
                _token("ness", None),
                _token(" gone", None),
                _token(" next", 400, 700),
            )
        ]
    }
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.engines.whisper_cpp"):
        words = parse_whisper_cpp_json(data).words
    assert [w.text for w in words] == ["goodness gone", "next"]
    assert (words[0].start, words[0].end) == (0.0, 0.3)
    assert "2 token(s) without usable offsets" in caplog.text


def test_untimed_text_before_any_word_leads_the_first_timed_word() -> None:
    data = {"transcription": [_segment(_token(" um", None), _token(" yes", 500, 800))]}
    words = parse_whisper_cpp_json(data).words
    assert [w.text for w in words] == ["um yes"]


def test_word_times_are_monotonic_and_never_overlap() -> None:
    data = {
        "transcription": [
            _segment(
                _token(" a", 1000, 1800),
                _token(" b", 1500, 2200),
                _token(" c", 1200, 1600),
                _token(" d", 2200, 2200),
                _token(" e", 2100, 2600),
                _token(" f", 2600, 3000),
            ),
            _segment(_token(" g", 2900, 3400)),
        ]
    }
    words = parse_whisper_cpp_json(data).words
    assert [w.text for w in words] == ["a", "b c d", "e", "f", "g"]
    for before, after in itertools.pairwise(words):
        assert before.start < before.end <= after.start < after.end
    assert all(w.end > w.start for w in words)


def test_resolve_whisper_cli_is_the_sentinel_where_the_backend_is_installed(
    host, monkeypatch
) -> None:
    host(IOS)
    monkeypatch.setattr(native_whisper, "is_installed", lambda: True)
    assert resolve_whisper_cli() == IN_PROCESS_WHISPER


def test_resolve_whisper_cli_ignores_the_sentinel_without_a_backend(
    host, monkeypatch, tmp_path: Path
) -> None:
    host(IOS)
    monkeypatch.setattr(native_whisper, "is_installed", lambda: False)
    cli = tmp_path / "whisper-cli"
    cli.write_bytes(b"bin")
    monkeypatch.setenv("WHISPER_CPP_BIN", str(cli))
    assert resolve_whisper_cli() == cli


def test_the_default_model_follows_the_host(host, monkeypatch, tmp_path: Path) -> None:
    cache = tmp_path / "models"
    cache.mkdir()
    (cache / IOS_MODEL_NAME).write_bytes(b"small")
    (cache / "ggml-base.en.bin").write_bytes(b"base")
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.whisper_cpp_cache_dir", lambda: cache)
    monkeypatch.delenv("WHISPER_CPP_MODEL", raising=False)
    monkeypatch.delenv("WHISPER_CPP_MODEL_NAME", raising=False)
    host(IOS)
    assert resolve_model_path().name == "ggml-small.en-q5_1.bin"
    host(MACOS)
    assert resolve_model_path().name == "ggml-base.en.bin"


def _run_recording(argvs: list[list[str]]):
    def fake_run(cmd, **kwargs):
        argvs.append(list(cmd))
        out_prefix = Path(cmd[cmd.index("-of") + 1])
        Path(f"{out_prefix}.json").write_text(
            json.dumps({"transcription": [_segment(_token(" hi", 0, 300))]}), encoding="utf-8"
        )
        return MagicMock(returncode=0)

    return fake_run


ALLOWED_FLAGS = {"-ojf", "-np", "-m", "-f", "-of", "-l", "-t", "--prompt"}


def test_the_in_process_run_passes_threads_and_only_allowed_flags(
    host, monkeypatch, tmp_path: Path
) -> None:
    host(IOS)
    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"wav")
    model = tmp_path / IOS_MODEL_NAME
    model.write_bytes(b"model")
    argvs: list[list[str]] = []
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.run", _run_recording(argvs))
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.resolve_model_path", lambda m=None: model)
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.os.cpu_count", lambda: 8)

    tr = transcribe_file_whisper_cpp(
        audio, language="en", initial_prompt="names", cli_path=IN_PROCESS_WHISPER
    )

    assert tr.words[0].text == "hi"
    (argv,) = argvs
    assert argv[0] == IN_PROCESS_WHISPER
    assert argv[argv.index("-t") + 1] == "4"
    assert argv[argv.index("-l") + 1] == "en"
    assert argv[argv.index("--prompt") + 1] == "names"
    assert {a for a in argv[1:] if a.startswith("-")} <= ALLOWED_FLAGS


def test_a_desktop_cli_run_passes_no_threads_unless_asked(monkeypatch, tmp_path: Path) -> None:
    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"wav")
    model = tmp_path / "ggml-base.en.bin"
    model.write_bytes(b"model")
    cli = tmp_path / "whisper-cli"
    cli.write_bytes(b"bin")
    argvs: list[list[str]] = []
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.run", _run_recording(argvs))
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.resolve_model_path", lambda m=None: model)
    transcribe_file_whisper_cpp(audio, cli_path=cli)
    assert "-t" not in argvs[0]


@pytest.mark.parametrize("model_name", [IOS_MODEL_NAME, "ggml-base.en.bin", "ggml-small.en.bin"])
def test_an_english_only_model_refuses_another_language(
    monkeypatch, tmp_path: Path, model_name: str
) -> None:
    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"wav")
    model = tmp_path / model_name
    model.write_bytes(b"model")
    monkeypatch.setattr(
        "podcast_mcp.engines.whisper_cpp.run", lambda *a, **k: pytest.fail("ran whisper")
    )
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.resolve_model_path", lambda m=None: model)
    with pytest.raises(CodedValueError, match="English only") as refused:
        transcribe_file_whisper_cpp(audio, language="de", cli_path=IN_PROCESS_WHISPER)
    assert refused.value.code == "transcription_language_unsupported"


def test_a_multilingual_model_accepts_another_language(monkeypatch, tmp_path: Path) -> None:
    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"wav")
    model = tmp_path / "ggml-small-q5_1.bin"
    model.write_bytes(b"model")
    argvs: list[list[str]] = []
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.run", _run_recording(argvs))
    monkeypatch.setattr("podcast_mcp.engines.whisper_cpp.resolve_model_path", lambda m=None: model)
    transcribe_file_whisper_cpp(audio, language="de", cli_path=IN_PROCESS_WHISPER)
    assert argvs[0][argvs[0].index("-l") + 1] == "de"


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
    assert tr.words


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
