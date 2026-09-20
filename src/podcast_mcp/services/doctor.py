"""Structured `podcast doctor` checks shared by CLI and diagnostics."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.config import cache_dir
from podcast_mcp.engines import FFmpegEngine
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.binaries import ffmpeg_source, resolve_ffmpeg
from podcast_mcp.util.model_assets import rnnoise_model_path
from podcast_mcp.whisper_models import (
    resolve_whisper_model,
    validate_whisper_model,
    whisper_model_is_cached,
)

DoctorStatus = Literal["ok", "fail", "warn"]


@dataclass(frozen=True)
class DoctorCheck:
    status: DoctorStatus
    message: str
    err: bool = False
    extra: str | None = None


@dataclass
class DoctorReport:
    checks: list[DoctorCheck] = field(default_factory=list)

    @property
    def error_count(self) -> int:
        return sum(1 for c in self.checks if c.status == "fail")

    @property
    def passed(self) -> bool:
        return self.error_count == 0

    def to_json(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "error_count": self.error_count,
            "checks": [
                {"status": c.status, "message": c.message, "extra": c.extra} for c in self.checks
            ],
        }


def run_doctor_checks(
    project: EpisodeProject | Path | None = None,
) -> DoctorReport:
    """Run the same health checks as `podcast doctor` (no I/O besides reads)."""
    report = DoctorReport()
    ok, msg = FFmpegEngine().check_available()
    if ok:
        source = ffmpeg_source(resolve_ffmpeg())
        report.checks.append(DoctorCheck("ok", f"ffmpeg ({source}): {msg}"))
    else:
        report.checks.append(
            DoctorCheck(
                "fail",
                f"ffmpeg: {msg}",
                err=True,
                extra=(
                    "  Fix: install system-wide (macOS: `brew install ffmpeg`; "
                    "Debian/Ubuntu: `sudo apt install ffmpeg`) or run "
                    "`podcast bootstrap --component ffmpeg`"
                ),
            )
        )

    c = cache_dir()
    if os.access(c, os.W_OK):
        report.checks.append(DoctorCheck("ok", f"cache writable: {c}"))
    else:
        report.checks.append(DoctorCheck("fail", f"cache not writable: {c}", err=True))

    try:
        import podcast_mcp

        report.checks.append(DoctorCheck("ok", f"podcast_mcp {podcast_mcp.__version__}"))
    except ImportError as exc:
        report.checks.append(DoctorCheck("fail", f"import: {exc}", err=True))

    try:
        import faster_whisper  # noqa: F401

        report.checks.append(DoctorCheck("ok", "faster-whisper installed"))
    except ImportError:
        report.checks.append(
            DoctorCheck(
                "warn",
                "faster-whisper not importable (needed for transcribe)",
                err=True,
            )
        )

    env_model = os.environ.get("PODCAST_WHISPER_MODEL")
    if env_model and env_model.strip():
        try:
            validate_whisper_model(env_model)
        except ValueError as exc:
            report.checks.append(DoctorCheck("warn", str(exc), err=True))

    preferred = resolve_whisper_model()
    if whisper_model_is_cached(preferred):
        report.checks.append(DoctorCheck("ok", f"whisper model {preferred} cached"))
    else:
        report.checks.append(
            DoctorCheck(
                "warn",
                f"whisper model {preferred} not cached "
                f"(run `podcast bootstrap --component whisper --whisper-model {preferred}` "
                "or it downloads on first transcribe)",
                err=True,
            )
        )

    from podcast_mcp.engines.vad_silero import is_available as silero_available

    if silero_available():
        report.checks.append(
            DoctorCheck("ok", "silero-vad: available (bundled with faster-whisper)")
        )
    else:
        report.checks.append(
            DoctorCheck(
                "warn",
                "silero-vad: not available (onnxruntime/faster-whisper missing)",
                err=True,
            )
        )

    rnn = rnnoise_model_path()
    if rnn.is_file():
        report.checks.append(DoctorCheck("ok", f"rnnoise model: {rnn}"))
    else:
        report.checks.append(
            DoctorCheck(
                "warn",
                "rnnoise model: not bootstrapped "
                "(run `podcast bootstrap --component rnnoise` to enable noise_reduction_rnnoise)",
            )
        )

    ep = _load_project(project)
    if ep is not None:
        from podcast_mcp.engines.session_timeline import timebase_qc_report

        tb = timebase_qc_report(ep)
        for tid, info in tb["tracks"].items():
            drift = float(info["max_drift_sec"])
            extra = ""
            if info.get("unmapped_words"):
                extra = f", unmapped_words={info['unmapped_words']}"
            report.checks.append(
                DoctorCheck("ok", f"timebase {tid}: max_drift={drift:.1f}s{extra}")
            )
        for issue in tb["issues"]:
            report.checks.append(DoctorCheck("warn", f"timebase: {issue}", err=True))

    return report


def echo_doctor_report(report: DoctorReport, echo, echo_err) -> None:
    """Print checks with the historical `podcast doctor` stream split."""
    for check in report.checks:
        writer = echo_err if check.err else echo
        writer(f"[{check.status}] {check.message}")
        if check.extra:
            writer(check.extra)


def _load_project(project: EpisodeProject | Path | None) -> EpisodeProject | None:
    if project is None:
        return None
    if isinstance(project, EpisodeProject):
        return project
    from podcast_mcp.project_io import open_project

    _, ep = open_project(project)
    return ep


def ffmpeg_probe_info() -> dict[str, Any]:
    """Basename-only ffmpeg/ffprobe paths plus version strings."""
    from podcast_mcp.util.binaries import resolve_ffprobe
    from podcast_mcp.util.process import TimeoutExpired, run

    ffmpeg = resolve_ffmpeg()
    ffprobe = resolve_ffprobe()
    engine = FFmpegEngine()
    ok, ffmpeg_ver = engine.check_available()
    probe_ok, probe_ver = False, "ffprobe not found"
    try:
        r = run([ffprobe, "-version"], capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            probe_ok = True
            probe_ver = (r.stdout or "").splitlines()[0] if r.stdout else "ok"
        else:
            probe_ver = r.stderr or "ffprobe failed"
    except (FileNotFoundError, OSError, TimeoutExpired):
        probe_ver = "ffprobe not found"
    return {
        "ffmpeg": {
            "ok": ok,
            "version": ffmpeg_ver,
            "path": Path(ffmpeg).name,
            "source": ffmpeg_source(ffmpeg),
        },
        "ffprobe": {
            "ok": probe_ok,
            "version": probe_ver,
            "path": Path(ffprobe).name,
        },
    }


def python_runtime_info() -> dict[str, str]:
    return {
        "version": sys.version.split()[0],
        "implementation": sys.implementation.name,
    }
