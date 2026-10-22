"""Ordered CDN → upstream URLs for pinned bootstrap assets."""

from __future__ import annotations

import copy
import ipaddress
import logging
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from podcast_mcp import settings
from podcast_mcp.util.atomic_file import publish_completed_file
from podcast_mcp.util.contracts import load_contract
from podcast_mcp.util.hashing import sha256_file

logger = logging.getLogger(__name__)

_MANIFEST_NAME = "bootstrap-assets.json"
_DEFAULT_CDN_ENV = "PODCAST_BOOTSTRAP_CDN_BASE"
_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
_MAX_REDIRECTS = 5


class AssetSourceError(RuntimeError):
    """Bootstrap download failed across all candidate URLs; ``attempts`` holds each URL's error."""

    attempts: tuple[Exception, ...] = ()


class NoDownloadSourceError(AssetSourceError):
    """No CDN base and no upstream URL: nothing to try."""


class AssetIntegrityError(AssetSourceError):
    """A download whose bytes do not match its pin (sha256) or exceed the size cap."""


@dataclass(frozen=True)
class DownloadProgress:
    """Absolute bytes so far and the expected total (None when the source does not say)."""

    bytes: int
    total: int | None

    @property
    def percent(self) -> float | None:
        if self.total is None:
            return None
        return 100.0 if self.total == 0 else min(100.0, self.bytes * 100 / self.total)


OnProgress = Callable[[DownloadProgress], None]
"""Receives download progress; may raise ``CancelledProgress`` and must be thread-safe."""

DOWNLOAD_TASK_ID = "bootstrap.bytes"
"""Progress task id of the model download in flight; its label is the component id."""


