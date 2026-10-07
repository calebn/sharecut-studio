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
# A host filesystem path in free text. Folder names routinely hold spaces ("My Show",
# "Application Support", "Caleb Nelson"), so a directory segment may contain them; the file
# name at the end stops at whitespace unless it carries an extension ("Ep 1 raw.wav"). Both
# separators work in every form. When a path's end is ambiguous the match runs long: a
# redaction that eats a few extra words is safe, one that leaves a show name behind is not.
_SEP = r"[\\/]"
# A directory segment: spaces, non-ASCII and an apostrophe inside a word ("Caleb's") are fine.
_DIR = r"(?:[^\\/:*?\"'<>|\r\n\t]|'(?=\w))+"
_FILE = (
    r"(?:[^\\/:*?\"'<>|\r\n\t]*?\.[A-Za-z0-9]{1,5}(?![A-Za-z0-9])"
    r"|[^\s\\/:*?\"'<>|()\[\],;]+)"
)
_TAIL = rf"{_SEP}(?:{_DIR}{_SEP})*{_FILE}"  # one or more segments below a root
_HOME_TAIL = rf"{_SEP}{_DIR}(?:{_TAIL})?"  # an account directory, then anything below it
_SYSTEM_ROOTS = "tmp|var|opt|private|Volumes|mnt|root|srv|etc|usr|Library|Applications|System|data"
_HOST_PATH = re.compile(
    r"(?:"
    # file: URL, with or without spaces and drive letter
    rf"file:/{{1,3}}(?:[A-Za-z]:)?(?:{_SEP}?{_DIR}{_SEP})*{_FILE}"
    # UNC share
    rf"|\\\\[^\s\\/]+{_TAIL}"
    # drive-letter path, with the user's account folder read as one segment
    rf"|(?<![A-Za-z0-9])[A-Za-z]:{_SEP}(?i:users){_HOME_TAIL}"
    rf"|(?<![A-Za-z0-9])[A-Za-z]:{_SEP}(?:{_DIR}{_SEP})*{_FILE}"
    # ~/ and ~user/
    rf"|(?<![\w~])~[\w.-]*{_TAIL}"
    # POSIX home directories, then other well-known roots, then any two-segment path
    rf"|(?<![\w.)\]-])/(?:Users|home){_HOME_TAIL}"
    rf"|(?<![\w.)\]-])/(?:{_SYSTEM_ROOTS})(?![A-Za-z0-9_])(?:{_TAIL})?"
    rf"|(?<![\w/\\:.)\]-])/(?:{_DIR}{_SEP})+{_FILE}"
    r")"
)
HOST_PATH_PLACEHOLDER = "[path]"
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


def redact_secrets(text: str, secrets: Sequence[str] = ()) -> str:
    """Mask known literal secrets and share-token path segments, nothing else.

    Unlike ``sanitize`` this keeps hostnames, IP addresses and paths readable, for
    operator-facing status lines. ``secrets`` are exact values (a host token, share
    tokens) replaced wherever they appear, longest first so one that contains
    another is not left half visible.
    """
    if not text:
        return text
    out = text
    for secret in sorted({s for s in secrets if s}, key=len, reverse=True):
        out = out.replace(secret, "<redacted>")
    out = _AUTH_HEADER.sub(r"\1<redacted>", out)
    out = _SECRET_ASSIGN.sub(lambda m: f"{m.group(1)}=<redacted>", out)
    out = _SHARE_TOKEN.sub(lambda m: f"{m.group('prefix')}<share-token>", out)
    return _HEX_RUN.sub("<hex>", out)


def redact_host_paths(text: str) -> str:
    """Replace each host filesystem path in ``text`` with ``[path]``, without knowing the paths.

    For text bound for share guests (guest progress, guest remote MCP refusals), where
    any host path is too much. Unlike ``sanitize`` it needs no home or workspace and keeps
    everything else as written.
    """
    return _HOST_PATH.sub(HOST_PATH_PLACEHOLDER, text)
