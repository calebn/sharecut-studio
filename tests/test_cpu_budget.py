"""One CPU budget (#2250): thread and worker counts start from ``cpu_budget()``, not ``os.cpu_count()``."""

from __future__ import annotations

import ast
import dataclasses
from pathlib import Path

from podcast_mcp.util import hardware
from podcast_mcp.util.hardware import cpu_budget, cpu_only_profile, use_hardware_profile

SRC = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"
ALLOWED = {SRC / "util" / "hardware.py"}


def test_the_budget_is_the_effective_cores_of_the_profile() -> None:
    profile = dataclasses.replace(cpu_only_profile(16), effective_cores=3)
    with use_hardware_profile(profile):
        assert cpu_budget() == 3


def test_the_budget_is_never_below_one() -> None:
    profile = dataclasses.replace(cpu_only_profile(4), effective_cores=0)
    with use_hardware_profile(profile):
        assert cpu_budget() == 1


def test_the_budget_without_a_profile_does_not_run_the_hardware_probe(monkeypatch) -> None:
    def no_probe():
        raise AssertionError("the GPU probe ran")

    monkeypatch.setattr(hardware, "hardware_profile", no_probe)
    monkeypatch.setattr(hardware.os, "cpu_count", lambda: 6)
    monkeypatch.setattr(hardware, "effective_cpu_count", lambda logical: min(logical, 2))
    assert cpu_budget() == 2


def test_an_unknown_core_count_is_one_core(monkeypatch) -> None:
    monkeypatch.setattr(hardware.os, "cpu_count", lambda: None)
    monkeypatch.setattr(hardware, "effective_cpu_count", lambda logical: logical)
    assert cpu_budget() == 1


_BANNED = {"cpu_count", "process_cpu_count", "sched_getaffinity"}


def test_no_code_reads_the_raw_core_count_outside_the_hardware_probe() -> None:
    offenders = []
    for path in sorted(SRC.rglob("*.py")):
        if path in ALLOWED:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            named = (
                (isinstance(node, ast.Attribute) and node.attr in _BANNED)
                or (isinstance(node, ast.ImportFrom) and any(a.name in _BANNED for a in node.names))
                or (
                    isinstance(node, ast.Constant)
                    and isinstance(node.value, str)
                    and node.value in _BANNED
                )
            )
            if named:
                offenders.append(f"{path.relative_to(SRC)}:{node.lineno}")
    assert not offenders, f"use util.hardware.cpu_budget() instead of os.cpu_count(): {offenders}"
