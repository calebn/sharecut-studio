"""The whisper.cpp pins, patch and build script for the iOS app (scripts/ios/build_whisper.sh), checked without a Mac."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
GLUE_DIR = ROOT / "gui" / "desktop" / "src-tauri" / "ios" / "whisper"
PATCH_DIR = GLUE_DIR / "patches"
SCRIPT = ROOT / "scripts" / "ios" / "build_whisper.sh"
CONTRACT = ROOT / "contracts" / "whisper-build.json"
TARBALL_ENV = "SC_WHISPER_SOURCE_TARBALL"
EXPORTED = ["sc_whisper_abi_version", "sc_whisper_start", "sc_whisper_wait", "sc_whisper_cancel"]
OWN_C_FILES = [
    "sc_whisper_glue.cpp",
    "sc_whisper_cli.cpp",
    "sc_whisper_stdio.h",
    "sc_whisper_exit_map.h",
]


def contract() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(CONTRACT.read_text(encoding="utf-8"))
    return loaded


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_contract_pins_one_source_by_sha256_and_commit() -> None:
    pinned = contract()
    source = pinned["sources"]["whisper"]
    assert list(pinned["sources"]) == ["whisper"]
    assert re.fullmatch(r"[0-9a-f]{64}", source["sha256"])
    assert re.fullmatch(r"[0-9a-f]{40}", pinned["commit"])
    assert pinned["tag"] == f"v{pinned['version']}"
    assert source["url"].startswith("https://codeload.github.com/ggml-org/whisper.cpp/")
    assert source["url"].endswith(f"/{pinned['tag']}")
    assert source["archive"] == f"whisper.cpp-{pinned['version']}.tar.gz"
    assert source["directory"] == f"whisper.cpp-{pinned['version']}"
    assert pinned["minos"] == "17.0"


def test_contract_exports_exactly_the_four_core_header_symbols() -> None:
    header = (GLUE_DIR / "sc_whisper_core.h").read_text(encoding="utf-8")
    assert re.findall(r"SC_EXPORT \w+\s+\**(sc_whisper_\w+)\(", header) == EXPORTED
    assert contract()["exports"] == EXPORTED


def test_contract_builds_cpu_only_and_statically() -> None:
    flags = contract()["cmake_configure"]
    for flag in (
        "-DGGML_METAL=OFF",
        "-DGGML_BACKEND_DL=OFF",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DWHISPER_BUILD_EXAMPLES=OFF",
        "-DWHISPER_COREML=OFF",
        "-DGGML_ACCELERATE=ON",
    ):
        assert flag in flags
    assert not [flag for flag in flags if "GGML_METAL=ON" in flag or "CUDA" in flag]


def test_contract_pins_the_patch_by_sha256() -> None:
    patches = contract()["patches"]
    assert [p["name"] for p in patches] == ["whisper-cli-hooks"]
    on_disk = sorted(p.name for p in PATCH_DIR.glob("*.patch"))
    assert on_disk == sorted(f"{p['name']}.patch" for p in patches)
    for patch in patches:
        path = ROOT / patch["path"]
        assert path.parent == PATCH_DIR and path.name == f"{patch['name']}.patch"
        assert sha256(path) == patch["sha256"]
        assert patch["applies_to"] == "whisper"


def test_patch_touches_only_the_known_files() -> None:
    text = (PATCH_DIR / "whisper-cli-hooks.patch").read_text(encoding="utf-8")
    assert re.findall(r"^\+\+\+ b/(\S+)", text, re.M) == [
        "examples/cli/cli.cpp",
        "examples/common-whisper.cpp",
        "ggml/src/ggml.c",
    ]
    assert "sc_whisper_aborted()" in text and "-    ggml_backend_load_all();" in text
    assert "&& !TARGET_OS_IPHONE)" in text


def test_cli_sources_are_the_ones_cli_includes() -> None:
    assert contract()["cli_sources"] == [
        "examples/common.cpp",
        "examples/common-whisper.cpp",
        "examples/grammar-parser.cpp",
    ]


def test_no_gpl_flag_and_no_other_engine_in_the_contract() -> None:
    text = CONTRACT.read_text(encoding="utf-8").lower()
    for word in ("gpl", "ffmpeg", "cuda", "openblas"):
        assert word not in text


def test_own_files_have_one_header_line_only() -> None:
    for name in OWN_C_FILES:
        text = (GLUE_DIR / name).read_text(encoding="utf-8")
        assert text.startswith("/* ") and text.splitlines()[0].endswith(" */"), name
        assert "/*" not in "\n".join(text.splitlines()[1:]), name
        assert "//" not in text, name


def test_wrapper_and_forced_include_headers() -> None:
    assert '#include "cli.cpp"' in (GLUE_DIR / "sc_whisper_cli.cpp").read_text(encoding="utf-8")
    exit_map = (GLUE_DIR / "sc_whisper_exit_map.h").read_text(encoding="utf-8")
    assert "#define exit(code) sc_tool_exit(code)" in exit_map
    assert "#define abort() sc_tool_exit(134)" in exit_map
    assert "using ::sc_tool_exit;" in exit_map
    stdio = (GLUE_DIR / "sc_whisper_stdio.h").read_text(encoding="utf-8")
    assert stdio.index("#include <cstdio>") < stdio.index("#define printf(")
    for line in ("#define stdout (sc_out())", "#define stderr (sc_err())"):
        assert line in stdio


SCRIPT_FRAGMENTS = [
    "CONTRACT=$ROOT/contracts/whisper-build.json",
    "GLUE=$ROOT/gui/desktop/src-tauri/ios/whisper",
    "-miphoneos-version-min=$MINOS",
    "-mios-simulator-version-min=$MINOS",
    "-arch arm64",
    "-DCMAKE_SYSTEM_NAME=iOS",
    "-DCMAKE_OSX_ARCHITECTURES=arm64",
    "-fvisibility=hidden",
    'FORCE="-include sc_whisper_exit_map.h -I$GLUE"',
    "-include sc_whisper_stdio.h -include sc_whisper_exit_map.h",
    'compile_tool "$GLUE/sc_whisper_cli.cpp" -Dmain=sc_whisper_cli_main',
    'compile_plain "$GLUE/sc_whisper_core.c"',
    'compile_glue "$GLUE/sc_whisper_glue.cpp"',
    "patch -p1 --dry-run --batch --quiet",
    '"--proto", "=https"',
    "sha256 mismatch for %s; the download was removed",
    "sha256 mismatch for patch %s",
    "-install_name @rpath/Whisper.framework/Whisper",
    "-Wl,-dead_strip -Wl,-x",
    "-framework Accelerate -lc++ -lm",
    "-exported_symbols_list",
    "nm -gU",
    "export LC_ALL=C TZ=UTC ZERO_AR_DATE=1",
    "<key>CFBundleIdentifier</key><string>studio.sharecut.whisper</string>",
    "<key>CFBundleExecutable</key><string>Whisper</string>",
    "<key>MinimumOSVersion</key><string>$MINOS</string>",
    "<key>CFBundleSupportedPlatforms</key><array><string>$PLATFORM_NAME</string></array>",
]


@pytest.mark.parametrize("fragment", SCRIPT_FRAGMENTS)
def test_build_script_keeps_each_load_bearing_line(fragment: str) -> None:
    assert fragment in SCRIPT.read_text(encoding="utf-8")


def test_build_script_never_links_libcxx_statically_or_loads_metal() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    assert "-static-libc++" not in text and "Metal" not in text


@pytest.mark.skipif(sys.platform == "darwin", reason="a Mac has xcrun")
@pytest.mark.parametrize(("platform", "sdk"), [("device", "iPhoneOS"), ("sim", "iPhoneSimulator")])
def test_build_script_names_the_missing_sdk_before_touching_anything(
    platform: str, sdk: str
) -> None:
    bash = shutil.which("bash")
    assert bash is not None
    done = subprocess.run(
        [bash, str(SCRIPT), platform], capture_output=True, text=True, check=False
    )
    assert done.returncode == 1
    assert f"xcrun not found: this build needs Xcode and the {sdk} SDK" in done.stderr


def test_build_script_rejects_an_unknown_platform() -> None:
    bash = shutil.which("bash")
    assert bash is not None
    done = subprocess.run([bash, str(SCRIPT), "mac"], capture_output=True, text=True, check=False)
    assert done.returncode == 2 and "usage:" in done.stderr


def pins_program() -> str:
    text = SCRIPT.read_text(encoding="utf-8")
    start = text.index("<<'PY'\n") + len("<<'PY'\n")
    return text[start : text.index("\nPY\n", start)] + "\n"


def run_pins(
    tmp: Path,
    archive_data: bytes = b"archive",
    patch_sha: str | None = None,
    local: Path | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path]:
    src = tmp / "src"
    src.mkdir(exist_ok=True)
    (tmp / "patch.diff").write_bytes(b"patch")
    pinned = {
        "archive": "whisper.tar",
        "url": "https://example.invalid/x",
        "sha256": hashlib.sha256(b"archive").hexdigest(),
    }
    if local is None:
        (src / "whisper.tar").write_bytes(archive_data)
    patch = {
        "name": "p",
        "path": "patch.diff",
        "sha256": patch_sha or hashlib.sha256(b"patch").hexdigest(),
    }
    contract_file = tmp / "contract.json"
    contract_file.write_text(
        json.dumps({"sources": {"whisper": pinned}, "patches": [patch]}), "utf-8"
    )
    done = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            pins_program(),
            str(contract_file),
            str(src),
            str(tmp),
            str(local or ""),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return done, src


def test_pin_check_passes_a_good_archive_and_lists_the_patch(tmp_path: Path) -> None:
    done, _ = run_pins(tmp_path)
    assert done.returncode == 0, done.stderr
    assert done.stdout == "patch.diff\n"


def test_pin_check_removes_a_download_with_the_wrong_checksum(tmp_path: Path) -> None:
    done, src = run_pins(tmp_path, archive_data=b"tampered")
    assert done.returncode != 0
    assert "sha256 mismatch for whisper.tar; the download was removed" in done.stderr
    assert not (src / "whisper.tar").exists()


def test_pin_check_takes_a_local_tarball_and_still_checks_it(tmp_path: Path) -> None:
    good = tmp_path / "good.bin"
    good.write_bytes(b"archive")
    done, src = run_pins(tmp_path, local=good)
    assert done.returncode == 0, done.stderr
    assert (src / "whisper.tar").read_bytes() == b"archive"
    bad = tmp_path / "bad.bin"
    bad.write_bytes(b"other")
    (src / "whisper.tar").unlink()
    done, _ = run_pins(tmp_path, local=bad)
    assert done.returncode != 0 and "sha256 mismatch for whisper.tar" in done.stderr


def test_pin_check_rejects_a_patch_that_differs_from_its_pin(tmp_path: Path) -> None:
    done, _ = run_pins(tmp_path, patch_sha="0" * 64)
    assert done.returncode != 0
    assert "sha256 mismatch for patch p" in done.stderr


@pytest.mark.skipif(
    not os.environ.get(TARBALL_ENV), reason=f"set {TARBALL_ENV} to the pinned tarball"
)
def test_patch_applies_cleanly_to_the_pinned_tarball(tmp_path: Path) -> None:
    archive = Path(os.environ[TARBALL_ENV])
    source = contract()["sources"]["whisper"]
    assert sha256(archive) == source["sha256"]
    with tarfile.open(archive) as handle:
        handle.extractall(tmp_path, filter="data")
    tree = tmp_path / source["directory"]
    patch = ROOT / contract()["patches"][0]["path"]
    for extra in ("--dry-run", ""):
        done = subprocess.run(
            ["patch", "-p1", "--batch", "--quiet", *([extra] if extra else []), "-i", str(patch)],
            cwd=tree,
            capture_output=True,
            text=True,
            check=False,
        )
        assert done.returncode == 0, done.stdout + done.stderr
    assert "sc_whisper_aborted" in (tree / "examples/cli/cli.cpp").read_text(encoding="utf-8")
    assert "ggml_backend_load_all()" not in (tree / "examples/cli/cli.cpp").read_text(
        encoding="utf-8"
    )
