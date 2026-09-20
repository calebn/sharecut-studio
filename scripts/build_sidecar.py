#!/usr/bin/env python3
"""Freeze a per-OS Sharecut Studio sidecar (CPython + gui,bootstrap extras + web dist).

Contributor ``tauri dev`` keeps ``gui/desktop/binaries/sharecut-sidecar`` (bash).
This script writes a gitignored runtime tree and a target-triple launcher that
``tauri build`` copies next to the host exe via ``bundle.externalBin``.
"""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARIES = ROOT / "gui" / "desktop" / "binaries"
RUNTIME_NAME = "sharecut-runtime"
LAUNCHER_RS = Path(__file__).resolve().parent / "sidecar_launcher.rs"
SIDECAR_STEM = "sharecut-sidecar"
GUI_EXTRAS = "gui,bootstrap"
PYTHON_VERSION = "3.12"
FREEZE_COMPLETE = ".freeze-complete"
PYTHON_HOME_MARKER = ".python-home"

POSIX_LAUNCHER = """\
#!/bin/sh
# Frozen Sharecut Studio sidecar — set PODCAST_GUI_DIST and exec bundled Python.
set -e
EXEDIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ROOT=""
for cand in \\
  "$EXEDIR/{runtime}" \\
  "$EXEDIR/resources/{runtime}" \\
  "$EXEDIR/../Resources/{runtime}" \\
  "$EXEDIR/../lib/SharecutStudio/{runtime}"
do
  if [ -d "$cand" ]; then
    ROOT="$cand"
    break
  fi
done
if [ -z "$ROOT" ] && [ -d "$EXEDIR/../lib" ]; then
  for cand in "$EXEDIR"/../lib/*/{runtime}; do
    if [ -d "$cand" ]; then
      ROOT="$cand"
      break
    fi
  done
fi
if [ -z "$ROOT" ]; then
  echo "Sharecut Studio sidecar: {runtime} not found next to $0" >&2
  exit 1
fi
export PODCAST_GUI_DIST="$ROOT/web-dist"
export PODCAST_MAGIC_LINK_PRINT=0
export PODCAST_GUI_OPENAPI=0
if [ -z "${{PYTHONHOME:-}}" ]; then
  if [ -f "$ROOT/{marker}" ]; then
    rel="$(tr -d '\\r\\n' < "$ROOT/{marker}")"
    if [ -n "$rel" ] && [ -d "$ROOT/$rel" ]; then
      export PYTHONHOME="$ROOT/$rel"
    fi
  fi
fi
if [ -z "${{PYTHONHOME:-}}" ]; then
  for cand in "$ROOT"/python/cpython-*; do
    [ -d "$cand" ] || continue
    for py in "$cand"/lib/python3*; do
      if [ -d "$py/encodings" ]; then
        export PYTHONHOME="$cand"
        break 2
      fi
    done
    if [ -d "$cand/Lib/encodings" ]; then
      export PYTHONHOME="$cand"
      break
    fi
  done
fi
if [ -n "${{PYTHONHOME:-}}" ] && [ -f "$ROOT/venv/pyvenv.cfg" ]; then
  pyexe="$PYTHONHOME/bin/python"
  [ -x "$pyexe" ] || pyexe="$PYTHONHOME/python"
  tmp="$(mktemp)"
  awk -v home="$PYTHONHOME" -v exe="$pyexe" '
    BEGIN {{ saw_home=0; saw_exe=0; saw_base=0 }}
    /^[[:space:]]*home[[:space:]]*=/ {{ print "home = " home; saw_home=1; next }}
    /^[[:space:]]*executable[[:space:]]*=/ {{ print "executable = " exe; saw_exe=1; next }}
    /^[[:space:]]*base-executable[[:space:]]*=/ {{ print "base-executable = " exe; saw_base=1; next }}
    {{ print }}
    END {{
      if (!saw_home) print "home = " home
      if (!saw_exe) print "executable = " exe
      if (!saw_base) print "base-executable = " exe
    }}
  ' "$ROOT/venv/pyvenv.cfg" > "$tmp" && mv "$tmp" "$ROOT/venv/pyvenv.cfg"
fi
PY="$ROOT/venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "Sharecut Studio sidecar: python not found at $PY" >&2
  exit 1
fi
# Packaged parent sets PODCAST_SIDECAR_EPHEMERAL=1; Python resolved_bind_port uses 0.
exec "$PY" -m podcast_mcp.cli.main gui --host 127.0.0.1 --port 8765 --no-open
"""

