"""User-triggered sanitized diagnostics zip for support requests.

Nothing here is uploaded. The caller attaches the zip to a support request.
"""

from __future__ import annotations

import json
import os
import platform
import re
import secrets
import shutil
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import podcast_mcp
from podcast_mcp.config import cache_dir, repo_root, whisper_cache_dir
from podcast_mcp.distribution import runtime_distribution_metadata
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.bootstrap import component_status
from podcast_mcp.services.doctor import ffmpeg_probe_info, python_runtime_info, run_doctor_checks
from podcast_mcp.util.model_assets import rnnoise_model_path
from podcast_mcp.util.progress import resolve_progress_task
from podcast_mcp.util.redact import sanitize
from podcast_mcp.whisper_models import resolve_whisper_model, whisper_model_is_cached

MAX_BUNDLE_BYTES = 5 * 1024 * 1024
LOG_TAIL_LINES = 500
LOG_TAIL_MAX_BYTES = 256 * 1024
MAX_LOG_FILES = 32
BUNDLE_NAME_PREFIX = "sharecut-diagnostics-"
BUNDLE_NAME_RE = re.compile(r"^sharecut-diagnostics-\d{8}T\d{6}Z-[0-9a-f]{6}\.zip$")
FORBIDDEN_LOG_NAMES = frozenset(
    {
        "shares.json",
        "sync.db",
        "relay.yaml",
        "episode.project.json",
    }
)
_AUDIO_SUFFIXES = frozenset({".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".aiff"})
ENV_ALLOWLIST = (
    "PODCAST_WHISPER_MODEL",
    "PODCAST_MCP_CACHE",
    "PODCAST_MCP_FFMPEG",
    "PODCAST_MCP_FFPROBE",
    "PODCAST_MCP_PIPELINE_DEFAULTS",
    "PODCAST_GUI_DIST",
    "PODCAST_GUI_OPENAPI",
    "PODCAST_GUI_MAX_BODY_BYTES",
    "PODCAST_SESSION_AUTHZ",
    "PODCAST_SESSION_TOKEN",
    "PODCAST_SIDECAR_BOOT_TOKEN",
    "PODCAST_SIDECAR_EPHEMERAL",
    "PODCAST_SIDECAR_LISTEN_FILE",
    "PODCAST_REMOTE_MCP",
    "PODCAST_RATE_LIMIT",
    "PODCAST_RELAY_RATE_LIMIT",
    "PODCAST_EXTENSIONS",
    "PODCAST_BATCH",
    "PODCAST_REVIEW_CORS_ORIGINS",
    "PODCAST_PUBLIC_ORIGIN",
    "PODCAST_SHARE_ACCOUNTS",
    "PODCAST_MAGIC_LINK_PRINT",
    "PODCAST_PROGRESS_COMPLIANCE",
    "PODCAST_SHARE_REGISTRY",
)
_BOOL_VALUES = frozenset({"0", "1", "true", "false", "yes", "no", "on", "off"})
_README = """Sharecut Studio diagnostics bundle
=================================

This zip was created on your machine. Nothing was uploaded.

Contents
--------
- report.json — versions, doctor checks, project counts (no transcript text)
- README.txt — this file
- sidecar.log and other *.log tails from the app state directory (sanitized)

Not included
------------
Audio, transcripts, episode.project.json, shares.json, sync.db, relay.yaml,
or share tokens.

How to attach
-------------
1. Attach this zip to a support request (Help → Open support, or
   `podcast doctor --bundle` prints the configured support URL).
2. Do not attach episode audio or project JSON.
"""


@dataclass(frozen=True)
class BundleReport:
    path: Path
    filename: str
    support_url: str
    size_bytes: int


def default_bundle_dir() -> Path:
    return Path.home() / "Downloads"


def bundle_filename(*, when: datetime | None = None, nonce: str | None = None) -> str:
    stamp = (when or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    suffix = nonce if nonce is not None else secrets.token_hex(3)
    return f"{BUNDLE_NAME_PREFIX}{stamp}-{suffix}.zip"


def is_allowed_bundle_name(name: str) -> bool:
    if not name or "/" in name or "\\" in name or ".." in name:
        return False
    return BUNDLE_NAME_RE.fullmatch(name) is not None


def resolve_bundle_file(name: str, *, extra_dirs: list[Path] | None = None) -> Path | None:
    """Return a zip under ``extra_dirs`` if the filename is allowlisted."""
    if not is_allowed_bundle_name(name):
        return None
    for directory in extra_dirs or []:
        path = directory / name
        try:
            resolved = path.resolve()
            parent = directory.expanduser().resolve()
        except OSError:
            continue
        if resolved.is_file() and resolved.parent == parent:
            return resolved
    return None


def sidecar_log_candidates() -> list[Path]:
    """Log locations from the frozen sidecar launcher (macOS / Windows / Linux)."""
    paths: list[Path] = []
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        paths.append(Path(local) / "SharecutStudio" / "sidecar.log")
    xdg = os.environ.get("XDG_STATE_HOME", "").strip()
    if xdg:
        paths.append(Path(xdg) / "SharecutStudio" / "sidecar.log")
    home = Path.home()
    paths.append(home / "Library" / "Logs" / "Sharecut Studio" / "sidecar.log")
    paths.append(home / ".local" / "state" / "SharecutStudio" / "sidecar.log")
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in paths:
        try:
            key = path.resolve()
        except OSError:
            key = path
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def state_log_dirs() -> list[Path]:
    return list(dict.fromkeys(path.parent for path in sidecar_log_candidates()))


def _regular_log_file(path: Path, *, directory: Path | None = None) -> Path | None:
    """Return a resolved regular file, or None if it is a symlink / escape."""
    try:
        info = path.lstat()
    except OSError:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        return None
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    if Path(resolved).name in FORBIDDEN_LOG_NAMES:
        return None
    if directory is None:
        return resolved
    try:
        parent = directory.resolve()
    except (OSError, AttributeError):
        return resolved
    try:
        resolved.relative_to(parent)
    except ValueError:
        return None
    except OSError:
        return resolved
    return resolved


def _env_value(raw: str) -> str:
    stripped = raw.strip()
    if stripped.lower() in _BOOL_VALUES:
        return stripped.lower()
    if stripped.isdigit() and 1 <= int(stripped) <= 65535:
        return stripped
    return "<redacted>"


def collect_env_flags() -> dict[str, str]:
    out: dict[str, str] = {}
    for name in ENV_ALLOWLIST:
        if name in os.environ:
            out[name] = _env_value(os.environ[name])
    return out


def _torch_gpu_flags() -> dict[str, bool]:
    try:
        import torch
    except ImportError:
        return {"torch": False, "cuda": False, "mps": False}
    cuda = bool(getattr(torch, "cuda", None) and torch.cuda.is_available())
    mps = False
    backends = getattr(torch, "backends", None)
    mps_mod = getattr(backends, "mps", None) if backends is not None else None
    if mps_mod is not None:
        mps = bool(mps_mod.is_available())
    return {"torch": True, "cuda": cuda, "mps": mps}


def _project_counts(project: EpisodeProject | None) -> dict[str, Any] | None:
    if project is None:
        return None
    return {
        "schema_version": project.version,
        "tracks": len(project.tracks),
        "clips": len(project.clips),
        "decisions": len(project.edit_decisions),
        "comments": len(project.comments),
    }


def _disk_free_bytes(path: Path) -> int | None:
    try:
        return int(shutil.disk_usage(path).free)
    except OSError:
        return None


def _redact_kwargs(*, home: Path, workspace: Path | None) -> dict[str, Any]:
    extra: list[tuple[Path, str]] = []
    for path, token in (
        (cache_dir(), "<cache>"),
        (whisper_cache_dir(), "<whisper-cache>"),
        (rnnoise_model_path(), "<rnnoise-model>"),
    ):
        try:
            extra.append((path, token))
        except OSError:
            continue
    raw = os.environ.get("PODCAST_MCP_CACHE", "").strip()
    if raw:
        extra.append((Path(raw).expanduser(), "<cache>"))
    return {"home": home, "workspace": workspace, "extra": extra}


def _gui_dist_present() -> bool:
    raw = os.environ.get("PODCAST_GUI_DIST", "").strip()
    root = Path(raw).expanduser() if raw else repo_root() / "gui" / "web" / "dist"
    return (root / "index.html").is_file()


def _sanitize_job_snapshots(
    snapshots: list[dict[str, Any]] | None,
    *,
    home: Path,
    workspace: Path | None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for snap in (snapshots or [])[:limit]:
        steps = snap.get("steps") or []
        phase = None
        if steps:
            last = steps[-1] if isinstance(steps[-1], dict) else {}
            phase = last.get("name")
        message = snap.get("message")
        rows.append(
            {
                "kind": snap.get("kind"),
                "status": snap.get("status"),
                "phase": phase,
                "elapsed_sec": snap.get("elapsed_sec"),
                "message": sanitize(str(message), **_redact_kwargs(home=home, workspace=workspace))
                if message
                else None,
            }
        )
    return rows


def _read_log_tail(
    path: Path, *, lines: int = LOG_TAIL_LINES, max_bytes: int = LOG_TAIL_MAX_BYTES
) -> str:
    size = 0
    to_read = 0
    data = b""
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            if size <= 0:
                return ""
            to_read = min(size, max_bytes)
            handle.seek(size - to_read)
            data = handle.read(to_read)
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace")
    if to_read < size:
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1 :]
    parts = text.splitlines()
    return "\n".join(parts[-lines:])


def _collect_logs(*, include_logs: bool, home: Path, workspace: Path | None) -> dict[str, str]:
    if not include_logs:
        return {}
    collected: dict[str, str] = {}
    used_names: set[str] = set()
    sidecar_seen: set[Path] = set()
    for path in sidecar_log_candidates():
        key = _regular_log_file(path, directory=path.parent)
        if key is None or key in sidecar_seen:
            continue
        sidecar_seen.add(key)
        name = (
            "sidecar.log" if "sidecar.log" not in used_names else f"sidecar-{len(used_names)}.log"
        )
        used_names.add(name)
        collected[name] = sanitize(
            _read_log_tail(path),
            **_redact_kwargs(home=home, workspace=workspace),
        )
    for directory in state_log_dirs():
        if not directory.is_dir():
            continue
        if len(collected) >= MAX_LOG_FILES:
            break
        try:
            children = list(directory.glob("*.log"))
        except OSError:
            continue
        ranked: list[tuple[float, Path, Path]] = []
        for path in children:
            if path.suffix.lower() in _AUDIO_SUFFIXES:
                continue
            resolved = _regular_log_file(path, directory=directory)
            if resolved is None:
                continue
            try:
                mtime = path.lstat().st_mtime
            except OSError:
                mtime = 0.0
            ranked.append((mtime, path, resolved))
        ranked.sort(key=lambda row: row[0], reverse=True)
        for _mtime, path, resolved in ranked:
            if len(collected) >= MAX_LOG_FILES:
                break
            if resolved in sidecar_seen:
                continue
            sidecar_seen.add(resolved)
            name = path.name
            if name in used_names:
                name = f"{directory.name}-{path.name}"
            used_names.add(name)
            collected[name] = sanitize(
                _read_log_tail(path),
                **_redact_kwargs(home=home, workspace=workspace),
            )
    return collected


def _truncate_logs(logs: dict[str, str], *, budget: int) -> dict[str, str]:
    """Keep logs under ``budget`` bytes, dropping oldest lines first."""
    encoded = {name: body.encode("utf-8") for name, body in logs.items()}
    total = sum(len(b) for b in encoded.values())
    if total <= budget:
        return logs
    # Drop from the largest log until we fit.
    names = sorted(encoded, key=lambda n: len(encoded[n]), reverse=True)
    for name in names:
        overflow = total - budget
        if overflow <= 0:
            break
        blob = encoded[name]
        keep = max(0, len(blob) - overflow)
        encoded[name] = blob[-keep:] if keep else b""
        total = sum(len(b) for b in encoded.values())
    return {name: blob.decode("utf-8", errors="replace") for name, blob in encoded.items()}


def _build_report_json(
    project: EpisodeProject | None,
    *,
    home: Path,
    workspace: Path | None,
    job_snapshots: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    doctor = run_doctor_checks(project)
    model = resolve_whisper_model()
    disk_target = workspace if workspace is not None else Path.home()
    return {
        "app_version": podcast_mcp.__version__,
        "python": python_runtime_info(),
        "os": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "ffmpeg": ffmpeg_probe_info(),
        "whisper": {
            "model": model,
            "cached": whisper_model_is_cached(model),
        },
        "gpu": _torch_gpu_flags(),
        "gui_dist_present": _gui_dist_present(),
        "doctor": doctor.to_json(),
        "bootstrap": component_status(),
        "disk_free_bytes": _disk_free_bytes(disk_target),
        "project": _project_counts(project),
        "jobs": _sanitize_job_snapshots(
            job_snapshots,
            home=home,
            workspace=workspace,
        ),
        "env": collect_env_flags(),
        "created_at": datetime.now(UTC).isoformat(),
    }


class DiagnosticsService:
    """Build a sanitized diagnostics zip (CLI + host GUI)."""

    def build_bundle(
        self,
        project: EpisodeProject | None,
        *,
        out_dir: Path,
        include_logs: bool = True,
        job_snapshots: list[dict[str, Any]] | None = None,
    ) -> BundleReport:
        home = Path.home()
        workspace: Path | None = None
        if project is not None and project.workspace_dir:
            workspace = Path(project.workspace_dir)
        out_dir = out_dir.expanduser()
        out_dir.mkdir(parents=True, exist_ok=True)

        with resolve_progress_task(
            "diagnostics",
            "Diagnostics bundle",
            total=3,
            prefer_parent=True,
        ) as task:
            task.set_phase("collecting", "Collecting environment…")
            payload = _build_report_json(
                project,
                home=home,
                workspace=workspace,
                job_snapshots=job_snapshots,
            )
            report_text = sanitize(
                json.dumps(payload, indent=2, default=str),
                **_redact_kwargs(home=home, workspace=workspace),
            )
            task.advance(1, message="Collected")

            task.set_phase("redacting", "Redacting logs…")
            logs = _collect_logs(include_logs=include_logs, home=home, workspace=workspace)
            README = sanitize(_README, **_redact_kwargs(home=home, workspace=workspace))
            fixed = len(report_text.encode("utf-8")) + len(README.encode("utf-8"))
            log_budget = max(0, MAX_BUNDLE_BYTES - fixed - 64_000)
            logs = _truncate_logs(logs, budget=log_budget)
            task.advance(1, message="Redacted")

            task.set_phase("zipping", "Writing zip…")
            filename = bundle_filename()
            zip_path = out_dir / filename
            tmp_fd, tmp_name = tempfile.mkstemp(
                prefix=BUNDLE_NAME_PREFIX, suffix=".zip", dir=out_dir
            )
            os.close(tmp_fd)
            tmp_path = Path(tmp_name)
            try:
                with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                    zf.writestr("report.json", report_text)
                    zf.writestr("README.txt", README)
                    for name, body in logs.items():
                        if "/" in name or "\\" in name or name.startswith(".."):
                            continue
                        zf.writestr(name, body)
                size = tmp_path.stat().st_size
                if size > MAX_BUNDLE_BYTES:
                    raise RuntimeError("diagnostics bundle exceeded 5 MB after truncation")
                tmp_path.replace(zip_path)
            except Exception:
                tmp_path.unlink(missing_ok=True)
                raise
            task.advance(1, message="Zipped")

        return BundleReport(
            path=zip_path,
            filename=filename,
            support_url=runtime_distribution_metadata().support_url,
            size_bytes=size,
        )
