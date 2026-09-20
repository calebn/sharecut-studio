"""Host OS file dialog for picking episode.project.json (loopback GUI).

Runs outside the browser: Chromium/Safari never expose filesystem paths.
Callers must keep this loopback-only — the dialog is a privileged local agent.
"""

from __future__ import annotations

import platform
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.project_io import EPISODE_PROJECT_FILENAME, resolve_project_path
from podcast_mcp.util import process

_DIALOG_TIMEOUT_SEC = 600.0


@dataclass(frozen=True)
class HostPickResult:
    """Outcome of an OS open-file dialog."""

    path: str | None = None
    cancelled: bool = False
    unavailable: bool = False
    detail: str | None = None


def pick_episode_project_path(*, system: str | None = None) -> HostPickResult:
    """Show a native open dialog filtered toward episode.project.json.

    Returns a path string when the user confirms, ``cancelled`` on dismiss,
    or ``unavailable`` when no dialog tool exists (e.g. headless Linux).
    Basename and existence are gated by the pick route, not here.
    """
    os_name = (system or platform.system()).strip()
    if os_name == "Darwin":
        return _pick_macos()
    if os_name == "Windows":
        return _pick_windows()
    if os_name == "Linux":
        return _pick_linux()
    return HostPickResult(
        unavailable=True,
        detail=f"No OS file dialog for platform {os_name!r}; paste the path instead.",
    )


def _normalize_chosen(raw: str | None) -> HostPickResult:
    text = (raw or "").strip().strip("\0")
    if not text:
        return HostPickResult(cancelled=True)
    return HostPickResult(path=str(resolve_project_path(text)))


def _run_dialog_process(argv: list[str]) -> HostPickResult | process.CompletedProcess[Any]:
    try:
        return process.run(
            argv,
            capture_output=True,
            text=True,
            timeout=_DIALOG_TIMEOUT_SEC,
            check=False,
        )
    except process.TimeoutExpired:
        return HostPickResult(cancelled=True, detail="File dialog timed out.")
    except FileNotFoundError:
        name = Path(argv[0]).name
        return HostPickResult(
            unavailable=True,
            detail=f"{name} not found; paste the path to episode.project.json.",
        )


def _pick_macos() -> HostPickResult:
    script = f"""
try
  set theFile to choose file with prompt "Open {EPISODE_PROJECT_FILENAME}" ¬
    of type {{"public.json", "json"}}
  return POSIX path of theFile
on error number -128
  return ""
end try
"""
    completed = _run_dialog_process(["osascript", "-e", script])
    if isinstance(completed, HostPickResult):
        return completed
    stdout = (completed.stdout or "").strip()
    if completed.returncode != 0 and not stdout:
        err = (completed.stderr or "").strip()
        return HostPickResult(
            unavailable=True,
            detail=err or "File dialog failed; paste the path instead.",
        )
    return _normalize_chosen(completed.stdout)


def _pick_windows() -> HostPickResult:
    # STA apartment required for WinForms OpenFileDialog.
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = 'Episode project|{EPISODE_PROJECT_FILENAME}|JSON (*.json)|*.json'
$d.Title = 'Open episode project'
$d.FileName = '{EPISODE_PROJECT_FILENAME}'
$d.CheckFileExists = $true
$r = $d.ShowDialog()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) {{
  Write-Output $d.FileName
}}
"""
    exe = shutil.which("powershell") or shutil.which("pwsh")
    if not exe:
        return HostPickResult(
            unavailable=True,
            detail="PowerShell not found; paste the path to episode.project.json.",
        )
    completed = _run_dialog_process([exe, "-NoProfile", "-STA", "-Command", ps])
    if isinstance(completed, HostPickResult):
        return completed
    if completed.returncode != 0 and not (completed.stdout or "").strip():
        return HostPickResult(
            cancelled=True,
            detail=(completed.stderr or "").strip() or None,
        )
    return _normalize_chosen(completed.stdout)


def _pick_linux() -> HostPickResult:
    zenity = shutil.which("zenity")
    if zenity:
        return _run_linux_dialog(
            [
                zenity,
                "--file-selection",
                "--title=Open episode project",
                f"--file-filter={EPISODE_PROJECT_FILENAME} | {EPISODE_PROJECT_FILENAME}",
                "--file-filter=JSON | *.json",
            ]
        )
    kdialog = shutil.which("kdialog")
    if kdialog:
        return _run_linux_dialog(
            [
                kdialog,
                "--getopenfilename",
                ".",
                f"{EPISODE_PROJECT_FILENAME}|*.json",
            ]
        )
    return HostPickResult(
        unavailable=True,
        detail=(
            "No OS file dialog available (install zenity or kdialog); "
            "paste the path to episode.project.json."
        ),
    )


def _run_linux_dialog(argv: list[str]) -> HostPickResult:
    completed = _run_dialog_process(argv)
    if isinstance(completed, HostPickResult):
        return completed
    # zenity/kdialog: exit 1 = cancel
    if completed.returncode != 0:
        return HostPickResult(cancelled=True)
    return _normalize_chosen(completed.stdout)
