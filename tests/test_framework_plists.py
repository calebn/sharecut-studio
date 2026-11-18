"""Nested framework Info.plist files: fix and check, over a tree shaped like the real ipa (#3955)."""

from __future__ import annotations

import os
import plistlib
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from scripts.ios import framework_plists as fp

APP_ID = "studio.sharecut.app"
MODULES = [f"numpy.mod{index}._part{index}" for index in range(87)] + ["numpy.random._pcg64"]


def write_plist(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY))


def appl_plist(module: str) -> dict[str, object]:
    return {
        "CFBundleExecutable": module,
        "CFBundleIdentifier": f"{APP_ID}.{module.replace('_', '-')}",
        "CFBundlePackageType": "APPL",
        "MinimumOSVersion": "13.0",
        "CFBundleSupportedPlatforms": ["iPhoneOS"],
    }


def make_tree(root: Path, modules: list[str] = MODULES) -> Path:
    app = root / "ShareCut.app"
    write_plist(
        app / "Info.plist",
        {
            "CFBundleIdentifier": APP_ID,
            "CFBundleVersion": "1.2.3",
            "CFBundleShortVersionString": "2026.1117",
        },
    )
    for module in modules:
        folder = app / "Frameworks" / f"{module}.framework"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / module).write_bytes(b"\xcf\xfa\xed\xfe")
        write_plist(folder / "Info.plist", appl_plist(module))
    python = app / "Frameworks" / "Python.framework"
    python.mkdir(parents=True)
    (python / "Python").write_bytes(b"\xcf\xfa\xed\xfe")
    write_plist(
        python / "Info.plist",
        {
            "CFBundleExecutable": "Python",
            "CFBundleIdentifier": "org.python.python",
            "CFBundlePackageType": "FMWK",
            "MinimumOSVersion": "13.0",
        },
    )
    return app


def load(app: Path, name: str) -> dict[str, object]:
    return plistlib.loads((app / "Frameworks" / name / "Info.plist").read_bytes())


def test_fix_turns_every_appl_framework_into_fmwk_and_a_second_run_reports_none(
    tmp_path: Path,
) -> None:
    app = make_tree(tmp_path)
    changed = fp.fix(app)
    assert len(changed) == 88
    assert "Frameworks/numpy.random._pcg64.framework" in changed
    assert fp.fix(app) == []
    assert fp.check(app) == []


def test_fixed_plist_is_well_formed_and_aligned(tmp_path: Path) -> None:
    app = make_tree(tmp_path)
    fp.fix(app)
    plist = load(app, "numpy.random._pcg64.framework")
    assert plist["CFBundlePackageType"] == "FMWK"
    assert plist["CFBundleIdentifier"] == "studio.sharecut.app.numpy.random.p-pcg64"
    assert plist["CFBundleExecutable"] == "numpy.random._pcg64"
    assert plist["MinimumOSVersion"] == "17.0"
    assert plist["CFBundleSupportedPlatforms"] == ["iPhoneOS"]


def test_a_valid_fmwk_such_as_python_is_left_byte_for_byte_alone(tmp_path: Path) -> None:
    app = make_tree(tmp_path)
    path = app / "Frameworks/Python.framework/Info.plist"
    before = path.read_bytes()
    assert "Frameworks/Python.framework" not in fp.fix(app)
    assert path.read_bytes() == before
    assert fp.check(app) == []


def test_a_framework_without_a_plist_gets_one(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["numpy.core._multiarray"])
    (app / "Frameworks/numpy.core._multiarray.framework/Info.plist").unlink()
    assert fp.fix(app) == ["Frameworks/numpy.core._multiarray.framework"]
    plist = load(app, "numpy.core._multiarray.framework")
    assert plist["CFBundlePackageType"] == "FMWK"
    assert plist["CFBundleExecutable"] == "numpy.core._multiarray"
    assert plist["CFBundleVersion"] == "1.2.3"
    assert plist["CFBundleShortVersionString"] == "2026.1117"
    assert plist["MinimumOSVersion"] == "17.0"
    assert fp.check(app) == []


