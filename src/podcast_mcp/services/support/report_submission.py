"""Host-only forwarding of a user-approved, registered diagnostics bundle."""

from __future__ import annotations

import base64
from pathlib import Path
from urllib.parse import urlparse

import httpx

from podcast_mcp import settings
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.diagnostics_bundle_contract import (
    MAX_BUNDLE_BYTES,
    BundlePreview,
    validate_diagnostics_bundle,
)


def _read_bundle(path: Path) -> bytes:
    with path.open("rb") as source:
        data = source.read(MAX_BUNDLE_BYTES + 1)
    if len(data) > MAX_BUNDLE_BYTES:
        raise CodedValueError(
            "diagnostics bundle must be at most 5 MiB", code="report_bundle_too_large"
        )
    return data


def preview_bundle(path: Path) -> BundlePreview:
    return validate_diagnostics_bundle(_read_bundle(path))


def report_relay_url() -> str:
    url = settings.text("PODCAST_REPORT_RELAY_URL").rstrip("/")
    parsed = urlparse(url)
    if (
        not url
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise CodedValueError("report relay is not configured", code="report_relay_not_configured")
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise CodedValueError("report relay must use HTTPS", code="report_relay_not_https")
    return url


def submit_bundle(path: Path, *, description: str) -> dict[str, str]:
    url = report_relay_url()
    if not 10 <= len(description.strip()) <= 4000:
        raise CodedValueError(
            "description must be 10-4000 characters", code="report_description_length"
        )
    data = _read_bundle(path)
    validate_diagnostics_bundle(data)
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        response = client.post(
            f"{url}/api/reports",
            json={
                "description": description.strip(),
                "bundle": base64.b64encode(data).decode("ascii"),
                "consent": True,
            },
        )
    response.raise_for_status()
    result = response.json()
    if result.get("status") != "queued" or not isinstance(result.get("status_url"), str):
        raise CodedValueError(
            "report relay returned an invalid response", code="report_relay_response_invalid"
        )
    status_url = result["status_url"]
    if not status_url.startswith(f"{url}/api/reports/"):
        raise CodedValueError(
            "report relay returned an invalid status URL", code="report_relay_status_url_invalid"
        )
    return {"status": "queued", "status_url": status_url}


def get_report_status(status_url: str) -> dict[str, str | None]:
    url = report_relay_url()
    if not status_url.startswith(f"{url}/api/reports/"):
        raise CodedValueError("invalid report status URL", code="report_status_url_invalid")
    with httpx.Client(timeout=10.0, follow_redirects=False) as client:
        response = client.get(status_url)
    response.raise_for_status()
    result = response.json()
    status = result.get("status")
    issue_url = result.get("issue_url")
    if status not in {"queued", "published", "publish_uncertain", "failed"} or (
        issue_url is not None
        and (not isinstance(issue_url, str) or not issue_url.startswith("https://github.com/"))
    ):
        raise CodedValueError(
            "report relay returned an invalid status", code="report_relay_status_invalid"
        )
    return {"status": status, "issue_url": issue_url}