class _HttpsRedirectHandler(urllib.request.HTTPRedirectHandler):
    max_redirections = _MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != "https":
            raise AssetSourceError(f"refusing non-HTTPS redirect to {newurl}")
        host = parsed.hostname or ""
        if _is_blocked_host(host):
            raise AssetSourceError(f"refusing redirect host {host}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _https_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_HttpsRedirectHandler)


def _is_blocked_host(host: str) -> bool:
    hostname = (host or "").strip("[]").split("%", 1)[0].lower()
    if not hostname:
        return True
    if hostname in {"localhost", "metadata.google.internal"}:
        return True
    if hostname.endswith(".internal") or hostname.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _sanitize_cdn_base(value: str | None) -> str | None:
    if not value or not str(value).strip():
        return None
    base = str(value).strip().rstrip("/")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "https" or not parsed.netloc:
        logger.warning("ignoring non-HTTPS bootstrap CDN base: %s", base)
        return None
    if _is_blocked_host(parsed.hostname or ""):
        logger.warning("ignoring blocked bootstrap CDN host: %s", parsed.hostname)
        return None
    return base


@lru_cache(maxsize=1)
def _read_manifest() -> dict[str, Any]:
    try:
        return load_contract(_MANIFEST_NAME)
    except FileNotFoundError as exc:
        raise AssetSourceError(f"bootstrap manifest not found: contracts/{_MANIFEST_NAME}") from exc
    except ValueError as exc:
        raise AssetSourceError(f"invalid manifest: contracts/{_MANIFEST_NAME}") from exc


def load_manifest() -> dict[str, Any]:
    return copy.deepcopy(_read_manifest())


def bootstrap_cdn_base() -> str | None:
    env_name = _DEFAULT_CDN_ENV
    default: str | None = None
    try:
        manifest = load_manifest()
        env_name = str(manifest.get("cdn_base_env") or _DEFAULT_CDN_ENV)
        raw_default = manifest.get("cdn_base_default")
        if isinstance(raw_default, str) and raw_default.strip():
            default = raw_default.strip()
    except AssetSourceError:
        pass
    value = settings.text(env_name)
    if value:
        return _sanitize_cdn_base(value)
    return _sanitize_cdn_base(default)


def cdn_base_configured() -> bool:
    try:
        return bootstrap_cdn_base() is not None
    except AssetSourceError:
        return False


def asset_entry(asset_id: str) -> dict[str, Any]:
    assets = load_manifest().get("assets") or {}
    if not isinstance(assets, dict):
        raise AssetSourceError("manifest assets must be an object")
    meta = assets.get(asset_id)
    if not isinstance(meta, dict):
        raise AssetSourceError(f"unknown bootstrap asset id: {asset_id}")
    return meta


def cdn_url_for(asset_id: str, relative_path: str) -> str | None:
    base = bootstrap_cdn_base()
    if not base:
        return None
    prefix = str(asset_entry(asset_id).get("cdn_prefix") or "").strip("/")
    rel = relative_path.lstrip("/")
    return f"{base}/{prefix}/{rel}" if prefix else f"{base}/{rel}"


def upstream_http_url(asset_id: str) -> str | None:
    meta = asset_entry(asset_id)
    url = meta.get("url")
    if isinstance(url, str) and url.strip():
        return url.strip()
    return None


def ordered_http_urls(asset_id: str, *, relative_path: str) -> list[str]:
    urls: list[str] = []
    cdn = cdn_url_for(asset_id, relative_path)
    if cdn:
        urls.append(cdn)
    upstream = upstream_http_url(asset_id)
    if upstream:
        urls.append(upstream)
    return urls


def _copy_bounded(
    src: Any,
    dest: Any,
    *,
    max_bytes: int,
    total: int | None = None,
    on_progress: OnProgress | None = None,
) -> None:
    remaining = max_bytes
    while True:
        chunk = src.read(min(1024 * 1024, remaining + 1))
        if not chunk:
            return
        if len(chunk) > remaining:
            raise AssetIntegrityError(f"download exceeds {max_bytes} bytes")
        dest.write(chunk)
        remaining -= len(chunk)
        if on_progress is not None:
            on_progress(DownloadProgress(max_bytes - remaining, total))


def _content_length(resp: Any) -> int | None:
    headers = getattr(resp, "headers", None)
    value = headers.get("Content-Length") if headers is not None else None
    return int(value) if value is not None and value.isdigit() else None


def _source_label(url: str) -> str:
    base = bootstrap_cdn_base()
    if base and (url == base or url.startswith(f"{base}/")):
        return "cdn"
    return "upstream"


def _download_url(
    url: str,
    dest: Path,
    *,
    timeout: float = 120.0,
    expected_sha256: str | None = None,
    max_bytes: int = _MAX_DOWNLOAD_BYTES,
    on_progress: OnProgress | None = None,
) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"refusing non-HTTPS download URL: {url!r}")
    if _is_blocked_host(parsed.hostname or ""):
        raise ValueError(f"refusing download host {parsed.hostname!r}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.{uuid.uuid4().hex}.part")
    try:
        req = urllib.request.Request(url, method="GET")
        with (
            _https_opener().open(req, timeout=timeout) as resp,  # nosec B310
            tmp.open("wb") as handle,
        ):
            total = _content_length(resp)
            if on_progress is not None:
                on_progress(DownloadProgress(0, total))
            _copy_bounded(resp, handle, max_bytes=max_bytes, total=total, on_progress=on_progress)
        if expected_sha256:
            got = sha256_file(tmp)
            if got != expected_sha256.lower():
                raise AssetIntegrityError(
                    f"sha256 mismatch for {dest.name}: expected {expected_sha256}, got {got}"
                )
        publish_completed_file(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


def download_first_ok(
    urls: Iterable[str],
    dest: Path,
    *,
    expected_sha256: str | None = None,
    timeout: float = 120.0,
    on_progress: OnProgress | None = None,
) -> str:
    """Download from the first URL that succeeds. Returns a short source label.

    A URL that fails restarts progress at zero on the next one. The error raised when every
    URL fails carries each URL's own error as ``attempts``.
    """
    attempts: list[Exception] = []
    url_list = list(urls)
    if not url_list:
        raise NoDownloadSourceError("no download URLs")
    for index, url in enumerate(url_list):
        try:
            _download_url(
                url,
                dest,
                timeout=timeout,
                expected_sha256=expected_sha256,
                on_progress=on_progress,
            )
            return _source_label(url)
        except (OSError, AssetSourceError, ValueError, TimeoutError, urllib.error.URLError) as exc:
            attempts.append(exc)
            if index == 0 and len(url_list) > 1:
                logger.info("bootstrap CDN miss for %s (%s); trying upstream", dest.name, exc)
    detail = "; ".join(f"{url}: {exc}" for url, exc in zip(url_list, attempts, strict=True))
    error = AssetSourceError(detail)
    error.attempts = tuple(attempts)
    raise error from attempts[-1]
