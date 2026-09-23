"""Dry-run freeze of the desktop sidecar launcher."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_sidecar.py"


def _load_build_sidecar():
    return load_script("build_sidecar")


def test_dry_run_emits_posix_launcher(tmp_path: Path) -> None:
    subprocess.check_call(
        [
            sys.executable,
            str(SCRIPT),
            "--dry-run",
            "--out",
            str(tmp_path),
            "--triple",
            "aarch64-apple-darwin",
        ]
    )
    launcher = tmp_path / "sharecut-sidecar-aarch64-apple-darwin"
    text = launcher.read_text(encoding="utf-8")
    assert "PODCAST_GUI_DIST" in text
    assert "python" in text
    assert "-m podcast_mcp.cli.main" in text
    assert "gui --host 127.0.0.1 --port" in text
    assert "PODCAST_SIDECAR_EPHEMERAL" in text
    assert "PODCAST_GUI_OPENAPI=0" in text
    assert '"$@"' not in text
    assert "../lib/SharecutStudio" in text
    assert "PYTHONHOME" in text
    assert "${PYTHONHOME:-}" in text
    assert ".python-home" in text
    assert "pyvenv.cfg" in text
    assert "PODCAST_MAGIC_LINK_PRINT" in text
    assert (tmp_path / "sharecut-runtime" / "web-dist").is_dir()


def test_dry_run_emits_windows_cmd(tmp_path: Path) -> None:
    subprocess.check_call(
        [
            sys.executable,
            str(SCRIPT),
            "--dry-run",
            "--out",
            str(tmp_path),
            "--triple",
            "x86_64-pc-windows-msvc",
        ]
    )
    launcher = tmp_path / "sharecut-sidecar-x86_64-pc-windows-msvc.cmd"
    text = launcher.read_text(encoding="utf-8")
    assert "PODCAST_GUI_DIST" in text
    assert "podcast_mcp.cli.main" in text
    assert "8765" in text
    assert "PODCAST_SIDECAR_EPHEMERAL" in text
    assert "PODCAST_GUI_OPENAPI=0" in text
    assert "PYTHONHOME" in text
    assert "cpython-*" in text
    assert "PODCAST_MAGIC_LINK_PRINT" in text
    assert "%*" not in text


def test_sidecar_output_names() -> None:
    mod = _load_build_sidecar()
    assert (
        mod.sidecar_output_name("aarch64-apple-darwin") == "sharecut-sidecar-aarch64-apple-darwin"
    )
    assert (
        mod.sidecar_output_name("x86_64-pc-windows-msvc")
        == "sharecut-sidecar-x86_64-pc-windows-msvc.exe"
    )


@pytest.mark.parametrize(
    ("triple", "expected"),
    [
        ("aarch64-apple-darwin", "sharecut-sidecar-aarch64-apple-darwin"),
        ("x86_64-pc-windows-msvc", "sharecut-sidecar-x86_64-pc-windows-msvc.exe"),
    ],
)
def test_print_output_name(triple: str, expected: str) -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--triple", triple, "--print-output-name"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout.strip() == expected


def test_is_macho_magic(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    script = tmp_path / "notes.txt"
    script.write_text("not macho\n", encoding="utf-8")
    assert mod.is_macho(script) is False
    macho = tmp_path / "fake.dylib"
    macho.write_bytes(b"\xcf\xfa\xed\xfe" + b"\x00" * 16)
    assert mod.is_macho(macho) is True
    assert mod.iter_macho_files(tmp_path) == [macho]


def test_dev_stub_copies_bash_sidecar(tmp_path: Path) -> None:
    src = tmp_path / "sharecut-sidecar"
    src.write_text("#!/bin/sh\necho stub\n", encoding="utf-8")
    subprocess.check_call(
        [
            sys.executable,
            str(SCRIPT),
            "--dev-stub",
            "--out",
            str(tmp_path),
            "--triple",
            "aarch64-apple-darwin",
        ]
    )
    dest = tmp_path / "sharecut-sidecar-aarch64-apple-darwin"
    assert dest.is_file()
    assert dest.read_text(encoding="utf-8") == src.read_text(encoding="utf-8")


def test_slim_python_runtime_drops_tk(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    tk_so = runtime / "python" / "cpython" / "lib" / "libtcl9tk9.0.so"
    tk_so.parent.mkdir(parents=True)
    tk_so.write_bytes(b"fake")
    dyn = runtime / "python" / "lib-dynload" / "_tkinter.cpython-312.so"
    dyn.parent.mkdir(parents=True)
    dyn.write_bytes(b"fake")
    pkg = runtime / "venv" / "lib" / "python3.12" / "tkinter" / "__init__.py"
    pkg.parent.mkdir(parents=True)
    pkg.write_text("pass\n", encoding="utf-8")
    keep = runtime / "venv" / "lib" / "python3.12" / "fastapi" / "__init__.py"
    keep.parent.mkdir(parents=True)
    keep.write_text("ok\n", encoding="utf-8")
    assert mod.slim_python_runtime(runtime) >= 1
    assert not tk_so.exists()
    assert not dyn.exists()
    assert not pkg.parent.exists()
    assert keep.is_file()


def test_slim_python_runtime_keeps_stdlib_threading(tmp_path: Path) -> None:
    """Do not delete stdlib threading.py when slimming Tcl thread2.* dirs.

    Windows Path.glob is case-insensitive, so ``lib/thread*`` also matches
    ``Lib/threading.py``. Place the survivor at ``lib/threading.py`` so
    case-sensitive CI exercises the same collision.
    """
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    py_lib = runtime / "python" / "cpython-3.12-windows-x86_64-none" / "lib"
    threading_py = py_lib / "threading.py"
    threading_py.parent.mkdir(parents=True)
    threading_py.write_text("# stdlib\n", encoding="utf-8")
    tcl_thread = py_lib / "thread2.8.8"
    tcl_thread.mkdir(parents=True)
    (tcl_thread / "pkgIndex.tcl").write_text("# tcl\n", encoding="utf-8")
    assert mod.slim_python_runtime(runtime) >= 1
    assert threading_py.is_file()
    assert not tcl_thread.exists()


def test_freeze_extras_include_bootstrap() -> None:
    mod = _load_build_sidecar()
    assert "bootstrap" in mod.GUI_EXTRAS
    assert "gui" in mod.GUI_EXTRAS


def _fail(*_args, **_kwargs):
    raise AssertionError("must not be reached")


def test_packaged_build_requires_rustc_before_freeze(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    mod = _load_build_sidecar()
    monkeypatch.setattr(mod.shutil, "which", lambda _name: None)
    monkeypatch.setattr(mod, "copy_web_dist", _fail)
    monkeypatch.setattr(mod, "freeze_python", _fail)

    with pytest.raises(SystemExit, match="rustc is required"):
        mod.main(["--out", str(tmp_path), "--triple", "aarch64-apple-darwin"])

    assert not (tmp_path / "sharecut-runtime" / ".freeze-complete").exists()


def test_launcher_compile_error_is_not_reported_as_missing_rustc(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    mod = _load_build_sidecar()
    monkeypatch.setattr(mod.shutil, "which", lambda _name: "/usr/bin/rustc")

    def boom(cmd: list[str]) -> None:
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(mod.subprocess, "check_call", boom)
    with pytest.raises(SystemExit, match=r"rustc failed to compile sidecar_launcher\.rs") as exc:
        mod.compile_rust_launcher(tmp_path / "sharecut-sidecar")
    assert "required" not in str(exc.value)


def test_ensure_recompiles_stale_script_launcher(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    py = runtime / "venv" / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text("#!/bin/sh\n", encoding="utf-8")
    mod.write_freeze_complete(runtime)
    launcher = tmp_path / "sharecut-sidecar-aarch64-apple-darwin"
    launcher.write_text("#!/bin/sh\nexec python -m podcast_mcp.cli.main gui\n", encoding="utf-8")
    compiled: list[Path] = []
    monkeypatch.setattr(mod.shutil, "which", lambda _name: "/usr/bin/rustc")
    monkeypatch.setattr(mod, "compile_rust_launcher", compiled.append)
    monkeypatch.setattr(mod, "copy_web_dist", _fail)
    monkeypatch.setattr(mod, "freeze_python", _fail)

    assert mod.main(["--ensure", "--out", str(tmp_path), "--triple", "aarch64-apple-darwin"]) == 0
    assert compiled == [launcher]


def test_extension_wheels_requires_exactly_one_top_level_wheel(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    with pytest.raises(SystemExit, match="exactly one top-level wheel"):
        mod.extension_wheels(tmp_path)
    wheel = tmp_path / "private_extension-1.0.0-py3-none-any.whl"
    wheel.write_bytes(b"wheel")
    assert mod.extension_wheels(tmp_path) == [wheel]
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "second.whl").write_bytes(b"wheel")
    with pytest.raises(SystemExit, match="exactly one top-level wheel"):
        mod.extension_wheels(tmp_path)


def test_install_extension_wheels_installs_one_and_requires_new_entry_point(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    mod = _load_build_sidecar()
    first = tmp_path / "first.whl"
    first.write_bytes(b"")
    calls: list[list[str]] = []
    counts = iter((1, 2))
    monkeypatch.setattr(mod, "extension_entry_point_count", lambda _py: next(counts))
    monkeypatch.setattr(mod.subprocess, "check_call", lambda args: calls.append(args))

    mod.install_extension_wheels("uv", tmp_path / "python", tmp_path)

    assert calls == [
        [
            "uv",
            "pip",
            "install",
            "--no-deps",
            "--python",
            str(tmp_path / "python"),
            str(first),
        ]
    ]


def test_install_extension_wheels_rejects_missing_entry_point(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    mod = _load_build_sidecar()
    (tmp_path / "private_extension.whl").write_bytes(b"")
    counts = iter((1, 1))
    monkeypatch.setattr(mod, "extension_entry_point_count", lambda _py: next(counts))
    monkeypatch.setattr(mod.subprocess, "check_call", lambda _args: None)

    with pytest.raises(SystemExit, match=r"did not add a podcast_mcp\.extensions entry point"):
        mod.install_extension_wheels("uv", tmp_path / "python", tmp_path)


def test_runtime_is_complete_requires_marker(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    py = runtime / "venv" / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text("#!/bin/sh\n", encoding="utf-8")
    assert mod.runtime_is_complete(runtime, windows=False) is False
    mod.write_freeze_complete(runtime)
    assert mod.runtime_is_complete(runtime, windows=False) is True
    mod.clear_freeze_complete(runtime)
    assert mod.runtime_is_complete(runtime, windows=False) is False


def test_rust_launcher_searches_appimage_lib() -> None:
    text = (ROOT / "scripts" / "sidecar_launcher.rs").read_text(encoding="utf-8")
    shared = (ROOT / "scripts" / "sidecar_shared.rs").read_text(encoding="utf-8")
    assert "SharecutStudio" in text
    assert "lib" in text
    assert "args_os" in text
    assert '"-P"' in text
    assert "KILL_ON_JOB_CLOSE" in text
    assert "LOCALAPPDATA" in shared
    assert "0x0800_0000" in shared
    assert "current_dir" in text
    assert "PYTHONHOME" in text
    assert "cpython-" in text
    assert "mut child" in text
    assert "pyvenv.cfg" in text
    assert ".python-home" in text
    assert "PODCAST_MAGIC_LINK_PRINT" in text
    assert "PODCAST_GUI_OPENAPI" in text
    assert "PODCAST_SIDECAR_EPHEMERAL" in text
    assert "sidecar_shared" in text
    assert "detach_to_sidecar_log" in text
    assert "Stdio::null" in shared


def test_rewrite_pyvenv_cfg_windows_paths(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    prefix = runtime / "python" / "cpython-3.12-windows-x86_64-none"
    (prefix / "Lib" / "encodings").mkdir(parents=True)
    (prefix / "python.exe").write_bytes(b"")
    venv = runtime / "venv"
    venv.mkdir(parents=True)
    cfg = venv / "pyvenv.cfg"
    cfg.write_text(
        "home = D:\\a\\sharecut-studio\\sharecut-studio\\gui\\desktop\\binaries\\"
        "sharecut-runtime\\python\\cpython-3.12-windows-x86_64-none\n"
        "include-system-site-packages = false\n"
        "version = 3.12.0\n"
        "executable = D:\\a\\sharecut-studio\\sharecut-studio\\gui\\desktop\\binaries\\"
        "sharecut-runtime\\python\\cpython-3.12-windows-x86_64-none\\python.exe\n"
        "command = unused\n",
        encoding="utf-8",
    )
    mod.rewrite_pyvenv_cfg(runtime, prefix)
    text = cfg.read_text(encoding="utf-8")
    assert "D:\\a\\" not in text
    assert f"home = {prefix}" in text
    assert f"executable = {prefix / 'python.exe'}" in text
    assert "base-executable =" in text
    assert "include-system-site-packages = false" in text
    assert "command = unused" in text


def test_assert_frozen_interpreter_runs_smoke(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    py = tmp_path / "python"
    py.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    py.chmod(0o755)
    mod.assert_frozen_interpreter(py)


def test_managed_cpython_executable_passes_flags(monkeypatch) -> None:
    mod = _load_build_sidecar()
    seen: list[list[str]] = []

    def fake_output(argv, **kwargs):
        seen.append(list(argv))
        return "/tmp/managed/bin/python\n"

    monkeypatch.setattr(mod.subprocess, "check_output", fake_output)
    path = mod.managed_cpython_executable("uv", env={"UV_PYTHON_INSTALL_DIR": "/tmp"})
    assert path == "/tmp/managed/bin/python"
    assert seen[0][:5] == ["uv", "python", "find", "--managed-python", "--no-project"]
    assert seen[0][-1] == "3.12"
    mod = _load_build_sidecar()
    text = SCRIPT.read_text(encoding="utf-8")
    assert '"--managed-python"' in text
    assert '"--no-project"' in text
    assert "math" in mod.FREEZE_SMOKE
    assert "uvicorn" in mod.FREEZE_SMOKE


def test_bundled_cpython_prefix_skips_versionless_symlink(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    real = runtime / "python" / "cpython-3.12.13-macos-aarch64-none"
    (real / "lib" / "python3.12" / "encodings").mkdir(parents=True)
    alias = runtime / "python" / "cpython-3.12-macos-aarch64-none"
    alias.symlink_to(real)
    assert mod.bundled_cpython_prefix(runtime) == real


def test_write_python_home_marker(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    prefix = runtime / "python" / "cpython-3.12-windows-x86_64-none"
    prefix.mkdir(parents=True)
    mod.write_python_home_marker(runtime, prefix)
    marker = (runtime / mod.PYTHON_HOME_MARKER).read_text(encoding="utf-8").strip()
    assert marker == "python/cpython-3.12-windows-x86_64-none"


def test_release_workflow_has_rustc_for_compiled_launcher() -> None:
    workflow = ROOT / ".github/workflows/release-desktop-build.yml"
    yml = workflow.read_text(encoding="utf-8")
    assert "rustc --version" in yml
    assert "CARGO_HOME" in yml


def test_bundled_cpython_prefix_unix(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    encodings = (
        runtime
        / "python"
        / "cpython-3.12.14-linux-aarch64-gnu"
        / "lib"
        / "python3.12"
        / "encodings"
    )
    encodings.mkdir(parents=True)
    (encodings / "__init__.py").write_text("", encoding="utf-8")
    prefix = mod.bundled_cpython_prefix(runtime)
    assert prefix is not None
    assert prefix.name == "cpython-3.12.14-linux-aarch64-gnu"


def test_bundled_cpython_prefix_windows_lib(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    encodings = runtime / "python" / "cpython-3.12.14-windows-x86_64-none" / "Lib" / "encodings"
    encodings.mkdir(parents=True)
    (encodings / "__init__.py").write_text("", encoding="utf-8")
    prefix = mod.bundled_cpython_prefix(runtime)
    assert prefix is not None
    assert prefix.name.startswith("cpython-")


def test_bundled_cpython_prefix_missing(tmp_path: Path) -> None:
    mod = _load_build_sidecar()
    runtime = tmp_path / "sharecut-runtime"
    (runtime / "python").mkdir(parents=True)
    assert mod.bundled_cpython_prefix(runtime) is None
