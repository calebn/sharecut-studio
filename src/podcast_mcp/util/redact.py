"""Sanitize diagnostics text: paths, tokens, headers, emails, and IPs."""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path

_SHARE_TOKEN = re.compile(
    r"(?P<prefix>/r/|/rec/|/api/review/|/mcp/)(?P<token>[A-Za-z0-9_-]{8,}(?:-[A-Za-z0-9_-]+)*)"
)
_BOOT_TOKEN = re.compile(
    r"(?i)(x-sharecut-boot-token)(\s*[:=]\s*)(\S+)",
)
_AUTH_HEADER = re.compile(r"(?i)(authorization\s*:\s*)(\S.+)")
_COOKIE_HEADER = re.compile(r"(?i)(cookie\s*:\s*)(.+)")
_SECRET_ASSIGN = re.compile(
    r"(?i)(secret|password|api[_-]?key|token)=(\S+)",
)
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_IPV4 = re.compile(
    r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})\b"
)
_IPV6 = re.compile(
    r"\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b"
    r"|\b:(?::[0-9a-fA-F]{1,4}){1,7}\b"
    r"|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b"
)
_HEX_RUN = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])")
_B64_RUN = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={1,2}(?![A-Za-z0-9+/=])")
_LOOPBACK_V4 = re.compile(r"^127\.")
_LOOPBACK_V6 = frozenset({"::1", "0:0:0:0:0:0:0:1"})


def _path_forms(path: Path) -> list[str]:
    raw = str(path)
    forms = {raw, raw.replace("\\", "/"), raw.replace("/", "\\")}
    try:
        resolved = str(path.expanduser().resolve())
    except OSError:
        resolved = raw
    forms.update({resolved, resolved.replace("\\", "/"), resolved.replace("/", "\\")})
    return sorted((f for f in forms if f), key=len, reverse=True)


def _replace_path(text: str, path: Path, token: str) -> str:
    for form in _path_forms(path):
        if form and form in text:
            text = text.replace(form, token)
    return text


def _sub_ipv4(match: re.Match[str]) -> str:
    ip = match.group(0)
    if _LOOPBACK_V4.match(ip):
        return ip
    return "<ip>"


def _sub_ipv6(match: re.Match[str]) -> str:
    ip = match.group(0)
    if ip.lower() in _LOOPBACK_V6 or ip == "::1":
        return ip
    return "<ip>"


def sanitize(
    text: str,
    *,
    home: Path | None = None,
    workspace: Path | None = None,
    extra: Sequence[tuple[Path, str]] | None = None,
) -> str:
    """Return ``text`` with host paths and secrets replaced by placeholders.

    Share URLs redact the path segment after ``/r/``, ``/rec/``,
    ``/api/review/``, or ``/mcp/`` (coolname, including four-word slugs). Bare coolnames in free text are not matched
    (see ``docs/setup.md``). ``token=`` values are covered by the
    secret-assignment rule.
    """
    if not text:
        return text
    out = text
    extras = sorted(extra or (), key=lambda pair: len(str(pair[0])), reverse=True)
    for path, token in extras:
        out = _replace_path(out, path, token)
    if workspace is not None:
        out = _replace_path(out, workspace, "<workspace>")
    home_path = home if home is not None else Path.home()
    out = _replace_path(out, home_path, "~")

    out = _BOOT_TOKEN.sub(r"\1\2<redacted>", out)
    out = _AUTH_HEADER.sub(r"\1<redacted>", out)
    out = _COOKIE_HEADER.sub(r"\1<redacted>", out)
    out = _SECRET_ASSIGN.sub(lambda m: f"{m.group(1)}=<redacted>", out)
    out = _SHARE_TOKEN.sub(lambda m: f"{m.group('prefix')}<share-token>", out)
    out = _EMAIL.sub("<email>", out)
    out = _IPV4.sub(_sub_ipv4, out)
    out = _IPV6.sub(_sub_ipv6, out)
    out = _B64_RUN.sub("<b64>", out)
    out = _HEX_RUN.sub("<hex>", out)
    return out
