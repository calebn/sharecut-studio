"""scripts/ios/private_paths.py: remap flags, release environment and the scan the payload and the app share."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from script_loader import load_script

paths = load_script("ios/private_paths", register=True)


def test_rust_flags_are_appended_to_the_variable_cargo_reads() -> None:
    flags = ["--remap-path-prefix=/a=/x"]
    assert paths.with_rustflags({}, flags) == {"RUSTFLAGS": "--remap-path-prefix=/a=/x"}
    assert paths.with_rustflags({"RUSTFLAGS": "-C debuginfo=0"}, flags) == {
        "RUSTFLAGS": "-C debuginfo=0 --remap-path-prefix=/a=/x"
    }
    assert paths.with_rustflags(
        {"RUSTFLAGS": "ignored", "CARGO_ENCODED_RUSTFLAGS": "-Cdebuginfo=0"}, flags
    ) == {
        "RUSTFLAGS": "ignored",
        "CARGO_ENCODED_RUSTFLAGS": "-Cdebuginfo=0\x1f--remap-path-prefix=/a=/x",
    }


def test_the_remap_goes_widest_directory_first() -> None:
    assert paths.remap_flags(
        {
            "source": Path("/h/c/s"),
            "home": Path("/h"),
            "cache": Path("/h/c"),
            "cargo": Path("/h/.cargo"),
        }
    ) == [
        "--remap-path-prefix=/h=/home",
        "--remap-path-prefix=/h/c=/cache",
        "--remap-path-prefix=/h/.cargo=/cargo",
        "--remap-path-prefix=/h/c/s=/source",
    ]


def test_a_clean_tree_scans_clean_and_a_leak_names_the_file(tmp_path: Path) -> None:
    home = Path("/Users/someone")
    needles = paths.private_needles(home, home / ".cache/sharecut-build/ios")
    tree = tmp_path / "tree"
    (tree / "pkg").mkdir(parents=True)
    (tree / "pkg/clean.py").write_text("print('hi')\n")
    (tree / "pkg/clean.so").write_bytes(b"\xcf\xfa\xed\xfe/cargo/registry/src/x.rs\x00")
    assert paths.scan_private_paths(tree, needles) == (2, [])
    (tree / "pkg/leaky.so").write_bytes(b"\x00\x00/Users/someone/.cargo/registry/src/x.rs\x00")
    (tree / "pkg/note.txt").write_text("see file:///Users/someone/code/Cargo.toml")
    assert paths.scan_private_paths(tree, needles) == (4, ["pkg/leaky.so", "pkg/note.txt"])


def test_the_user_name_as_a_path_segment_is_a_needle() -> None:
    needles = paths.private_needles(Path("/home/ci"), Path("/home/ci/.cache"))
    assert needles == [b"/home/ci", b"/Users/ci/", b"/home/ci/.cache"]


def test_the_release_environment_remaps_and_turns_debug_info_off() -> None:
    directories = {"home": Path("/Users/x"), "source": Path("/Users/x/repo")}
    assert paths.release_rust_environment(
        {"PATH": "/bin", "RUSTFLAGS": "-C opt-level=3"}, directories
    ) == {
        "PATH": "/bin",
        "RUSTFLAGS": "-C opt-level=3 --remap-path-prefix=/Users/x=/home "
        "--remap-path-prefix=/Users/x/repo=/source",
        "CARGO_PROFILE_RELEASE_DEBUG": "0",
        "CARGO_PROFILE_RELEASE_STRIP": "symbols",
    }


def test_rust_env_prints_only_what_it_changes_as_shell_exports(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("HOME", "/Users/x")
    monkeypatch.setenv("CARGO_HOME", "/opt/cargo")
    monkeypatch.setenv("PATH", "/bin")
    monkeypatch.delenv("RUSTFLAGS", raising=False)
    monkeypatch.setattr(paths, "ROOT", Path("/Users/x/repo"))
    assert paths.main(["rust-env"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "export CARGO_PROFILE_RELEASE_DEBUG=0",
        "export CARGO_PROFILE_RELEASE_STRIP=symbols",
        "export RUSTFLAGS='--remap-path-prefix=/Users/x=/home "
        "--remap-path-prefix=/Users/x/.cache/sharecut-build/ios=/cache "
        "--remap-path-prefix=/opt/cargo=/cargo --remap-path-prefix=/Users/x/repo=/source'",
    ]


def test_an_ipa_is_unpacked_before_it_is_scanned(tmp_path: Path) -> None:
    needles = paths.private_needles(Path("/Users/x"), Path("/Users/x/.cache"))
    ipa = tmp_path / "App.ipa"
    with zipfile.ZipFile(ipa, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("Payload/App.app/App", b"\x00" + b"/Users/x/.cargo/registry/a.rs " * 50)
        archive.writestr("Payload/App.app/Info.plist", b"<plist/>")
    assert needles[0] not in ipa.read_bytes()
    assert paths.scan_artifact(ipa, needles) == (2, ["Payload/App.app/App"])


def test_the_scan_command_fails_on_a_hit_and_counts_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("HOME", "/Users/x")
    app = tmp_path / "App.app"
    app.mkdir()
    (app / "App").write_bytes(b"clean")
    assert paths.main(["scan", str(app)]) == 0
    assert capsys.readouterr().out == "App.app: 1 files scanned, 0 name this machine\n"
    (app / "App").write_bytes(b"at /Users/x/code/main.rs")
    assert paths.main(["scan", str(app)]) == 1
    assert capsys.readouterr().out == "App.app: 1 files scanned, 1 name this machine\n  App\n"
