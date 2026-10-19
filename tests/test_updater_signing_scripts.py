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
SENTINEL = "sentinel-text-that-must-never-be-printed"


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
        'printf "%s|%s|%s\\n" "${TAURI_SIGNING_PRIVATE_KEY-unset}" '
        '"${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-unset}" '
        '"${TAURI_SIGNING_PRIVATE_KEY_PATH-unset}" > "$STUB_DIR/env"\n'
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
        sandbox, "sign_updater_bundle.sh", str(bundle), env={"TAURI_SIGNING_PRIVATE_KEY": SENTINEL}
    )
    assert done.returncode == 0, done.stderr
    assert (sandbox / "Studio_setup.exe.sig").read_text() == "c2ln"
    args = (sandbox / "args").read_text().split()
    assert args[:4] == ["run", "--silent", "tauri", "--"]
    assert args[4:7] == ["signer", "sign", "--app-version"]
    assert args[7] == "1.2.3"
    assert (sandbox / "env").read_text().strip() == f"{SENTINEL}||unset"
    assert "SIGNATURE-CONTENT-MUST-NOT-LEAK" not in done.stdout + done.stderr
    assert SENTINEL not in done.stdout + done.stderr


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
        env={"TAURI_SIGNING_PRIVATE_KEY": SENTINEL},
    )
    assert missing.returncode == 1


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS tar layout and bundle tooling")
def test_stage_builds_the_tauri_tarball_layout_and_sign_artifacts_signs_it(sandbox: Path) -> None:
    macos = sandbox / "gui/desktop/src-tauri/target/release/bundle/macos"
    contents = macos / "Sharecut Studio.app" / "Contents" / "MacOS"
    contents.mkdir(parents=True)
    (contents / "sharecut").write_text("bin")
    (macos / "Sharecut Studio.app" / "Contents" / "link").symlink_to("MacOS/sharecut")

    done = _run(sandbox, "sign_updater_artifacts.sh", env={"TAURI_SIGNING_PRIVATE_KEY": SENTINEL})
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


def test_sign_bundle_passes_a_key_file_path_as_the_path_variable(sandbox: Path) -> None:
    key_file = sandbox / "updater.key"
    key_file.write_text(SENTINEL, encoding="utf-8")
    bundle = sandbox / "Studio_setup.exe"
    bundle.write_bytes(b"installer")
    for variable in ("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PATH"):
        done = _run(sandbox, "sign_updater_bundle.sh", str(bundle), env={variable: str(key_file)})
        assert done.returncode == 0, done.stderr
        assert (sandbox / "env").read_text().strip() == f"unset||{key_file}"
        assert str(key_file) not in done.stdout + done.stderr


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS tar layout and bundle tooling")
def test_stage_removes_stale_updater_bundles(sandbox: Path) -> None:
    bundle_dir = sandbox / "gui/desktop/src-tauri/target/release/bundle"
    app = bundle_dir / "macos" / "Studio.app" / "Contents"
    app.mkdir(parents=True)
    (app / "x").write_text("x")
    updater = bundle_dir / "updater"
    updater.mkdir()
    for stale in ("Old_0.0.1_x64.app.tar.gz", "Old_0.0.1_x64.app.tar.gz.sig"):
        (updater / stale).write_text("old")
    done = _run(sandbox, "sign_updater_artifacts.sh", env={"TAURI_SIGNING_PRIVATE_KEY": SENTINEL})
    assert done.returncode == 0, done.stderr
    names = sorted(p.name for p in updater.iterdir())
    assert len(names) == 2 and all(n.startswith("Studio_1.2.3_") for n in names)


def test_stage_prints_only_the_tarball_path_when_stapler_is_chatty(sandbox: Path) -> None:
    macos = sandbox / "gui/desktop/src-tauri/target/release/bundle/macos"
    contents = macos / "Sharecut Studio.app" / "Contents" / "MacOS"
    contents.mkdir(parents=True)
    (contents / "sharecut").write_text("bin")
    for name, body in (
        ("codesign", "exit 0\n"),
        ("xcrun", 'echo "Processing: $3"; echo "The validate action worked!"\n'),
    ):
        stub = sandbox / "bin" / name
        stub.write_text("#!/usr/bin/env bash\n" + body, encoding="utf-8")
        stub.chmod(0o755)

    done = _run(
        sandbox,
        "stage_updater_bundle.sh",
        str(sandbox / "out"),
        env={"APPLE_SIGNING_IDENTITY": "Developer ID Application: Test (TEAM)"},
    )
    assert done.returncode == 0, done.stderr
    lines = done.stdout.strip().splitlines()
    assert len(lines) == 1 and lines[0].endswith(".app.tar.gz")
    assert "validate action worked" in done.stderr


