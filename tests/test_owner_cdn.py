"""The owner CDN is a build-time default: one allowlisted host, no base in a source checkout (#4383)."""

from __future__ import annotations

import json
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from podcast_mcp.util import owner_cdn
from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://cdn.sharecut.studio"
SPEAKER_PATH = "models/speaker-ecapa/ecapa-voxceleb-embedding.onnx"
SCANNED = ("src/", "scripts/", "contracts/", "gui/desktop/src-tauri/src/")
HOST_HOME = {"src/podcast_mcp/util/owner_cdn.py"}


@pytest.fixture
def contracts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(owner_cdn, "contracts_dir", lambda: tmp_path)
    return tmp_path


def _contract(name: str) -> dict:
    return json.loads((ROOT / "contracts" / name).read_text(encoding="utf-8"))


def _tracked() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z", *SCANNED], cwd=ROOT, capture_output=True, check=True, text=True
    )
    return [name for name in out.stdout.split("\0") if name]


def test_permitted_owner_hosts_are_exactly_the_documented_cdn() -> None:
    assert owner_cdn.OWNER_HOSTS == ("cdn.sharecut.studio",)


def test_only_the_owner_cdn_module_names_the_host() -> None:
    offenders = [
        name
        for name in _tracked()
        if name not in HOST_HOME
        and (ROOT / name).is_file()
        and b"cdn.sharecut.studio" in (ROOT / name).read_bytes()
    ]
    assert offenders == []


def test_every_contract_download_resolves_inside_the_owner_hosts() -> None:
    paths = [
        meta["owner_path"]
        for meta in _contract("bootstrap-assets.json")["assets"].values()
        if "owner_path" in meta
    ]
    targets = _contract("ffmpeg-artifacts.json")["targets"]
    assert paths == [SPEAKER_PATH]
    assert len(targets) == 4
    for entry in targets.values():
        assert "url" not in entry
        paths.append(entry["path"])
    for path in paths:
        assert not path.startswith("/") and ".." not in path.split("/") and "://" not in path
        assert urlsplit(f"{BASE}/{path}").hostname in owner_cdn.OWNER_HOSTS


def test_no_contract_asset_carries_an_absolute_owner_url() -> None:
    for meta in _contract("bootstrap-assets.json")["assets"].values():
        host = urlsplit(str(meta.get("url", ""))).hostname
        assert host not in owner_cdn.OWNER_HOSTS


def test_every_owner_download_has_a_documented_override_or_a_non_owner_fallback() -> None:
    setup = (ROOT / "docs/setup.md").read_text(encoding="utf-8")
    speaker = _contract("bootstrap-assets.json")["assets"]["speaker-ecapa"]
    assert "owner_path" in speaker and "url" not in speaker
    for override in (
        "PODCAST_MCP_SPEAKER_ECAPA_MODEL",
        "PODCAST_MCP_FFMPEG",
        "PODCAST_OWNER_CDN_BASE",
        "PODCAST_BOOTSTRAP_CDN_BASE",
    ):
        assert f"`{override}`" in setup, override
    assert "\n#### Speaker model\n" in setup


def test_no_base_without_env_or_generated_file(
    contracts: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_OWNER_CDN_BASE", raising=False)
    assert owner_cdn.owner_base() is None
    assert owner_cdn.owner_url(SPEAKER_PATH) is None


def test_generated_file_supplies_the_build_time_base(
    contracts: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_OWNER_CDN_BASE", raising=False)
    (contracts / "owner-cdn.json").write_text(json.dumps({"base": f"{BASE}/"}), encoding="utf-8")
    assert owner_cdn.owner_base() == BASE
    assert owner_cdn.owner_url(SPEAKER_PATH) == f"{BASE}/{SPEAKER_PATH}"


def test_env_beats_the_generated_file_and_the_override_beats_both(
    contracts: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (contracts / "owner-cdn.json").write_text(json.dumps({"base": BASE}), encoding="utf-8")
    monkeypatch.setenv("PODCAST_OWNER_CDN_BASE", "https://mine.example.test")
    assert owner_cdn.owner_base() == "https://mine.example.test"
    assert owner_cdn.owner_base("https://flag.example.test") == "https://flag.example.test"


@pytest.mark.parametrize("bad", ["http://cdn.example.test", "https://127.0.0.1", "not a url", "  "])
def test_unsafe_base_is_ignored_and_never_falls_through_to_a_lower_source(
    contracts: Path, monkeypatch: pytest.MonkeyPatch, bad: str
) -> None:
    (contracts / "owner-cdn.json").write_text(json.dumps({"base": BASE}), encoding="utf-8")
    monkeypatch.setenv("PODCAST_OWNER_CDN_BASE", bad)
    expected = BASE if not bad.strip() else None
    assert owner_cdn.owner_base() == expected


@pytest.mark.parametrize("text", ["{", "[]", '{"base": 3}', '{"base": "http://x.example.test"}'])
def test_malformed_generated_file_means_no_base(
    contracts: Path, monkeypatch: pytest.MonkeyPatch, text: str
) -> None:
    monkeypatch.delenv("PODCAST_OWNER_CDN_BASE", raising=False)
    (contracts / "owner-cdn.json").write_text(text, encoding="utf-8")
    assert owner_cdn.owner_base() is None


def test_writer_check_and_gitignore(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    script = load_script("owner_cdn")
    monkeypatch.setattr(script, "TARGET", tmp_path / "owner-cdn.json")
    assert script.main(["check"]) == 0
    assert script.main(["check", "--require"]) == 1
    assert "PODCAST_OWNER_CDN_BASE" in capsys.readouterr().err
    assert script.main(["write", "--base", "http://nope.example.test"]) == 1
    assert not script.TARGET.exists()
    assert script.main(["write", "--base", f"{BASE}/"]) == 0
    assert json.loads(script.TARGET.read_text()) == {"base": BASE}
    assert script.main(["check", "--require"]) == 0
    ignored = subprocess.run(
        ["git", "check-ignore", "-q", "contracts/owner-cdn.json"], cwd=ROOT, check=False
    )
    assert ignored.returncode == 0


def test_wheel_check_accepts_an_absent_or_valid_owner_file_and_rejects_a_bad_one(
    tmp_path: Path,
) -> None:
    check = load_script("check_wheel_web_build")
    wheel = tmp_path / "w.whl"

    def build(extra: dict[str, str]) -> None:
        with zipfile.ZipFile(wheel, "w") as archive:
            for name in check.RUNTIME_CONTRACTS:
                archive.writestr(f"{check.PACKAGED_CONTRACTS}/{name}", "{}")
            for name, text in extra.items():
                archive.writestr(f"{check.PACKAGED_CONTRACTS}/{name}", text)

    build({})
    check.wheel_contracts(wheel)
    build({"owner-cdn.json": json.dumps({"base": BASE})})
    check.wheel_contracts(wheel)
    build({"owner-cdn.json": json.dumps({"base": "http://x.example.test"})})
    with pytest.raises(SystemExit, match=r"owner-cdn\.json"):
        check.wheel_contracts(wheel)