def test_a_framework_without_plist_or_executable_fails_the_build(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["numpy.core._multiarray"])
    folder = app / "Frameworks/numpy.core._multiarray.framework"
    (folder / "Info.plist").unlink()
    (folder / "numpy.core._multiarray").unlink()
    with pytest.raises(FileNotFoundError):
        fp.fix(app)


def test_check_names_each_kind_of_problem(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["a.one", "b.two", "c.three", "d.four"])
    frameworks = app / "Frameworks"
    (frameworks / "a.one.framework/Info.plist").unlink()
    write_plist(frameworks / "b.two.framework/Info.plist", appl_plist("b.two"))
    write_plist(
        frameworks / "c.three.framework/Info.plist",
        {
            **appl_plist("c.three"),
            "CFBundlePackageType": "FMWK",
            "CFBundleIdentifier": f"{APP_ID}.-c",
        },
    )
    write_plist(
        frameworks / "d.four.framework/Info.plist",
        {**appl_plist("d.four"), "CFBundlePackageType": "FMWK", "CFBundleIdentifier": APP_ID},
    )
    problems = fp.check(app)
    assert any("a.one.framework" in p and "Info.plist" in p for p in problems)
    assert any("b.two.framework" in p and "APPL" in p for p in problems)
    assert any("c.three.framework" in p and "identifier" in p for p in problems)
    assert any("d.four.framework" in p and "app" in p for p in problems)


def test_check_names_duplicate_identifiers_ignoring_case(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["x.one", "x.two"])
    for name, identifier in (("x.one", f"{APP_ID}.Same"), ("x.two", f"{APP_ID}.same")):
        write_plist(
            app / f"Frameworks/{name}.framework/Info.plist",
            {**appl_plist(name), "CFBundlePackageType": "FMWK", "CFBundleIdentifier": identifier},
        )
    assert any("duplicate" in problem for problem in fp.check(app))


def test_check_names_a_wrong_executable_and_an_unreadable_plist(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["e.one", "e.two"])
    write_plist(
        app / "Frameworks/e.one.framework/Info.plist",
        {**appl_plist("e.one"), "CFBundlePackageType": "FMWK", "CFBundleExecutable": "other"},
    )
    (app / "Frameworks/e.two.framework/Info.plist").write_bytes(b"x")
    problems = fp.check(app)
    assert any("e.one.framework" in p and "CFBundleExecutable" in p for p in problems)
    assert any("e.two.framework" in p and "unreadable" in p for p in problems)


def test_the_real_python_identifier_is_accepted() -> None:
    assert fp.IDENTIFIER.fullmatch("org.python.python")
    assert fp.IDENTIFIER.fullmatch("studio.sharecut.app.numpy.random-pcg64")
    assert not fp.IDENTIFIER.fullmatch("studio.sharecut.app.numpy.random.-pcg64")


def test_a_segment_that_cannot_be_repaired_raises() -> None:
    with pytest.raises(ValueError):
        fp.fixed_identifier(APP_ID, "bad!name")


def test_the_cli_prints_changed_paths_then_nothing_and_check_exits_by_result(
    tmp_path: Path,
) -> None:
    app = make_tree(tmp_path, ["numpy.random._pcg64"])
    script = Path(fp.__file__)

    def run(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-I", str(script), *args, str(app)],
            capture_output=True,
            text=True,
            check=False,
        )

    assert run("check").returncode == 1
    first = run("fix")
    assert first.stdout.split() == ["Frameworks/numpy.random._pcg64.framework"]
    assert run("fix").stdout == ""
    assert run("check").returncode == 0


def test_malformed_xml_is_a_problem_for_check_and_an_error_for_fix(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["m.one"])
    broken = b"<?xml version='1.0'?><plist><dict><key>CFBundleIdentifier</key>"
    (app / "Frameworks/m.one.framework/Info.plist").write_bytes(broken)
    assert any("unreadable" in problem for problem in fp.check(app))
    with pytest.raises(ValueError):
        fp.fix(app)


