from __future__ import annotations

import sys

import pytest

from podcast_mcp.util.process import run


def test_run_rejects_non_sequence_argv() -> None:
    with pytest.raises(TypeError, match="argv must be a list or tuple"):
        run("echo hi")  # type: ignore[arg-type]


def test_run_rejects_empty_argv() -> None:
    with pytest.raises(ValueError, match="argv must not be empty"):
        run([])


def test_run_harmless_command() -> None:
    r = run([sys.executable, "-c", "print(1)"], capture_output=True, text=True)
    assert r.returncode == 0
    assert r.stdout.strip() == "1"


def test_popen_rejects_and_runs() -> None:
    from podcast_mcp.util.process import popen

    with pytest.raises(TypeError, match="argv must be a list or tuple"):
        popen("echo hi")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="argv must not be empty"):
        popen([])
    proc = popen([sys.executable, "-c", "pass"], stdout=None, stderr=None)
    assert proc.wait() == 0


def test_specs_from_extensions_skips_blank_and_falls_back() -> None:
    from podcast_mcp.export.audio import ExportFormatSpec, specs_from_extensions

    specs = specs_from_extensions(["", ".", "flac"])
    assert [s.ext for s in specs] == ["flac"]
    assert specs_from_extensions(["", "."]) == [ExportFormatSpec(ext="wav")]
    spec = ExportFormatSpec.from_dict({"ext": "aac", "extra_args": "-movflags"})
    assert spec.extra_args == ("-movflags",)
