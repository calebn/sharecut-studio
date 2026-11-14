"""scripts/ios/private_paths.py: remap flags, release environment and the scan the payload and the app share."""

from __future__ import annotations

import io
import struct
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


def macho(section: str, payload: bytes) -> bytes:
    """A thin 64-bit Mach-O with one segment holding one section that starts the data."""
    header_size = 32 + 72 + 80
    segment = struct.pack("<II16sQQQQiiII", 0x19, 72 + 80, b"__TEXT", 0, 0, 0, 0, 5, 5, 1, 0)
    name, _, sect = section.partition(",")
    section_header = struct.pack(
        "<16s16sQQIIIIIIII",
        sect.encode(),
        name.encode(),
        0,
        len(payload),
        header_size,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    )
    header = struct.pack("<IiiIIIII", 0xFEEDFACF, 0x100000C, 0, 2, 1, 72 + 80, 0, 0)
    return header + segment + section_header + payload


def test_the_needles_cover_every_spelling_in_utf8_and_utf16() -> None:
    forms = paths.needle_strings([Path("/Users/someone/My Code")])
    assert "/Users/someone/My Code" in forms
    assert "/Users/someone/My%20Code" in forms
    assert "%2FUsers%2Fsomeone%2FMy%20Code" in forms
    assert "\\/Users\\/someone\\/My Code" in forms
    needles = paths.private_needles(Path("/home/ci"), Path("/home/ci/.cache"))
    assert b"/home/ci" in needles
    assert "/Users/ci/".encode("utf-16-le") in needles
    assert b"/home/ci/.cache" in needles


def test_a_clean_tree_scans_clean_and_a_leak_names_the_file(tmp_path: Path) -> None:
    needles = paths.private_needles(Path("/Users/someone"), Path("/Users/someone/.cache"))
    tree = tmp_path / "tree"
    (tree / "pkg").mkdir(parents=True)
    (tree / "pkg/clean.py").write_text("print('hi')\n")
    (tree / "pkg/clean.so").write_bytes(b"\xcf\xfa\xed\xfe/cargo/registry/src/x.rs\x00")
    report = paths.scan_tree(tree, needles)
    assert (report.files_scanned, report.clean) == (2, True)
    (tree / "pkg/leaky.so").write_bytes(b"\x00\x00/Users/someone/.cargo/registry/src/x.rs\x00")
    (tree / "pkg/note.txt").write_text("see file:///Users/someone/code/Cargo.toml")
    (tree / "pkg/wide.bin").write_bytes("/Users/someone/x".encode("utf-16-le"))
    report = paths.scan_tree(tree, needles)
    assert report.files_scanned == 5
    assert report.offenders == ["pkg/leaky.so", "pkg/note.txt", "pkg/wide.bin"]
    assert "someone" not in "".join(hit.context for hit in report.hits)


def test_the_user_name_as_a_path_segment_is_a_needle() -> None:
    needles = paths.private_needles(Path("/home/someone"), Path("/home/someone/.cache"))
    assert b"/Users/someone/" in needles


def test_a_hit_in_a_mach_o_names_its_section(tmp_path: Path) -> None:
    needles = paths.private_needles(Path("/Users/someone"), Path("/Users/someone/.cache"))
    (tmp_path / "bin").write_bytes(macho("__TEXT,__cstring", b"\0/Users/someone/.cargo/a.rs\0"))
    (tmp_path / "debug").write_bytes(
        macho("__DWARF,__debug_str", b"\0/Users/someone/.cargo/b.rs\0")
    )
    report = paths.scan_tree(tmp_path, needles)
    assert sorted((hit.member, hit.section) for hit in report.hits) == [
        ("bin", "__TEXT,__cstring"),
        ("debug", "__DWARF,__debug_str"),
    ]
    assert report.hits[0].context == "<private>.cargo/a.rs"


def test_an_ipa_is_decompressed_and_nested_archives_are_opened(tmp_path: Path) -> None:
    needles = paths.private_needles(Path("/Users/someone"), Path("/Users/someone/.cache"))
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as nested:
        nested.writestr("deep.txt", b"in /Users/someone/code " * 20)
    ipa = tmp_path / "App.ipa"
    with zipfile.ZipFile(ipa, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "Payload/App.app/App", b"\x00" + b"/Users/someone/.cargo/registry/a.rs " * 50
        )
        archive.writestr("Payload/App.app/Info.plist", b"<plist/>")
        archive.writestr("Payload/App.app/Assets.car", b"opaque")
        archive.writestr("Payload/App.app/extra.zip", inner.getvalue())
    assert needles[0] not in ipa.read_bytes()
    report = paths.scan_zip(ipa, needles)
    assert report.archives_opened == 2
    assert report.offenders == [
        "Payload/App.app/App",
        "Payload/App.app/extra.zip!deep.txt",
    ]
    assert report.unseen == ("Payload/App.app/Assets.car",)


def test_the_attribution_groups_repeated_hits_by_section_and_folds_versions(tmp_path: Path) -> None:
    needles = paths.private_needles(Path("/Users/someone"), Path("/Users/someone/.cache"))
    (tmp_path / "bin").write_bytes(
        macho(
            "__TEXT,__cstring",
            b"\0/Users/someone/.cargo/tokio-1.2.3/a.rs\0/Users/someone/.cargo/tokio-1.9.0/a.rs\0",
        )
    )
    attribution = paths.scan_tree(tmp_path, needles).attribution()
    assert [(count, section) for count, section, _ in attribution] == [(2, "__TEXT,__cstring")]


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


def test_the_scan_command_fails_on_a_hit_and_reports_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("HOME", "/Users/x")
    app = tmp_path / "App.app"
    app.mkdir()
    (app / "App").write_bytes(b"clean")
    assert paths.main(["scan", str(app)]) == 0
    assert capsys.readouterr().out == (
        "App.app: 1 files, 0 archives opened, 0 hits, 0 not readable\n"
    )
    (app / "App").write_bytes(b"at /Users/x/code/main.rs")
    assert paths.main(["scan", str(app)]) == 1
    assert capsys.readouterr().out.splitlines() == [
        "App.app: 1 files, 0 archives opened, 1 hits, 0 not readable",
        "      1  -                     at <private>code/main.rs",
    ]
