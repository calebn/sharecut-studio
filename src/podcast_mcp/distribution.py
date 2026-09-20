"""Validated build-time desktop distribution identity.

Distribution profiles contain public identity and trust policy only.  Runtime
credentials belong in environment variables or ``relay.yaml``.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

_BUNDLE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$")
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*$")
_FORBIDDEN_SCHEMES = {"http", "https", "file", "javascript", "data", "tauri", "asset"}
_SECRET_KEY = re.compile(r"(?:secret|password|token|private.?key|access.?key|signing)", re.I)
_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")


class DistributionProfileError(ValueError):
    """A distribution profile is malformed or weakens a trust boundary."""


@dataclass(frozen=True)
class DistributionMetadata:
    """Public distributor links passed from the desktop host to its sidecar."""

    support_url: str
    privacy_url: str
    repository_url: str
    release_manifest_url: str | None


_SAFE_DISTRIBUTION_METADATA = DistributionMetadata(
    support_url="https://github.com/calebn/sharecut-studio/issues",
    privacy_url="https://github.com/calebn/sharecut-studio/blob/main/PRIVACY.md",
    repository_url="https://github.com/calebn/sharecut-studio",
    release_manifest_url=None,
)
_METADATA_ENV = {
    "support_url": "PODCAST_DISTRIBUTION_SUPPORT_URL",
    "privacy_url": "PODCAST_DISTRIBUTION_PRIVACY_URL",
    "repository_url": "PODCAST_DISTRIBUTION_REPOSITORY_URL",
    "release_manifest_url": "PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL",
}


@dataclass(frozen=True)
class DistributionProfile:
    version: int
    product_name: str
    bundle_identifier: str
    deep_link_schemes: tuple[str, ...]
    allowed_https_share_origins: tuple[str, ...]
    support_url: str
    privacy_url: str
    repository_url: str
    release_manifest_url: str | None
    bootstrap_cdn_base: str | None


def compact_product_name(profile: DistributionProfile) -> str:
    """Return the filesystem-safe installer stem derived from a public profile."""
    return "".join(profile.product_name.split())


def default_distribution_profile_path() -> Path:
    return Path(__file__).resolve().parents[2] / "config" / "distribution.dev.json"


def _validate_public_https_url(name: str, raw: Any, *, origin: bool = False) -> str:
    value = str(raw or "").strip()
    try:
        parsed = urlparse(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise DistributionProfileError(f"{name} must be an absolute HTTPS URL") from exc
    if parsed.scheme != "https" or not host:
        raise DistributionProfileError(f"{name} must be an absolute HTTPS URL")
    if parsed.username or parsed.password:
        raise DistributionProfileError(f"{name} must not contain user information")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if host.lower() == "localhost" or (address is not None and not address.is_global):
        raise DistributionProfileError(f"{name} must use a public host")
    if origin and (port is not None or parsed.path not in {"", "/"}):
        raise DistributionProfileError(f"{name} must be an exact HTTPS origin without port or path")
    if origin and (parsed.query or parsed.fragment):
        raise DistributionProfileError(f"{name} must not contain a query or fragment")
    normalized_host = f"[{host.lower()}]" if ":" in host else host.lower()
    normalized_netloc = f"{normalized_host}:{port}" if port is not None else normalized_host
    if origin:
        return f"https://{normalized_netloc}"
    return urlunparse(
        (
            "https",
            normalized_netloc,
            parsed.path.rstrip("/"),
            parsed.params,
            parsed.query,
            parsed.fragment,
        )
    )


def _safe_runtime_url(raw: str | None, fallback: str | None) -> str | None:
    """Accept only public HTTPS values from the native host's environment."""
    if raw is None:
        return fallback
    try:
        return _validate_public_https_url("distribution metadata", raw)
    except DistributionProfileError:
        return fallback


def runtime_distribution_metadata(
    environ: Mapping[str, str] | None = None,
) -> DistributionMetadata:
    """Return sidecar metadata, falling closed to safe upstream public links.

    The desktop host injects these public build constants for each sidecar
    process. CLI and source runs use the same safe upstream values. Invalid or
    missing optional release metadata is deliberately unavailable.
    """
    source = environ if environ is not None else os.environ
    return DistributionMetadata(
        support_url=_safe_runtime_url(
            source.get(_METADATA_ENV["support_url"]),
            _SAFE_DISTRIBUTION_METADATA.support_url,
        )
        or _SAFE_DISTRIBUTION_METADATA.support_url,
        privacy_url=_safe_runtime_url(
            source.get(_METADATA_ENV["privacy_url"]),
            _SAFE_DISTRIBUTION_METADATA.privacy_url,
        )
        or _SAFE_DISTRIBUTION_METADATA.privacy_url,
        repository_url=_safe_runtime_url(
            source.get(_METADATA_ENV["repository_url"]),
            _SAFE_DISTRIBUTION_METADATA.repository_url,
        )
        or _SAFE_DISTRIBUTION_METADATA.repository_url,
        release_manifest_url=_safe_runtime_url(
            source.get(_METADATA_ENV["release_manifest_url"]),
            None,
        ),
    )