WINDOWS_LAUNCHER = """\
@echo off
setlocal
set EXEDIR=%~dp0
set ROOT=
if exist "%EXEDIR%{runtime}\\venv\\Scripts\\python.exe" set ROOT=%EXEDIR%{runtime}
if not defined ROOT if exist "%EXEDIR%resources\\{runtime}\\venv\\Scripts\\python.exe" set ROOT=%EXEDIR%resources\\{runtime}
if not defined ROOT (
  echo Sharecut Studio sidecar: {runtime} not found next to %~f0 1>&2
  exit /b 1
)
set PODCAST_GUI_DIST=%ROOT%\\web-dist
set PODCAST_MAGIC_LINK_PRINT=0
set PODCAST_GUI_OPENAPI=0
if not defined PYTHONHOME if exist "%ROOT%\\{marker}" (
  set /p PYTHONHOME_REL=<"%ROOT%\\{marker}"
  if defined PYTHONHOME_REL if exist "%ROOT%\\%PYTHONHOME_REL%\\Lib\\encodings\\" set "PYTHONHOME=%ROOT%\\%PYTHONHOME_REL%"
)
if not defined PYTHONHOME (
  for /d %%%%D in ("%ROOT%\\python\\cpython-*") do (
    if exist "%%%%D\\Lib\\encodings\\" set "PYTHONHOME=%%%%D"
  )
)
set PY=%ROOT%\\venv\\Scripts\\python.exe
if not exist "%PY%" (
  echo Sharecut Studio sidecar: python not found at %PY% 1>&2
  exit /b 1
)
REM Packaged parent sets PODCAST_SIDECAR_EPHEMERAL=1; Python resolved_bind_port uses 0.
"%PY%" -m podcast_mcp.cli.main gui --host 127.0.0.1 --port 8765 --no-open
"""


def rustc_host_triple() -> str:
    try:
        out = subprocess.check_output(["rustc", "-vV"], text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return fallback_host_triple()
    for line in out.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    return fallback_host_triple()


def fallback_host_triple() -> str:
    plat = sys.platform
    machine = (
        os.uname().machine if hasattr(os, "uname") else os.environ.get("PROCESSOR_ARCHITECTURE", "")
    )
    if plat == "darwin":
        return "aarch64-apple-darwin" if machine == "arm64" else "x86_64-apple-darwin"
    if plat == "win32":
        return "x86_64-pc-windows-msvc"
    return "x86_64-unknown-linux-gnu"


def is_windows_triple(triple: str) -> bool:
    return "windows" in triple


def sidecar_output_name(triple: str) -> str:
    if is_windows_triple(triple):
        return f"{SIDECAR_STEM}-{triple}.exe"
    return f"{SIDECAR_STEM}-{triple}"


def write_script_launcher(path: Path, *, windows: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if windows:
        body = WINDOWS_LAUNCHER.format(runtime=RUNTIME_NAME, marker=PYTHON_HOME_MARKER)
        if path.suffix.lower() != ".cmd":
            path = path.with_suffix(".cmd")
        path.write_text(body.replace("\n", "\r\n"), encoding="utf-8")
        return
    path.write_text(
        POSIX_LAUNCHER.format(runtime=RUNTIME_NAME, marker=PYTHON_HOME_MARKER),
        encoding="utf-8",
    )
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def compile_rust_launcher(dest: Path) -> bool:
    rustc = shutil.which("rustc")
    if rustc is None or not LAUNCHER_RS.is_file():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        rustc,
        "--edition",
        "2021",
        "-C",
        "opt-level=s",
        "-o",
        str(dest),
        str(LAUNCHER_RS),
    ]
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError:
        return False
    return dest.is_file()


def ensure_web_dist(*, rebuild: bool) -> Path:
    dist = ROOT / "gui" / "web" / "dist"
    index = dist / "index.html"
    if index.is_file() and not rebuild:
        return dist
    web = ROOT / "gui" / "web"
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm not found — cannot build gui/web dist")
    if not (web / "node_modules").is_dir():
        subprocess.check_call([npm, "ci"], cwd=web)
    subprocess.check_call([npm, "run", "build"], cwd=web)
    if not index.is_file():
        raise SystemExit(f"gui/web build did not produce {index}")
    return dist


def copy_web_dist(runtime: Path, *, rebuild: bool) -> None:
    src = ensure_web_dist(rebuild=rebuild)
    dest = runtime / "web-dist"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest, dirs_exist_ok=False)


def freeze_complete_path(runtime: Path) -> Path:
    return runtime / FREEZE_COMPLETE