def test_a_failing_framework_leaves_every_plist_unwritten(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["good.one", "bad!name"])
    before = (app / "Frameworks/good.one.framework/Info.plist").read_bytes()
    with pytest.raises(ValueError):
        fp.fix(app)
    assert (app / "Frameworks/good.one.framework/Info.plist").read_bytes() == before


def test_symlinked_plists_and_folders_are_refused(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["s.one", "s.two"])
    app_plist = (app / "Info.plist").read_bytes()
    plist = app / "Frameworks/s.one.framework/Info.plist"
    plist.unlink()
    plist.symlink_to(app / "Info.plist")
    assert any("symlinked" in problem for problem in fp.check(app))
    with pytest.raises(ValueError):
        fp.fix(app)
    assert (app / "Info.plist").read_bytes() == app_plist
    plist.unlink()
    (app / "Frameworks/s.two.framework").rename(tmp_path / "elsewhere")
    (app / "Frameworks/s.two.framework").symlink_to(tmp_path / "elsewhere")
    assert any("s.two.framework" in p and "symlink" in p for p in fp.check(app))


def test_nested_frameworks_anywhere_and_non_directories_are_covered(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["n.one"])
    write_plist(app / "app_packages/pkg.framework/Info.plist", appl_plist("pkg"))
    (app / "Frameworks/file.framework").write_bytes(b"x")
    problems = fp.check(app)
    assert any("app_packages/pkg.framework" in p and "APPL" in p for p in problems)
    assert any("file.framework" in p and "not a directory" in p for p in problems)


def test_double_and_trailing_underscores_stay_buildable_and_collisions_are_caught(
    tmp_path: Path,
) -> None:
    for stem in ("numpy.__init", "numpy.foo_", "numpy._pcg64_"):
        assert fp.IDENTIFIER.fullmatch(fp.fixed_identifier(APP_ID, stem))
    app = make_tree(tmp_path, ["numpy.random._pcg64", "numpy.random.p_pcg64"])
    fp.fix(app)
    assert any("duplicate" in problem for problem in fp.check(app))


def test_list_prints_only_the_generated_frameworks(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["numpy.random._pcg64"])
    fp.fix(app)
    assert fp.generated(app) == ["Frameworks/numpy.random._pcg64.framework"]


ROOT = Path(__file__).resolve().parents[1]


def deep_bplist(depth: int) -> bytes:
    out = bytearray(b"bplist00")
    offsets = []
    for index in range(depth):
        offsets.append(len(out))
        out += b"\xa1" + (index + 1).to_bytes(4, "big")
    offsets.append(len(out))
    out += b"\x10\x01"
    table = len(out)
    for offset in offsets:
        out += offset.to_bytes(4, "big")
    out += bytes(6) + bytes([4, 4])
    out += (depth + 1).to_bytes(8, "big") + (0).to_bytes(8, "big") + table.to_bytes(8, "big")
    return bytes(out)


def fifo_app(root: Path) -> Path:
    app = make_tree(root, [])
    folder = app / "Frameworks" / "x.framework"
    folder.mkdir()
    (folder / "x").write_bytes(b"\xcf\xfa\xed\xfe")
    os.mkfifo(folder / "Info.plist")
    return app


@pytest.mark.parametrize("call", ["fp.fix", "fp.check", "bc.check_layout"])
def test_fifo_plist_is_refused(tmp_path: Path, call: str) -> None:
    app = fifo_app(tmp_path)
    code = (
        "import sys; from pathlib import Path; "
        "from scripts.ios import framework_plists as fp, bundle_checks as bc; "
        f"{call}(Path(sys.argv[1]))"
    )
    try:
        subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                f"import sys; sys.path.insert(0, {str(ROOT)!r}); {code}",
                str(app),
            ],
            timeout=10,
            capture_output=True,
            check=False,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(f"{call} hung on a FIFO Info.plist")


