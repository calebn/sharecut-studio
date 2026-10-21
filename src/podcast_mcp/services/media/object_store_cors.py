"""Guest's-eye CORS check for object-store media (#1759).

The guest player reads proxy chunks with ``fetch`` from the share page's origin, so the
bucket must answer with ``Access-Control-Allow-Origin`` for that origin. A bucket without the
rule answers ``200`` to a plain ``GET`` (curl works) while every browser fetch fails, which looks
fine to the host and is silent for the guest.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlparse

from podcast_mcp.util.bounded_cache import BoundedCache

log = logging.getLogger(__name__)

CorsStatus = Literal["ok", "blocked", "unknown"]

_PROBE_TIMEOUT_SEC = 3.0
_OK_TTL_SEC = 300.0
_FAIL_TTL_SEC = 60.0


@dataclass(frozen=True)
class CorsProbe:
    """Result of one guest's-eye request against an object-store URL."""

    status: CorsStatus
    origin: str
    detail: str = ""

    @property
    def blocked(self) -> bool:
        return self.status == "blocked"


Fetcher = Callable[[str, str], "dict[str, str] | None"]


def cors_rule(origin: str) -> list[dict[str, Any]]:
    """The bucket CORS rule that lets guests on ``origin`` read media (docs/host-online-relay.md)."""
    return [
        {
            "AllowedOrigins": [origin],
            "AllowedMethods": ["GET", "HEAD"],
            "AllowedHeaders": ["Range", "*"],
            "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
            "MaxAgeSeconds": 3600,
        }
    ]


def cors_blocked_message(origin: str) -> str:
    return (
        f"Guests will hear nothing from the object store: the bucket has no CORS rule for "
        f"{origin}. Run `podcast relay bucket-setup` to add it, or add this rule to the bucket "
        f"(GET and HEAD, Range header allowed): "
        f"{json.dumps(cors_rule(origin), separators=(',', ':'))}"
    )


def _fetch_headers(url: str, origin: str) -> dict[str, str] | None:
    """GET the first byte of ``url`` with the guest's ``Origin``; ``None`` if unreachable."""
    if urlparse(url).scheme not in {"http", "https"}:
        return None
    req = urllib.request.Request(
        url, headers={"Origin": origin, "Range": "bytes=0-0"}, method="GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=_PROBE_TIMEOUT_SEC) as res:  # nosec B310
            return {k.lower(): v for k, v in res.headers.items()}
    except urllib.error.HTTPError as exc:
        if exc.code >= 500 or exc.code == 429:
            return None  # a gateway or throttle answer says nothing about the bucket's rule
        # Other 4xx answers still carry the CORS headers the browser would judge.
        return {k.lower(): v for k, v in exc.headers.items()}
    except Exception:
        log.debug("object-store CORS probe could not reach the store", exc_info=True)
        return None


def probe_guest_cors(url: str, origin: str, *, fetch: Fetcher | None = None) -> CorsProbe:
    """Ask the store the way a guest's browser does and judge ``Access-Control-Allow-Origin``."""
    headers = (fetch or _fetch_headers)(url, origin)
    if headers is None:
        return CorsProbe("unknown", origin, "object store not reachable from the host")
    allow = (headers.get("access-control-allow-origin") or "").strip()
    if allow in {"*", origin}:
        return CorsProbe("ok", origin)
    detail = "no Access-Control-Allow-Origin header" if not allow else "origin not allowed"
    return CorsProbe("blocked", origin, detail)


_cache: BoundedCache[tuple[str, str], tuple[float, CorsProbe]] = BoundedCache(64)


def cached_guest_cors(
    url: str,
    origin: str,
    *,
    fetch: Fetcher | None = None,
    now: Callable[[], float] = time.monotonic,
) -> CorsProbe:
    """``probe_guest_cors`` memoised per store host and origin so manifests stay cheap."""
    key = (urlparse(url).netloc, origin)
    # One probe at a time: concurrent guests on a cold cache share a single request.
    with _cache.lock:
        t = now()
        hit = _cache.get(key)
        if hit is not None and hit[0] > t:
            return hit[1]
        result = probe_guest_cors(url, origin, fetch=fetch)
        ttl = _OK_TTL_SEC if result.status == "ok" else _FAIL_TTL_SEC
        _cache.put(key, (t + ttl, result))
        return result


__all__ = [
    "CorsProbe",
    "cached_guest_cors",
    "cors_blocked_message",
    "cors_rule",
    "probe_guest_cors",
]