def _reject_secret_fields(value: Any, path: str = "profile") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if _SECRET_KEY.search(str(key)):
                raise DistributionProfileError(
                    f"{path}.{key} looks like a secret; distribution profiles are public"
                )
            _reject_secret_fields(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_secret_fields(child, f"{path}[{index}]")


def distribution_profile_from_mapping(raw: dict[str, Any]) -> DistributionProfile:
    _reject_secret_fields(raw)
    allowed_keys = {
        "$schema",
        "version",
        "product_name",
        "bundle_identifier",
        "deep_link_schemes",
        "allowed_https_share_origins",
        "support_url",
        "privacy_url",
        "repository_url",
        "release_manifest_url",
        "bootstrap_cdn_base",
    }
    unknown = sorted(set(raw) - allowed_keys)
    if unknown:
        raise DistributionProfileError("unknown distribution profile fields: " + ", ".join(unknown))
    if raw.get("version") != 1:
        raise DistributionProfileError("distribution profile version must be 1")
    product_name = str(raw.get("product_name") or "").strip()
    if not product_name or len(product_name) > 64:
        raise DistributionProfileError("product_name must contain 1-64 characters")
    if _CONTROL_CHARACTER.search(product_name):
        raise DistributionProfileError("product_name must not contain control characters")
    bundle_id = str(raw.get("bundle_identifier") or "").strip()
    if not _BUNDLE_ID.fullmatch(bundle_id):
        raise DistributionProfileError("bundle_identifier must use reverse-DNS syntax")

    scheme_rows = raw.get("deep_link_schemes")
    if not isinstance(scheme_rows, list):
        raise DistributionProfileError("deep_link_schemes must be an array")
    schemes: list[str] = []
    for item in scheme_rows:
        scheme = str(item).strip()
        if not _SCHEME.fullmatch(scheme) or scheme in _FORBIDDEN_SCHEMES:
            raise DistributionProfileError(f"invalid custom deep-link scheme: {scheme!r}")
        if scheme not in schemes:
            schemes.append(scheme)

    origin_rows = raw.get("allowed_https_share_origins")
    if not isinstance(origin_rows, list):
        raise DistributionProfileError("allowed_https_share_origins must be an array")
    origins: list[str] = []
    for index, item in enumerate(origin_rows):
        origin = _validate_public_https_url(
            f"allowed_https_share_origins[{index}]", item, origin=True
        )
        if origin not in origins:
            origins.append(origin)
    if schemes and not origins:
        raise DistributionProfileError(
            "deep_link_schemes require at least one allowed_https_share_origin"
        )

    release_raw = raw.get("release_manifest_url")
    cdn_raw = raw.get("bootstrap_cdn_base")
    return DistributionProfile(
        version=1,
        product_name=product_name,
        bundle_identifier=bundle_id,
        deep_link_schemes=tuple(schemes),
        allowed_https_share_origins=tuple(origins),
        support_url=_validate_public_https_url("support_url", raw.get("support_url")),
        privacy_url=_validate_public_https_url("privacy_url", raw.get("privacy_url")),
        repository_url=_validate_public_https_url("repository_url", raw.get("repository_url")),
        release_manifest_url=(
            _validate_public_https_url("release_manifest_url", release_raw)
            if release_raw is not None
            else None
        ),
        bootstrap_cdn_base=(
            _validate_public_https_url("bootstrap_cdn_base", cdn_raw)
            if cdn_raw is not None
            else None
        ),
    )


def load_distribution_profile(path: Path | None = None) -> DistributionProfile:
    source = path or default_distribution_profile_path()
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DistributionProfileError(
            f"cannot parse distribution profile {source}: {exc}"
        ) from exc
    if not isinstance(raw, dict):
        raise DistributionProfileError(f"distribution profile {source} must be a JSON object")
    return distribution_profile_from_mapping(raw)


def tauri_distribution_overlay(profile: DistributionProfile) -> dict[str, Any]:
    """Return the Tauri config fragment generated from one validated profile."""
    mobile: list[dict[str, Any]] = []
    for origin in profile.allowed_https_share_origins:
        mobile.append(
            {
                "scheme": ["https"],
                "host": urlparse(origin).hostname,
                "pathPrefix": ["/r/", "/rec/"],
                "appLink": False,
            }
        )
    mobile.extend({"scheme": [scheme], "appLink": False} for scheme in profile.deep_link_schemes)
    return {
        "productName": profile.product_name,
        "identifier": profile.bundle_identifier,
        "app": {
            "windows": [
                {
                    "label": "main",
                    "title": profile.product_name,
                    "width": 1280,
                    "height": 800,
                    "resizable": True,
                    "fullscreen": False,
                }
            ]
        },
        "plugins": {
            "deep-link": {
                "desktop": {"schemes": list(profile.deep_link_schemes)},
                "mobile": mobile,
            }
        },
    }
