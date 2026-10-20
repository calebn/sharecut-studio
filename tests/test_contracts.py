"""util/contracts.py reads contracts/ from a checkout and from the installed package."""

from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path

import pytest

from podcast_mcp.util import contracts

ROOT = Path(__file__).resolve().parents[1]
LOADER = ROOT / "src" / "podcast_mcp" / "util" / "contracts.py"


def test_checkout_reads_the_repo_contracts() -> None:
    assert contracts.contracts_dir() == ROOT / "contracts"
    assert contracts.load_contract("caps.json") == json.loads(
        (ROOT / "contracts" / "caps.json").read_text(encoding="utf-8")
    )


def test_every_contract_is_a_json_object() -> None:
    for path in sorted((ROOT / "contracts").glob("*.json")):
        assert isinstance(contracts.load_contract(path.name), dict), path.name


def test_no_contract_copy_sits_beside_the_code() -> None:
    assert list((ROOT / "src" / "podcast_mcp").rglob("*.json")) == []


def test_installed_layout_reads_the_packaged_contracts(tmp_path: Path) -> None:
    package = tmp_path / "podcast_mcp"
    (package / "util").mkdir(parents=True)
    (package / "contracts").mkdir()
    shutil.copy(LOADER, package / "util" / "contracts.py")
    (package / "contracts" / "x.json").write_text('{"packaged": true}', encoding="utf-8")
    spec = importlib.util.spec_from_file_location(
        "installed_contracts", package / "util/contracts.py"
    )
    assert spec and spec.loader
    installed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installed)
    assert installed.contracts_dir() == package / "contracts"
    assert installed.load_contract("x.json") == {"packaged": True}


def test_non_object_contract_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "list.json").write_text("[]", encoding="utf-8")
    monkeypatch.setattr(contracts, "contracts_dir", lambda: tmp_path)
    with pytest.raises(ValueError, match=r"list\.json must be a JSON object"):
        contracts.load_contract("list.json")


def test_contract_constant_names_the_missing_file_and_key(tmp_path, monkeypatch):
    (tmp_path / "x.json").write_text('{"constants": {"a": 1}}', encoding="utf-8")
    (tmp_path / "bare.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(contracts, "contracts_dir", lambda: tmp_path)
    assert contracts.contract_constant("x.json", "a") == 1
    with pytest.raises(RuntimeError, match=r"contracts/x\.json has no constants\.b"):
        contracts.contract_constant("x.json", "b")
    with pytest.raises(RuntimeError, match=r"contracts/bare\.json has no constants\.a"):
        contracts.contract_constant("bare.json", "a")
