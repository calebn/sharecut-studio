from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_update_feed.py"
_spec = importlib.util.spec_from_file_location("build_update_feed", SCRIPT)
assert _spec and _spec.loader
feed_tool = importlib.util.module_from_spec(_spec)
sys.modules["build_update_feed"] = feed_tool
_spec.loader.exec_module(feed_tool)

BASE = "https://cdn.example.test/desktop/0.2.0"
SIG = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo="


def _bundle(tmp_path: Path, name: str, sig: str | None = SIG) -> Path:
    path = tmp_path / name
    path.write_bytes(b"bundle bytes")
    if sig is not None:
        path.with_name(name + ".sig").write_text(sig + "\n", encoding="utf-8")
    return path


def _run(*args: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *map(str, args)],
        check=False,
        capture_output=True,
        text=True,
    )


def test_builds_feed_in_tauri_static_format(tmp_path: Path) -> None:
    mac = _bundle(tmp_path, "Sharecut Studio.app.tar.gz")
    out = tmp_path / "latest.json"
    done = _run(
        "--version",
        "v0.2.0",
        "--base-url",
        BASE + "/",
        "--platform",
        f"darwin-aarch64={mac}",
        "--notes",
        "Fixes",
        "--pub-date",
        "2026-10-17T12:00:00Z",
        "--output",
        out,
    )
    assert done.returncode == 0, done.stderr
    assert SIG not in done.stdout + done.stderr
    assert json.loads(out.read_text(encoding="utf-8")) == {
        "version": "0.2.0",
        "notes": "Fixes",
        "pub_date": "2026-10-17T12:00:00Z",
        "platforms": {
            "darwin-aarch64": {
                "signature": SIG,
                "url": f"{BASE}/Sharecut%20Studio.app.tar.gz",
            }
        },
    }


def test_merge_adds_platforms_independently_and_is_idempotent(tmp_path: Path) -> None:
    out = tmp_path / "latest.json"
    mac = _bundle(tmp_path, "Studio.app.tar.gz")
    win = _bundle(tmp_path, "Studio_0.2.0_x64-setup.exe", sig="d2luc2ln")
    common = ["--version", "0.2.0", "--base-url", BASE, "--pub-date", "2026-10-17T12:00:00Z"]
    assert (
        _run(
            *common, "--platform", f"darwin-x86_64={mac}", "--notes", "n", "--output", out
        ).returncode
        == 0
    )
    step = [*common, "--platform", f"windows-x86_64={win}", "--merge", out, "--output", out]
    assert _run(*step).returncode == 0
    first = out.read_text(encoding="utf-8")
    assert _run(*step).returncode == 0
    assert out.read_text(encoding="utf-8") == first
    data = json.loads(first)
    assert list(data["platforms"]) == ["darwin-x86_64", "windows-x86_64"]
    assert data["notes"] == "n"
    assert data["platforms"]["windows-x86_64"]["signature"] == "d2luc2ln"


def test_merge_keeps_pub_date_and_defaults_to_now_when_new(tmp_path: Path) -> None:
    mac = _bundle(tmp_path, "Studio.app.tar.gz")
    now = datetime(2026, 10, 17, 1, 2, 3, tzinfo=UTC)
    feed = feed_tool.build_feed(
        version="0.2.0", base_url=BASE, bundles={"darwin-aarch64": mac}, now=now
    )
    assert feed["pub_date"] == "2026-10-17T01:02:03Z"
    again = feed_tool.build_feed(
        version="0.2.0",
        base_url=BASE,
        bundles={},
        existing=feed,
        now=datetime(2030, 1, 1, tzinfo=UTC),
    )
    assert again == feed


def test_merge_refuses_a_different_version(tmp_path: Path) -> None:
    out = tmp_path / "latest.json"
    mac = _bundle(tmp_path, "Studio.app.tar.gz")
    args = ["--base-url", BASE, "--platform", f"darwin-aarch64={mac}", "--output", out]
    assert _run("--version", "0.2.0", *args).returncode == 0
    done = _run("--version", "0.3.0", *args, "--merge", out)
    assert done.returncode == 1
    assert "not '0.3.0'" in done.stderr


@pytest.mark.parametrize("sig", ["", "   \n", "two\nlines"])
def test_rejects_empty_or_multiline_signature(tmp_path: Path, sig: str) -> None:
    mac = _bundle(tmp_path, "Studio.app.tar.gz")
    mac.with_name(mac.name + ".sig").write_text(sig, encoding="utf-8")
    done = _run(
        "--version",
        "0.2.0",
        "--base-url",
        BASE,
        "--platform",
        f"darwin-aarch64={mac}",
        "--output",
        tmp_path / "latest.json",
    )
    assert done.returncode == 1
    assert not (tmp_path / "latest.json").exists()


def test_rejects_missing_signature_http_url_and_wrong_artifact(tmp_path: Path) -> None:
    out = tmp_path / "latest.json"
    unsigned = _bundle(tmp_path, "a.app.tar.gz", sig=None)
    done = _run(
        "--version",
        "0.2.0",
        "--base-url",
        BASE,
        "--platform",
        f"darwin-aarch64={unsigned}",
        "--output",
        out,
    )
    assert "signature file not found" in done.stderr

    mac = _bundle(tmp_path, "b.app.tar.gz")
    done = _run(
        "--version",
        "0.2.0",
        "--base-url",
        "http://cdn.example.test",
        "--platform",
        f"darwin-aarch64={mac}",
        "--output",
        out,
    )
    assert "https" in done.stderr

    dmg = _bundle(tmp_path, "Studio.dmg")
    done = _run(
        "--version",
        "0.2.0",
        "--base-url",
        BASE,
        "--platform",
        f"darwin-aarch64={dmg}",
        "--output",
        out,
    )
    assert "must end with .app.tar.gz" in done.stderr

    done = _run(
        "--version",
        "0.2.0",
        "--base-url",
        BASE,
        "--platform",
        f"freebsd-x86_64={mac}",
        "--output",
        out,
    )
    assert "unknown platform" in done.stderr
    assert not out.exists()


def test_rejects_bad_version_notes_conflict_and_bad_merge_input(tmp_path: Path) -> None:
    mac = _bundle(tmp_path, "Studio.app.tar.gz")
    out = tmp_path / "latest.json"
    base = ["--base-url", BASE, "--platform", f"darwin-aarch64={mac}", "--output", out]
    assert _run("--version", "latest", *base).returncode == 1
    assert _run("--version", "0.2.0", *base, "--notes", "a", "--notes-file", mac).returncode == 1
    assert _run("--version", "0.2.0", *base, "--pub-date", "yesterday").returncode == 1
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    assert _run("--version", "0.2.0", *base, "--merge", bad).returncode == 1
    assert _run("--version", "0.2.0", "--base-url", BASE, "--output", out).returncode == 1
    assert not out.exists()


def test_notes_file_and_linux_artifact(tmp_path: Path) -> None:
    image = _bundle(tmp_path, "Studio.AppImage")
    notes = tmp_path / "notes.md"
    notes.write_text("Line one\nLine two\n", encoding="utf-8")
    out = tmp_path / "latest.json"
    done = _run(
        "--version",
        "1.0.0-beta.1",
        "--base-url",
        BASE,
        "--platform",
        f"linux-x86_64={image}",
        "--notes-file",
        notes,
        "--pub-date",
        "2026-10-17T00:00:00+00:00",
        "--output",
        out,
    )
    assert done.returncode == 0, done.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["notes"] == "Line one\nLine two"
    assert data["platforms"]["linux-x86_64"]["url"].endswith("/Studio.AppImage")
