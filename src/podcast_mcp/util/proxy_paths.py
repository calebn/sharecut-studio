"""Sanitize relay→host proxy paths (block traversal to host-only APIs)."""

from __future__ import annotations

import posixpath
from urllib.parse import unquote


class UnsafeProxyPath(ValueError):
    """Raised when a proxied path is unsafe or not allowlisted."""


def proxy_path_is_safe(path_suffix: str) -> bool:
    """Return False if ``path_suffix`` contains traversal or backslash forms."""
    # Relay suffixes are relative (r/..., api/review/..., mcp/...).
    if not path_suffix or path_suffix.startswith("/"):
        return False
    candidates = [path_suffix, unquote(path_suffix)]
    for c in candidates:
        if "\\" in c:
            return False
        lower = c.lower()
        if ".." in c or "%2e%2e" in lower or "%2e." in lower or ".%2e" in lower:
            return False
        if any(ord(ch) < 32 for ch in c):
            return False
    return True


def assert_safe_proxy_path(path_suffix: str) -> None:
    if not proxy_path_is_safe(path_suffix):
        raise UnsafeProxyPath(f"unsafe proxy path: {path_suffix!r}")


def is_allowed_local_gui_path(local_path: str, share_token: str) -> bool:
    """True if a mapped local GUI path stays under guest-allowed prefixes."""
    path = local_path.split("?", 1)[0]
    if not path.startswith("/"):
        path = "/" + path
    normalized = posixpath.normpath(path)
    # After leading-slash normalization, path is absolute; keep guard for safety.
    if normalized != "/" and not normalized.startswith("/"):  # pragma: no cover
        return False
    parts = normalized.split("/")
    if ".." in parts:  # pragma: no cover
        return False

    if normalized in {"/favicon.svg", "/favicon.ico"}:
        return True
    if normalized == "/assets" or normalized.startswith("/assets/"):
        return True

    token = (share_token or "").strip()
    if not token:
        return False

    r_prefix = f"/r/{token}"
    if normalized == r_prefix or normalized.startswith(r_prefix + "/"):
        return True
    rec_prefix = f"/rec/{token}"
    if normalized == rec_prefix or normalized.startswith(rec_prefix + "/"):
        return True
    rec_api = f"/api/rec/{token}"
    if normalized == rec_api or normalized.startswith(rec_api + "/"):
        return True
    review = f"/api/review/{token}"
    if normalized == review or normalized.startswith(review + "/"):
        return True
    mcp = f"/mcp/{token}"
    return bool(normalized == mcp or normalized.startswith(mcp + "/"))


def assert_allowed_local_gui_path(local_path: str, share_token: str) -> str:
    """Normalize and return ``local_path`` or raise ``UnsafeProxyPath``."""
    path = local_path.split("?", 1)[0]
    if not path.startswith("/"):
        path = "/" + path
    normalized = posixpath.normpath(path)
    if not is_allowed_local_gui_path(normalized, share_token):
        raise UnsafeProxyPath(f"path not allowlisted: {normalized!r}")
    return normalized
