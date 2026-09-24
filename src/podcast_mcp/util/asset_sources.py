"""Ordered CDN → upstream URLs for pinned bootstrap assets."""

from __future__ import annotations

import copy
import ipaddress
import json
import logging
import platform
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Iterable
from functools import lru_cache
from os import environ
from pathlib import Path
from typing import Any

from podcast_mcp.util.hashing import sha256_file

logger = logging.getLogger(__name__)

_MANIFEST_NAME = "bootstrap-assets.json"
_DEFAULT_CDN_ENV = "PODCAST_BOOTSTRAP_CDN_BASE"
_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
_MAX_REDIRECTS = 5


class AssetSourceError(RuntimeError):
    """Bootstrap download failed across all candidate URLs."""


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


def manifest_path() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "contracts" / _MANIFEST_NAME
        if candidate.is_file():
            return candidate
    bundled = here.parent / _MANIFEST_NAME
    if bundled.is_file():
        return bundled
    raise AssetSourceError(f"bootstrap manifest not found: contracts/{_MANIFEST_NAME}")


@lru_cache(maxsize=1)
def _read_manifest() -> dict[str, Any]:
    path = manifest_path()
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise AssetSourceError(f"invalid manifest: {path}")
    return raw


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
    value = environ.get(env_name, "").strip()
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


def _copy_bounded(src: Any, dest: Any, *, max_bytes: int) -> None:
    remaining = max_bytes
    while True:
        chunk = src.read(min(1024 * 1024, remaining + 1))
        if not chunk:
            return
        if len(chunk) > remaining:
            raise AssetSourceError(f"download exceeds {max_bytes} bytes")
        dest.write(chunk)
        remaining -= len(chunk)


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
            _copy_bounded(resp, handle, max_bytes=max_bytes)
        if expected_sha256:
            got = sha256_file(tmp)
            if got != expected_sha256.lower():
                raise AssetSourceError(
                    f"sha256 mismatch for {dest.name}: expected {expected_sha256}, got {got}"
                )
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)


def download_first_ok(
    urls: Iterable[str],
    dest: Path,
    *,
    expected_sha256: str | None = None,
    timeout: float = 120.0,
) -> str:
    """Download from the first URL that succeeds. Returns a short source label."""
    last_error: Exception | None = None
    errors: list[str] = []
    url_list = list(urls)
    for index, url in enumerate(url_list):
        try:
            _download_url(url, dest, timeout=timeout, expected_sha256=expected_sha256)
            if expected_sha256 and dest.is_file():
                got = sha256_file(dest)
                if got != expected_sha256.lower():
                    dest.unlink(missing_ok=True)
                    raise AssetSourceError(
                        f"sha256 mismatch for {dest.name}: expected {expected_sha256}, got {got}"
                    )
            return _source_label(url)
        except (OSError, AssetSourceError, ValueError, TimeoutError, urllib.error.URLError) as exc:
            last_error = exc
            errors.append(f"{url}: {exc}")
            if index == 0 and len(url_list) > 1:
                logger.info("bootstrap CDN miss for %s (%s); trying upstream", dest.name, exc)
    detail = "; ".join(errors) if errors else "no download URLs"
    raise AssetSourceError(detail) from last_error


def ffmpeg_platform_slug() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "darwin":
        if machine in {"arm64", "aarch64"}:
            return "darwin-arm64"
        return "darwin-x64"
    if system == "windows":
        return "windows-x64"
    if machine in {"x86_64", "amd64"}:
        return "linux-x64"
    return f"{system}-{machine}"


def ffmpeg_cdn_relative_paths() -> tuple[str, str]:
    slug = ffmpeg_platform_slug()
    suffix = ".exe" if platform.system().lower() == "windows" else ""
    return (f"{slug}/ffmpeg{suffix}", f"{slug}/ffprobe{suffix}")


def ffmpeg_cdn_pins() -> tuple[str, str] | None:
    """Return (ffmpeg, ffprobe) sha256 pins for this platform, if present."""
    meta = asset_entry("ffmpeg")
    by_plat = meta.get("sha256_by_platform")
    if not isinstance(by_plat, dict):
        return None
    ff_rel, fp_rel = ffmpeg_cdn_relative_paths()
    ff = by_plat.get(ff_rel)
    fp = by_plat.get(fp_rel)
    if isinstance(ff, str) and isinstance(fp, str) and ff.strip() and fp.strip():
        return ff.strip().lower(), fp.strip().lower()
    return None