def test_deep_binary_plist_is_a_value_error(tmp_path: Path) -> None:
    path = tmp_path / "Info.plist"
    path.write_bytes(deep_bplist(5000))
    with pytest.raises(ValueError):
        fp.read_plist(path)


def test_deep_binary_plist_is_a_check_problem_not_a_crash(tmp_path: Path) -> None:
    app = make_tree(tmp_path, [])
    folder = app / "Frameworks" / "x.framework"
    folder.mkdir()
    (folder / "x").write_bytes(b"\xcf\xfa\xed\xfe")
    (folder / "Info.plist").write_bytes(deep_bplist(5000))
    assert any("x.framework" in problem and "unreadable" in problem for problem in fp.check(app))


def test_uppercase_framework_suffix_is_fixed(tmp_path: Path) -> None:
    app = make_tree(tmp_path, [])
    folder = app / "Frameworks" / "x.Framework"
    folder.mkdir()
    (folder / "x").write_bytes(b"\xcf\xfa\xed\xfe")
    write_plist(folder / "Info.plist", appl_plist("x"))
    assert fp.fix(app) == ["Frameworks/x.Framework"]


def test_a_failed_replace_leaves_the_plist_and_its_folder_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = make_tree(tmp_path, ["mod_a"])
    folder = app / "Frameworks" / "mod_a.framework"
    plist = folder / "Info.plist"
    plist.chmod(0o600)
    before = plist.read_bytes()
    listing = sorted(p.name for p in folder.iterdir())

    def refuse(*args: object, **kwargs: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "replace", refuse)
    with pytest.raises(OSError):
        fp.fix(app)
    assert plist.read_bytes() == before
    assert sorted(p.name for p in folder.iterdir()) == listing
    assert stat.S_IMODE(plist.stat().st_mode) == 0o600


BAD_ENCODING = b'<?xml version="1.0" encoding="UTFO8"?><plist version="1.0"><dict/></plist>'


def test_an_unknown_encoding_is_a_value_error(tmp_path: Path) -> None:
    path = tmp_path / "Info.plist"
    path.write_bytes(BAD_ENCODING)
    with pytest.raises(ValueError):
        fp.read_plist(path)


def test_an_unknown_encoding_is_a_check_problem_not_a_crash(tmp_path: Path) -> None:
    app = make_tree(tmp_path, [])
    folder = app / "Frameworks" / "x.framework"
    folder.mkdir()
    (folder / "x").write_bytes(b"\xcf\xfa\xed\xfe")
    (folder / "Info.plist").write_bytes(BAD_ENCODING)
    assert any("x.framework" in problem and "unreadable" in problem for problem in fp.check(app))


def test_fix_removes_stale_temporary_siblings_before_writing(tmp_path: Path) -> None:
    app = make_tree(tmp_path, ["mod_a"])
    folder = app / "Frameworks" / "mod_a.framework"
    stale = folder / ".Info.plist.abc123.tmp"
    stale.write_bytes(b"partial")
    keep = folder / "notes.tmp"
    keep.write_bytes(b"x")
    fp.fix(app)
    assert not stale.exists()
    assert keep.exists()


@pytest.mark.parametrize("name", ["a\nb", "a\rb", "a\x1bb", "a\x7fb", f"a{chr(0x2028)}b"])
def test_a_framework_name_with_a_control_character_is_refused(tmp_path: Path, name: str) -> None:
    app = make_tree(tmp_path, [])
    folder = app / "Frameworks" / f"{name}.framework"
    folder.mkdir()
    (folder / name).write_bytes(b"\xcf\xfa\xed\xfe")
    write_plist(folder / "Info.plist", appl_plist(name))
    with pytest.raises(ValueError, match="control character"):
        fp.fix(app)
    with pytest.raises(ValueError, match="control character"):
        fp.generated(app)
    assert any("control character" in problem for problem in fp.check(app))
