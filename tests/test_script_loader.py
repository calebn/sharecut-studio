"""The test script loader preserves each caller's module registration semantics."""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType

import pytest

import script_loader


def test_load_script_is_fresh_and_unregistered_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "sample.py").write_text("items = []\n", encoding="utf-8")
    monkeypatch.setattr(script_loader, "SCRIPTS", tmp_path)
    previous = ModuleType("sample")
    monkeypatch.setitem(sys.modules, "sample", previous)

    first = script_loader.load_script("sample")
    second = script_loader.load_script("sample")

    assert first is not second
    assert first.items is not second.items
    assert sys.modules["sample"] is previous


def test_load_script_registers_module_when_requested(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "sample.py").write_text(
        "import sys\nregistered = sys.modules[__name__].__name__ == __name__\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(script_loader, "SCRIPTS", tmp_path)
    monkeypatch.delitem(sys.modules, "sample", raising=False)

    loaded = script_loader.load_script("sample", register=True)

    assert loaded.registered
    assert sys.modules["sample"] is loaded
    monkeypatch.delitem(sys.modules, "sample")


def test_missing_script_raises_without_registering(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "missing_test_script", raising=False)

    with pytest.raises(FileNotFoundError):
        script_loader.load_script("missing_test_script", register=True)

    assert "missing_test_script" not in sys.modules


@pytest.mark.parametrize("prior_module", [False, True])
def test_registered_failure_restores_prior_module(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, prior_module: bool
) -> None:
    (tmp_path / "failure.py").write_text("raise RuntimeError('boom')\n", encoding="utf-8")
    monkeypatch.setattr(script_loader, "SCRIPTS", tmp_path)
    previous = ModuleType("failure")
    if prior_module:
        monkeypatch.setitem(sys.modules, "failure", previous)
    else:
        monkeypatch.delitem(sys.modules, "failure", raising=False)

    with pytest.raises(RuntimeError, match="boom"):
        script_loader.load_script("failure", register=True)

    if prior_module:
        assert sys.modules["failure"] is previous
    else:
        assert "failure" not in sys.modules
