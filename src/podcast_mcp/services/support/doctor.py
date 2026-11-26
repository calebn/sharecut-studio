"""Structured `podcast doctor` checks shared by CLI and diagnostics."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from podcast_mcp import settings
from podcast_mcp.config.defaults import cache_dir
from podcast_mcp.engines import FFmpegEngine
from podcast_mcp.engines.models.registry import MODELS, model_record
from podcast_mcp.engines.models.speaker_ecapa import (
    SPEAKER_ECAPA_ASSET,
    speaker_ecapa_override,
    speaker_ecapa_path,
)
from podcast_mcp.engines.models.whisper import (
    WhisperPinMismatchError,
    resolve_whisper_model,
    validate_whisper_model,
    whisper_bootstrap_command,
    whisper_model_problem,
)
from podcast_mcp.engines.whisper_device import describe_placement
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.asset_sources import ordered_http_urls
from podcast_mcp.util.binaries import (
    IN_PROCESS_FFMPEG,
    IN_PROCESS_FFPROBE,
    IN_PROCESS_LABEL,
    IN_PROCESS_SOURCE,
    FFmpegPairResolutionError,
    in_process_build_id,
    in_process_problem,
    resolve_ffmpeg_pair,
)
from podcast_mcp.util.hardware import accelerator_preference, hardware_profile
from podcast_mcp.util.model_assets import rnnoise_override

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
    *,
    deep: bool = False,
) -> DoctorReport:
    """Run the same health checks as `podcast doctor` (no I/O besides reads).

    ``deep`` also hashes every segment's audio; without it the segment check only looks at
    file presence and size, so the default CLI check and support bundle stay cheap.
    """
    report = DoctorReport()
    try:
        engine = FFmpegEngine()
    except FFmpegPairResolutionError as exc:
        ok, msg = False, str(exc)
    else:
        ok, msg = engine.check_available()
    if ok:
        source = engine.source
        report.checks.append(DoctorCheck("ok", f"ffmpeg ({source}): {msg}"))
    else:
        report.checks.append(
            DoctorCheck(
                "fail",
                f"ffmpeg: {msg}",
                err=True,
                extra="  Fix: install a matching FFmpeg 9.0.2 or later 9.x pair; see docs/setup.md",
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

    report.checks.append(
        DoctorCheck("ok", f"hardware: {hardware_profile().summary(accelerator_preference())}")
    )

    env_model = settings.raw("PODCAST_WHISPER_MODEL")
    if env_model and env_model.strip():
        try:
            validate_whisper_model(env_model)
        except ValueError as exc:
            report.checks.append(DoctorCheck("warn", str(exc), err=True))

    preferred = resolve_whisper_model()
    report.checks.append(DoctorCheck("ok", describe_placement(preferred)))
    whisper_problem = whisper_model_problem(preferred, memoize=True)
    if whisper_problem is None:
        report.checks.append(DoctorCheck("ok", f"whisper model {preferred} cached"))
    elif isinstance(whisper_problem, WhisperPinMismatchError):
        report.checks.append(
            DoctorCheck("fail", f"whisper model {preferred}: {whisper_problem}", err=True)
        )
    else:
        report.checks.append(
            DoctorCheck(
                "warn",
                f"whisper model {preferred} not cached "
                f"(run `{whisper_bootstrap_command(preferred)}`; "
                "a CLI run asks before downloading it on a terminal and never otherwise)",
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

    report.checks.extend(_model_checks())
    report.checks.extend(_segment_library_checks(deep=deep))
    report.checks.extend(_kit_library_checks())

    ep = _load_project(project)
    if ep is not None:
        from podcast_mcp.engines.session_timeline import timebase_qc_report

        tb = timebase_qc_report(ep)
        for tid, info in tb["tracks"].items():
            drift = float(info["max_drift_sec"])
            extra = ""
            if info.get("unmapped_words"):
                extra = f", unmapped_words={info['unmapped_words']}"
            if info.get("zero_length_words"):
                extra += f", zero_length_words={info['zero_length_words']}"
            if info.get("inverted_words"):
                extra += f", inverted_words={info['inverted_words']}"
            report.checks.append(
                DoctorCheck("ok", f"timebase {tid}: max_drift={drift:.1f}s{extra}")
            )
        for issue in tb["issues"]:
            report.checks.append(DoctorCheck("warn", f"timebase: {issue}", err=True))

    return report


def _own_advice_when_missing(model_id: str) -> bool:
    """True when a missing row's registry hint says more than "run bootstrap".

    That is an override env var pointing at a file that is not there (bootstrap does not fix
    it) and a source build with no download source for the speaker model (bootstrap cannot
    succeed); the registry hint carries the right advice for both.
    """
    if model_id == "rnnoise":
        return rnnoise_override() is not None
    if model_id == "speaker-ecapa":
        return speaker_ecapa_override() is not None or not ordered_http_urls(
            SPEAKER_ECAPA_ASSET, relative_path=speaker_ecapa_path().name
        )
    return False


def _hint_without_label(label: str, hint: str) -> str:
    """The hint minus a leading ``<label>:`` or ``<label>`` so the line does not repeat it."""
    for prefix in (f"{label}:", label):
        if hint.startswith(prefix):
            return hint.removeprefix(prefix).lstrip()
    return hint


def _model_checks() -> list[DoctorCheck]:
    """One line per registry row except whisper (which has its own); never loads a model.

    ``installed`` prints no path: an override file is only checked for existence, and the
    registry location is not always the file in use.
    """
    checks: list[DoctorCheck] = []
    for spec in MODELS:
        if spec.id == "whisper":
            continue
        record = model_record(spec.id, memoize=True)
        state = record["state"]
        if state == "installed":
            checks.append(DoctorCheck("ok", f"{spec.label}: installed"))
        elif state == "missing" and not _own_advice_when_missing(spec.id):
            checks.append(
                DoctorCheck(
                    "warn",
                    f"{spec.label}: not downloaded "
                    f"(run `{spec.fix_command}`; needed for {spec.purpose})",
                    err=True,
                )
            )
        else:
            status: DoctorStatus = "fail" if state == "update_needed" else "warn"
            hint = _hint_without_label(spec.label, record["hint"])
            checks.append(DoctorCheck(status, f"{spec.label}: {hint}", err=True))
    return checks


MAX_DAMAGED_SEGMENTS_LISTED = 5


def _segment_library_checks(*, deep: bool = False) -> list[DoctorCheck]:
    """One warning per damaged segment (newest version), capped; silent when all are intact.

    Looks at file presence, size and ``segment.json``; ``deep`` also hashes the audio. A
    missing library costs nothing. Older versions are not checked.
    """
    from podcast_mcp.segments.store import SegmentStore, default_directory
    from podcast_mcp.segments.summary import damaged_fix

    directory = default_directory()
    try:
        present = directory.is_dir() and any(directory.iterdir())
    except OSError:
        return []
    if not present:
        return []
    try:
        store = SegmentStore(directory)
        damaged = store.scan(deep=deep).damaged
    except OSError as exc:
        return [DoctorCheck("warn", f"segment library: cannot be read: {exc}", err=True)]
    checks = [
        DoctorCheck(
            "warn",
            f"segment {d.id} (v{d.version}): {d.problem}",
            err=True,
            extra=f"  Fix: {damaged_fix(store, d)}",
        )
        for d in damaged[:MAX_DAMAGED_SEGMENTS_LISTED]
    ]
    if len(damaged) > MAX_DAMAGED_SEGMENTS_LISTED:
        more = len(damaged) - MAX_DAMAGED_SEGMENTS_LISTED
        command = "podcast segment list --deep" if deep else "podcast segment list"
        checks.append(
            DoctorCheck(
                "warn",
                f"{more} more damaged segments; `{command}` shows all of them",
                err=True,
            )
        )
    return checks


def _kit_library_checks() -> list[DoctorCheck]:
    """One warning per kit (newest version) naming segments that are not in the library.

    Reads each ``kit.json`` and lists segment folders; no audio is read. Silent without kits.
    """
    from podcast_mcp.segments.kit import KitStore, default_kit_directory
    from podcast_mcp.segments.kit_summary import find_missing
    from podcast_mcp.segments.store import SegmentStore, default_directory

    directory = default_kit_directory()
    try:
        if not (directory.is_dir() and any(directory.iterdir())):
            return []
        listing = KitStore(directory).scan()
        segments = SegmentStore(default_directory())
        checks: list[DoctorCheck] = []
        for kit in listing.kits:
            missing = find_missing(kit, segments)
            if not missing:
                continue
            names = ", ".join(m.entry.label() for m in missing[:MAX_DAMAGED_SEGMENTS_LISTED])
            more = len(missing) - MAX_DAMAGED_SEGMENTS_LISTED
            checks.append(
                DoctorCheck(
                    "warn",
                    f"kit {kit.id} (v{kit.version}): {len(missing)} of its segments {'is' if len(missing) == 1 else 'are'} not in "
                    f"the library: {names}{f' and {more} more' if more > 0 else ''}",
                    err=True,
                    extra="  Fix: import the segments (or the kit's .sharecutkit file) again, "
                    f"or save the kit again without them (`podcast kit show {kit.id}`).",
                )
            )
        checks.extend(
            DoctorCheck("warn", f"kit {d.id} (v{d.version}): {d.problem}", err=True)
            for d in listing.damaged
        )
        return checks
    except OSError as exc:
        return [DoctorCheck("warn", f"kit library: cannot be read: {exc}", err=True)]


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
    from podcast_mcp.project.io import adopt_retired_entry_file, open_project

    _, ep = open_project(adopt_retired_entry_file(project))
    return ep


def ffmpeg_probe_info() -> dict[str, Any]:
    """Basename-only ffmpeg/ffprobe paths plus version strings."""
    try:
        pair = resolve_ffmpeg_pair()
        if pair.is_in_process:
            problem = in_process_problem()
            info = {
                "ok": problem is None,
                "version": IN_PROCESS_LABEL if problem is None else problem,
                "build_id": in_process_build_id() if problem is None else None,
                "path": IN_PROCESS_FFMPEG,
                "source": IN_PROCESS_SOURCE,
            }
            return {"ffmpeg": info, "ffprobe": {**info, "path": IN_PROCESS_FFPROBE}}
        ffmpeg, ffprobe = pair.ffmpeg, pair.ffprobe
        engine = FFmpegEngine(ffmpeg, ffprobe)
        ok, ffmpeg_ver = engine.check_available()
    except FFmpegPairResolutionError as exc:
        return {
            name: {"ok": False, "version": str(exc), "path": name, "source": "unavailable"}
            for name in ("ffmpeg", "ffprobe")
        }
    probe_ok, probe_ver = engine.check_ffprobe_version()
    return {
        "ffmpeg": {
            "ok": ok,
            "version": ffmpeg_ver,
            "path": Path(ffmpeg).name,
            "source": pair.source,
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
