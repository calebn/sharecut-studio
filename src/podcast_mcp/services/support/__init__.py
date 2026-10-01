from importlib import import_module
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from podcast_mcp.services.support.config_check import run_config_checks
    from podcast_mcp.services.support.diagnostics import (
        MAX_BUNDLE_BYTES,
        BundleReport,
        DiagnosticsService,
        bundle_filename,
        default_bundle_dir,
        is_allowed_bundle_name,
        resolve_bundle_file,
    )
    from podcast_mcp.services.support.doctor import (
        DoctorCheck,
        DoctorReport,
        echo_doctor_report,
        run_doctor_checks,
    )
    from podcast_mcp.services.support.report_submission import (
        get_report_status,
        preview_bundle,
        report_relay_url,
        submit_bundle,
    )

__all__ = [
    "MAX_BUNDLE_BYTES",
    "BundleReport",
    "DiagnosticsService",
    "DoctorCheck",
    "DoctorReport",
    "bundle_filename",
    "default_bundle_dir",
    "echo_doctor_report",
    "get_report_status",
    "is_allowed_bundle_name",
    "preview_bundle",
    "report_relay_url",
    "resolve_bundle_file",
    "run_config_checks",
    "run_doctor_checks",
    "submit_bundle",
]

_MODULE_BY_NAME = {
    "run_config_checks": "config_check",
    "MAX_BUNDLE_BYTES": "diagnostics",
    "BundleReport": "diagnostics",
    "DiagnosticsService": "diagnostics",
    "bundle_filename": "diagnostics",
    "default_bundle_dir": "diagnostics",
    "is_allowed_bundle_name": "diagnostics",
    "resolve_bundle_file": "diagnostics",
    "DoctorCheck": "doctor",
    "DoctorReport": "doctor",
    "echo_doctor_report": "doctor",
    "run_doctor_checks": "doctor",
    "get_report_status": "report_submission",
    "preview_bundle": "report_submission",
    "report_relay_url": "report_submission",
    "submit_bundle": "report_submission",
}


def __getattr__(name: str) -> object:
    try:
        module = _MODULE_BY_NAME[name]
    except KeyError:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from None
    value = getattr(import_module(f"{__name__}.{module}"), name)
    globals()[name] = value
    return value