def runtime_is_complete(runtime: Path, *, windows: bool) -> bool:
    py = runtime / "venv" / ("Scripts/python.exe" if windows else "bin/python")
    return freeze_complete_path(runtime).is_file() and py.is_file()


def clear_freeze_complete(runtime: Path) -> None:
    marker = freeze_complete_path(runtime)
    if marker.is_file():
        marker.unlink()


def write_freeze_complete(runtime: Path) -> None:
    freeze_complete_path(runtime).write_text("ok\n", encoding="utf-8")


def _uv() -> str:
    uv = shutil.which("uv")
    if uv is None:
        raise SystemExit("uv not found — install uv to freeze the sidecar")
    return uv


def bundled_cpython_prefix(runtime: Path) -> Path | None:
    """uv standalone prefix under ``python/cpython-*`` (stdlib ``encodings``)."""
    python_root = runtime / "python"
    if not python_root.is_dir():
        return None
    dirs = sorted(
        path for path in python_root.iterdir() if path.is_dir() and path.name.startswith("cpython-")
    )
    # uv also writes ``cpython-3.12-…`` → ``cpython-3.12.13-…``. Prefer the real
    # prefix so pyvenv.cfg does not pin the versionless symlink.
    ordered = [path for path in dirs if not path.is_symlink()] or dirs
    for cand in ordered:
        lib = cand / "lib"
        if lib.is_dir():
            for py in sorted(lib.iterdir()):
                if py.is_dir() and py.name.startswith("python") and (py / "encodings").is_dir():
                    return cand
        if (cand / "Lib" / "encodings").is_dir():
            return cand
    return None


def base_python_exe(prefix: Path) -> Path:
    for cand in (
        prefix / "python.exe",
        prefix / "Scripts" / "python.exe",
        prefix / "bin" / "python",
        prefix / "python",
    ):
        if cand.is_file():
            return cand
    if os.name == "nt":
        return prefix / "python.exe"
    return prefix / "bin" / "python"


def rewrite_pyvenv_cfg(runtime: Path, prefix: Path) -> None:
    """Point venv stubs at the bundled CPython after freeze (and before relocate).

    Windows ``venv\\Scripts\\python.exe`` reads absolute ``home`` / ``executable``
    and fails with ``No Python at 'D:\\a\\...'`` when those still name the GHA host.
    """
    cfg_path = runtime / "venv" / "pyvenv.cfg"
    if not cfg_path.is_file():
        return
    exe = str(base_python_exe(prefix))
    home = str(prefix)
    lines = cfg_path.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    saw = {"home": False, "executable": False, "base-executable": False}
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key == "home":
            out.append(f"home = {home}")
            saw["home"] = True
        elif key == "executable":
            out.append(f"executable = {exe}")
            saw["executable"] = True
        elif key == "base-executable":
            out.append(f"base-executable = {exe}")
            saw["base-executable"] = True
        else:
            out.append(line)
    if not saw["home"]:
        out.append(f"home = {home}")
    if not saw["executable"]:
        out.append(f"executable = {exe}")
    if not saw["base-executable"]:
        out.append(f"base-executable = {exe}")
    cfg_path.write_text("\n".join(out) + "\n", encoding="utf-8")


def write_python_home_marker(runtime: Path, prefix: Path) -> None:
    rel = prefix.resolve().relative_to(runtime.resolve())
    (runtime / PYTHON_HOME_MARKER).write_text(rel.as_posix() + "\n", encoding="utf-8")


FREEZE_SMOKE = "import datetime, encodings, math, uvicorn"


def managed_cpython_executable(uv: str, *, env: dict[str, str]) -> str:
    """Return uv-managed 3.12, not a repo ``.venv`` / PATH interpreter."""
    py = subprocess.check_output(
        [
            uv,
            "python",
            "find",
            "--managed-python",
            "--no-project",
            PYTHON_VERSION,
        ],
        env=env,
        text=True,
    ).strip()
    if not py:
        raise SystemExit("uv python find --managed-python returned empty path")
    return py


def assert_frozen_interpreter(venv_py: Path) -> None:
    """Fail the freeze if the venv cannot import stdlib + uvicorn."""
    subprocess.check_call([str(venv_py), "-c", FREEZE_SMOKE])


