from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ("sign_updater_bundle.sh", "stage_updater_bundle.sh", "sign_updater_artifacts.sh")
KEY = "distinctive-private-key-material-42"


@pytest.fixture
def sandbox(tmp_path: Path) -> Path:
    """A fake checkout holding the real scripts and a stub `npm` that records its call."""
    (tmp_path / "scripts").mkdir()
    for name in SCRIPTS:
        shutil.copy2(ROOT / "scripts" / name, tmp_path / "scripts" / name)
    conf = tmp_path / "gui" / "desktop" / "src-tauri" / "tauri.conf.json"
    conf.parent.mkdir(parents=True)
    conf.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    stub = tmp_path / "bin" / "npm"
    stub.parent.mkdir()
    stub.write_text(
        "#!/usr/bin/env bash\n"
        'printf "%s\\n" "$@" > "$STUB_DIR/args"\n'
        'printf "%s|%s\\n" "${TAURI_SIGNING_PRIVATE_KEY-unset}" '
        '"${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-unset}" > "$STUB_DIR/env"\n'
        "for last; do :; done\n"
        'printf "c2ln" > "$last.sig"\n'
        'echo "SIGNATURE-CONTENT-MUST-NOT-LEAK"\n',
        encoding="utf-8",
    )
    stub.chmod(0o755)
    return tmp_path


def _run(
    sandbox: Path, script: str, *args: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    base = {
        "PATH": f"{sandbox / 'bin'}:{os.environ['PATH']}",
        "HOME": str(sandbox),
        "STUB_DIR": str(sandbox),
    }
    return subprocess.run(
        ["/bin/bash", str(sandbox / "scripts" / script), *args],
        check=False,
        capture_output=True,
        text=True,
        env=base | (env or {}),
    )


def test_sign_bundle_passes_key_only_to_the_signer_and_binds_the_version(sandbox: Path) -> None:
    bundle = sandbox / "Studio_setup.exe"
    bundle.write_bytes(b"installer")
    done = _run(
        sandbox, "sign_updater_bundle.sh", str(bundle), env={"TAURI_SIGNING_PRIVATE_KEY": KEY}
    )
    assert done.returncode == 0, done.stderr
    assert (sandbox / "Studio_setup.exe.sig").read_text() == "c2ln"
    args = (sandbox / "args").read_text().split()
    assert args[:4] == ["run", "--silent", "tauri", "--"]
    assert args[4:7] == ["signer", "sign", "--app-version"]
    assert args[7] == "1.2.3"
    assert (sandbox / "env").read_text().strip() == f"{KEY}|"
    assert "SIGNATURE-CONTENT-MUST-NOT-LEAK" not in done.stdout + done.stderr
    assert KEY not in done.stdout + done.stderr


def test_sign_bundle_demands_a_key_and_a_real_bundle(sandbox: Path) -> None:
    bundle = sandbox / "a.AppImage"
    bundle.write_bytes(b"image")
    no_key = _run(sandbox, "sign_updater_bundle.sh", str(bundle))
    assert no_key.returncode == 1
    assert "TAURI_SIGNING_PRIVATE_KEY" in no_key.stderr
    assert not (sandbox / "a.AppImage.sig").exists()

    missing = _run(
        sandbox,
        "sign_updater_bundle.sh",
        str(sandbox / "none"),
        env={"TAURI_SIGNING_PRIVATE_KEY": KEY},
    )
    assert missing.returncode == 1


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS tar layout and bundle tooling")
def test_stage_builds_the_tauri_tarball_layout_and_sign_artifacts_signs_it(sandbox: Path) -> None:
    macos = sandbox / "gui/desktop/src-tauri/target/release/bundle/macos"
    contents = macos / "Sharecut Studio.app" / "Contents" / "MacOS"
    contents.mkdir(parents=True)
    (contents / "sharecut").write_text("bin")
    (macos / "Sharecut Studio.app" / "Contents" / "link").symlink_to("MacOS/sharecut")

    done = _run(sandbox, "sign_updater_artifacts.sh", env={"TAURI_SIGNING_PRIVATE_KEY": KEY})
    assert done.returncode == 0, done.stderr
    tarballs = list((sandbox / "gui/desktop/src-tauri/target/release/bundle/updater").glob("*"))
    names = sorted(p.name for p in tarballs)
    assert len(names) == 2 and names[1] == names[0] + ".sig"
    assert names[0].startswith("SharecutStudio_1.2.3_")
    assert names[0].endswith(".app.tar.gz")
    with tarfile.open(min(tarballs, key=lambda p: len(p.name))) as archive:
        members = archive.getnames()
        assert members[0] == "Sharecut Studio.app"
        assert all(m.split("/")[0] == "Sharecut Studio.app" for m in members)
        assert archive.getmember("Sharecut Studio.app/Contents/link").issym()