def test_stage_restaples_with_retries_before_archiving(sandbox: Path) -> None:
    macos = sandbox / "gui/desktop/src-tauri/target/release/bundle/macos"
    contents = macos / "Sharecut Studio.app" / "Contents" / "MacOS"
    contents.mkdir(parents=True)
    (contents / "sharecut").write_text("bin")
    counter = sandbox / "staple-count"
    stubs = {
        "codesign": "exit 0\n",
        # The first staple attempt fails (ticket not yet published); the next works.
        "xcrun": (
            'if [[ "$2" == "staple" ]]; then\n'
            f'  n=$(cat "{counter}" 2>/dev/null || echo 0); echo $((n + 1)) > "{counter}"\n'
            "  [[ $n -ge 1 ]] || exit 65\n"
            "fi\n"
            "exit 0\n"
        ),
    }
    for name, body in stubs.items():
        stub = sandbox / "bin" / name
        stub.write_text("#!/usr/bin/env bash\n" + body, encoding="utf-8")
        stub.chmod(0o755)

    done = _run(
        sandbox,
        "stage_updater_bundle.sh",
        str(sandbox / "out"),
        env={
            "APPLE_SIGNING_IDENTITY": "Developer ID Application: Test (TEAM)",
            "STAPLE_RETRY_DELAY": "0",
        },
    )
    assert done.returncode == 0, done.stderr
    assert "stapling attempt 1/8 failed" in done.stderr
    assert counter.read_text().strip() == "2"
    assert len(done.stdout.strip().splitlines()) == 1


def test_stage_fails_when_no_ticket_can_be_stapled(sandbox: Path) -> None:
    macos = sandbox / "gui/desktop/src-tauri/target/release/bundle/macos"
    contents = macos / "Sharecut Studio.app" / "Contents" / "MacOS"
    contents.mkdir(parents=True)
    (contents / "sharecut").write_text("bin")
    for name, body in (("codesign", "exit 0\n"), ("xcrun", "exit 65\n")):
        stub = sandbox / "bin" / name
        stub.write_text("#!/usr/bin/env bash\n" + body, encoding="utf-8")
        stub.chmod(0o755)

    done = _run(
        sandbox,
        "stage_updater_bundle.sh",
        str(sandbox / "out"),
        env={
            "APPLE_SIGNING_IDENTITY": "Developer ID Application: Test (TEAM)",
            "STAPLE_ATTEMPTS": "2",
            "STAPLE_RETRY_DELAY": "0",
        },
    )
    assert done.returncode != 0
    assert "could not staple a notarization ticket" in done.stderr


def test_stage_accepts_an_identical_archive_when_only_the_copy_cannot_be_validated(
    sandbox: Path,
) -> None:
    macos = sandbox / "gui/desktop/src-tauri/target/release/bundle/macos"
    contents = macos / "Sharecut Studio.app" / "Contents" / "MacOS"
    contents.mkdir(parents=True)
    (contents / "sharecut").write_text("bin")
    for name, body in (
        ("codesign", "exit 0\n"),
        # Validating the extracted copy needs Apple, and the network drops.
        ("xcrun", '[[ "$2" == "validate" && "$3" == *updater-verify* ]] && exit 68\nexit 0\n'),
    ):
        stub = sandbox / "bin" / name
        stub.write_text("#!/usr/bin/env bash\n" + body, encoding="utf-8")
        stub.chmod(0o755)

    done = _run(
        sandbox,
        "stage_updater_bundle.sh",
        str(sandbox / "out"),
        env={
            "APPLE_SIGNING_IDENTITY": "Developer ID Application: Test (TEAM)",
            "STAPLE_RETRY_DELAY": "0",
        },
    )
    assert done.returncode == 0, done.stderr
    assert "identical to the stapled source app" in done.stderr
    assert len(done.stdout.strip().splitlines()) == 1