def extension_wheels(directory: Path) -> list[Path]:
    """Return the one top-level wheel supplied by a private extension artifact.

    The build workflow downloads this directory only in its unsigned freeze job.
    Do not accept a loose wheel path: requiring a directory makes it possible to
    install a caller wheel without treating its contents as command-line flags.
    Nested wheels are rejected so this contract exactly matches the release
    workflow's integrity check.
    """
    if not directory.is_dir():
        raise SystemExit(f"extension wheel directory does not exist: {directory}")
    wheels = sorted(
        path for path in directory.iterdir() if path.is_file() and path.suffix == ".whl"
    )
    nested_wheels = sorted(path for path in directory.rglob("*.whl") if path.parent != directory)
    if len(wheels) != 1 or nested_wheels:
        raise SystemExit("extension wheel directory must contain exactly one top-level wheel")
    return wheels


def extension_entry_point_count(venv_py: Path) -> int:
    """Read extension metadata without importing extension modules or names."""
    code = (
        "from importlib.metadata import entry_points; "
        "print(len(entry_points(group='podcast_mcp.extensions')))"
    )
    output = subprocess.check_output([str(venv_py), "-c", code], text=True).strip()
    try:
        return int(output)
    except ValueError as exc:
        raise SystemExit("could not verify extension entry-point discovery") from exc


def install_extension_wheels(uv: str, venv_py: Path, directory: Path) -> None:
    """Install the extension wheel and require newly discoverable metadata."""
    before = extension_entry_point_count(venv_py)
    wheels = extension_wheels(directory)
    subprocess.check_call(
        [
            uv,
            "pip",
            "install",
            "--no-deps",
            "--python",
            str(venv_py),
            *(str(wheel) for wheel in wheels),
        ]
    )
    if extension_entry_point_count(venv_py) <= before:
        raise SystemExit("extension wheels did not add a podcast_mcp.extensions entry point")


def freeze_python(runtime: Path, *, extension_wheels_dir: Path | None = None) -> None:
    uv = _uv()
    py_home = runtime / "python"
    py_home.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "UV_PYTHON_INSTALL_DIR": str(py_home)}
    subprocess.check_call([uv, "python", "install", PYTHON_VERSION], env=env)
    py = managed_cpython_executable(uv, env=env)
    venv = runtime / "venv"
    if venv.exists():
        shutil.rmtree(venv)
    subprocess.check_call([py, "-m", "venv", "--copies", str(venv)])
    venv_py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    spec = f"{ROOT}[{GUI_EXTRAS}]"
    subprocess.check_call([uv, "pip", "install", "--python", str(venv_py), spec])
    if extension_wheels_dir is not None:
        install_extension_wheels(uv, venv_py, extension_wheels_dir)
    slim_python_runtime(runtime)
    prefix = bundled_cpython_prefix(runtime)
    if prefix is None:
        raise SystemExit(f"uv CPython prefix not found under {py_home}")
    rewrite_pyvenv_cfg(runtime, prefix)
    write_python_home_marker(runtime, prefix)
    assert_frozen_interpreter(venv_py)


def slim_python_runtime(runtime: Path) -> int:
    """Drop Tcl/Tk and idle — linuxdeploy cannot resolve libtcl from uv CPython.

    On Windows, ``Path.glob`` is case-insensitive, so ``lib/thread*`` would also
    match CPython stdlib ``Lib/threading.py``. Keep Tcl Thread packages as
    ``lib/thread2.*`` (digit after ``thread``) only.
    """
    if not runtime.is_dir():
        return 0
    globs = (
        "python/**/lib/libtcl*",
        "python/**/lib/libtk*",
        "python/**/lib/tcl*",
        "python/**/lib/tk*",
        "python/**/lib/itcl*",
        "python/**/lib/thread[0-9]*",
        "python/**/_tkinter*",
        "python/**/tkinter",
        "python/**/idlelib",
        "python/**/turtledemo",
        "venv/**/_tkinter*",
        "venv/**/tkinter",
        "venv/**/idlelib",
        "venv/**/turtledemo",
    )
    removed = 0
    seen: set[Path] = set()
    for pattern in globs:
        for path in runtime.glob(pattern):
            resolved = path.resolve()
            if resolved in seen or not path.exists():
                continue
            seen.add(resolved)
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            removed += 1
    if removed:
        print(f"slim runtime: removed {removed} Tcl/Tk/idle paths under {runtime}")
    return removed


def write_dev_stub(binaries: Path, triple: str) -> Path:
    """Copy the bash FOSS sidecar to the triple name when no freeze exists."""
    dest = binaries / sidecar_output_name(triple)
    if dest.is_file():
        return dest
    src = binaries / SIDECAR_STEM
    if not src.is_file():
        raise SystemExit(f"missing contributor sidecar {src}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return dest


_MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
}


