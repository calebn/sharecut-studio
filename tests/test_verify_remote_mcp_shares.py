from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_remote_mcp_shares.py"
FIXTURE_WS = ROOT / "tests" / "fixtures" / "aligned_dialogue"


def _load_script():
    spec = importlib.util.spec_from_file_location("verify_remote_mcp_shares", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    # Dataclass processing looks the defining module up in sys.modules.
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_default_project_runs_against_relocated_tmp_copy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mod = _load_script()
    seen: dict[str, object] = {}

    def fake_run(project: Path, base: str, *, revoke: bool) -> int:
        data = json.loads(project.read_text(encoding="utf-8"))
        seen.update(project=project, workspace_dir=data["meta"]["workspace_dir"], revoke=revoke)
        return 0

    monkeypatch.setattr(mod, "_run", fake_run)

    assert mod.main(["--base", "http://127.0.0.1:1"]) == 0

    project = seen["project"]
    assert isinstance(project, Path)
    assert project.name == "episode.project.json"
    assert FIXTURE_WS.resolve() not in project.resolve().parents
    assert seen["workspace_dir"] == str(project.parent.resolve())
    assert seen["revoke"] is True
    assert not project.parent.exists(), "temporary workspace must be removed after the run"


def test_explicit_project_runs_in_place(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    mod = _load_script()
    seen: list[Path] = []

    def fake_run(project: Path, base: str, *, revoke: bool) -> int:
        seen.append(project)
        return 0

    monkeypatch.setattr(mod, "_run", fake_run)
    explicit = tmp_path / "episode.project.json"

    assert mod.main(["--project", str(explicit), "--keep-shares"]) == 0
    assert seen == [explicit.resolve()]


def test_run_rejects_missing_project(tmp_path: Path) -> None:
    mod = _load_script()
    assert mod._run(tmp_path / "missing.json", "http://127.0.0.1:1", revoke=True) == 2
