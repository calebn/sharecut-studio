"""Configuration diagnostics for local, self-hosted, and distributor modes."""

from __future__ import annotations

from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from podcast_mcp.distribution import DistributionProfileError, load_distribution_profile
from podcast_mcp.runtime_config import (
    RuntimeConfigError,
    is_loopback_host,
    load_host_runtime_config,
)
from podcast_mcp.services.doctor import DoctorCheck, DoctorReport

ConfigMode = Literal["local", "self-hosted", "distributor"]


def run_config_checks(
    mode: ConfigMode,
    *,
    relay_config: Path | None = None,
    distribution_profile: Path | None = None,
) -> DoctorReport:
    """Validate only the configuration required by ``mode``; never contact a service."""
    report = DoctorReport()
    if mode == "local":
        report.checks.append(
            DoctorCheck("ok", "local mode needs no relay, object store, account, or CDN")
        )
        if distribution_profile is None:
            report.checks.append(
                DoctorCheck("ok", "distribution profile: not required for local mode")
            )
            return report
        try:
            profile = load_distribution_profile(distribution_profile)
        except DistributionProfileError as exc:
            report.checks.append(DoctorCheck("fail", f"development profile: {exc}", err=True))
        else:
            report.checks.append(DoctorCheck("ok", f"development profile: {profile.product_name}"))
        return report

    if mode == "self-hosted":
        try:
            config = load_host_runtime_config(relay_config)
        except RuntimeConfigError as exc:
            report.checks.append(DoctorCheck("fail", str(exc), err=True))
            return report
        relay_host = urlparse(config.relay.relay_url).hostname or ""
        is_local = is_loopback_host(relay_host)
        if not is_local and not config.relay.host_token:
            report.checks.append(
                DoctorCheck(
                    "fail",
                    "remote self-hosted relay requires PODCAST_RELAY_HOST_TOKEN or host_token",
                    err=True,
                )
            )
        else:
            scope = "loopback development" if is_local else "authenticated remote relay"
            report.checks.append(DoctorCheck("ok", f"relay: {scope}"))
        report.checks.append(DoctorCheck("ok", "public share origin is valid"))
        if config.object_store is None:
            report.checks.append(
                DoctorCheck("ok", "object store: disabled; host media proxy fallback will be used")
            )
        else:
            report.checks.append(
                DoctorCheck("ok", "object store: configured (credentials redacted)")
            )
        return report

    if mode == "distributor":
        try:
            profile = load_distribution_profile(distribution_profile)
        except DistributionProfileError as exc:
            report.checks.append(DoctorCheck("fail", str(exc), err=True))
            return report
        report.checks.append(DoctorCheck("ok", f"distribution profile: {profile.product_name}"))
        if not profile.allowed_https_share_origins:
            report.checks.append(
                DoctorCheck(
                    "fail",
                    "distributor profile needs at least one exact allowed HTTPS share origin",
                    err=True,
                )
            )
        else:
            report.checks.append(
                DoctorCheck(
                    "ok",
                    f"allowed HTTPS share origins: {len(profile.allowed_https_share_origins)}",
                )
            )
        if profile.release_manifest_url is None:
            report.checks.append(
                DoctorCheck(
                    "fail",
                    "distributor profile needs release_manifest_url",
                    err=True,
                )
            )
        else:
            report.checks.append(DoctorCheck("ok", "release manifest URL configured"))
        if profile.bootstrap_cdn_base is None:
            report.checks.append(
                DoctorCheck("warn", "bootstrap CDN disabled; upstream asset fallback will be used")
            )
        else:
            report.checks.append(DoctorCheck("ok", "bootstrap CDN configured"))
        return report

    raise ValueError(f"unsupported config mode: {mode}")