def is_macho(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            magic = fh.read(4)
    except OSError:
        return False
    return magic in _MACHO_MAGICS


def iter_macho_files(root: Path) -> list[Path]:
    found: list[Path] = []
    if not root.is_dir():
        return found
    for path in root.rglob("*"):
        if path.is_file() and is_macho(path):
            found.append(path)
    found.sort(key=lambda p: len(p.parts), reverse=True)
    return found


def codesign_runtime(runtime: Path, identity: str) -> int:
    """Sign nested Mach-O in the frozen runtime so Apple notarization accepts the .app."""
    files = iter_macho_files(runtime)
    if not files:
        print(f"codesign: no Mach-O files under {runtime}")
        return 0
    for path in files:
        subprocess.check_call(
            [
                "codesign",
                "--force",
                "--options",
                "runtime",
                "--timestamp",
                "--sign",
                identity,
                str(path),
            ]
        )
    print(f"codesign: signed {len(files)} Mach-O files under {runtime}")
    return len(files)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--out",
        type=Path,
        default=BINARIES,
        help="binaries directory (default: gui/desktop/binaries)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Write launcher scripts only (no CPython, no web dist copy)",
    )
    p.add_argument(
        "--dev-stub",
        action="store_true",
        help="Copy bash sidecar to the target-triple name if missing",
    )
    p.add_argument(
        "--rebuild-web",
        action="store_true",
        help="Run npm run build even when gui/web/dist already exists",
    )
    p.add_argument(
        "--triple",
        default=None,
        help="Override rustc host triple",
    )
    p.add_argument(
        "--codesign-only",
        action="store_true",
        help="Sign Mach-O files in an existing runtime (macOS notarization)",
    )
    p.add_argument(
        "--slim-only",
        action="store_true",
        help="Strip Tcl/Tk from an existing runtime (linuxdeploy)",
    )
    p.add_argument(
        "--ensure",
        action="store_true",
        help="Skip freeze when sharecut-runtime/.freeze-complete already exists",
    )
    p.add_argument(
        "--extension-wheels-dir",
        type=Path,
        default=None,
        help="Directory of private extension wheels to install into the frozen runtime",
    )
    p.add_argument(
        "--print-output-name",
        action="store_true",
        help="Print the exact sidecar filename for the selected target triple",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    binaries: Path = args.out
    triple = args.triple or rustc_host_triple()
    if args.print_output_name:
        print(sidecar_output_name(triple))
        return 0
    binaries.mkdir(parents=True, exist_ok=True)
    windows = is_windows_triple(triple)
    launcher = binaries / sidecar_output_name(triple)
    runtime = binaries / RUNTIME_NAME

    if args.dev_stub:
        write_dev_stub(binaries, triple)
        print(f"dev stub: {binaries / sidecar_output_name(triple)}")
        return 0

    identity = os.environ.get("APPLE_SIGNING_IDENTITY", "").strip()
    if args.slim_only:
        slim_python_runtime(runtime)
        return 0
    if args.codesign_only:
        if not identity:
            raise SystemExit("--codesign-only requires APPLE_SIGNING_IDENTITY")
        codesign_runtime(runtime, identity)
        return 0

    if args.dry_run:
        if windows:
            write_script_launcher(launcher.with_suffix(".cmd"), windows=True)
            print(f"dry-run launcher: {launcher.with_suffix('.cmd')}")
        else:
            write_script_launcher(launcher, windows=False)
            print(f"dry-run launcher: {launcher}")
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / "web-dist").mkdir(exist_ok=True)
        return 0

    launcher_ok = launcher.is_file()
    if args.ensure and runtime_is_complete(runtime, windows=windows) and launcher_ok:
        print(f"reusing complete freeze: {runtime}")
        return 0

    runtime.mkdir(parents=True, exist_ok=True)
    clear_freeze_complete(runtime)
    copy_web_dist(runtime, rebuild=args.rebuild_web)
    freeze_python(runtime, extension_wheels_dir=args.extension_wheels_dir)
    compiled = compile_rust_launcher(launcher)
    if not compiled:
        if windows:
            raise SystemExit(
                "rustc is required to compile sharecut-sidecar on Windows "
                "(Tauri externalBin expects .exe, not a .cmd fallback)"
            )
        write_script_launcher(launcher, windows=False)
        print(f"script launcher (no rustc): {launcher}")
    else:
        print(f"compiled launcher: {launcher}")
    print(f"runtime: {runtime}")
    if sys.platform == "darwin" and identity:
        codesign_runtime(runtime, identity)
    write_freeze_complete(runtime)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
