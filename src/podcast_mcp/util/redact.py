"""Sanitize diagnostics text: paths, tokens, headers, emails, and IPs."""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path
from urllib.parse import unquote

from podcast_mcp.util.host_session_wire import EXCHANGE_PARAM, EXCHANGE_PATH, SESSION_COOKIE

_SLASH = r"(?:/|%(?:25)?2[Ff])"
_DOT = r"(?:\.|%(?:25)?2[Ee])"
_SEP_WITH_DOTS = rf"(?:{_SLASH}(?:{_DOT}{{1,2}}{_SLASH})*)+"
_SHARE_PATH_ROOTS = (
    "r",
    "rec",
    "api/review",
    "mcp",
    "api/shares",
    "api/shares/record",
)
_SHARE_ROOTS = "|".join(root.replace("/", _SEP_WITH_DOTS) for root in _SHARE_PATH_ROOTS)
_SHARE_TOKEN = re.compile(
    rf"(?P<prefix>{_SLASH}(?i:{_SHARE_ROOTS}){_SEP_WITH_DOTS})"
    r"(?P<token>[A-Za-z0-9_-]{8,}(?:-[A-Za-z0-9_-]+)*)"
)
_BOOT_TOKEN = re.compile(
    r"(?i)(x-sharecut-boot-token)(\s*[:=]\s*)(\S+)",
)
_AUTH_HEADER = re.compile(r"(?i)(authorization\s*:\s*)(\S.+)")
_COOKIE_HEADER = re.compile(r"(?i)(cookie\s*:\s*)(.+)")
_SECRET_ASSIGN = re.compile(
    r"(?i)(secret|password|api[_-]?key|token)=(\S+)",
)
_HOST_SESSION = re.compile(
    rf"({re.escape(SESSION_COOKIE)}=|{re.escape(EXCHANGE_PATH)}\?{EXCHANGE_PARAM}=)([^\s;&]+)"
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
_HOST_PATH = re.compile(
    r"[A-Za-z]:[\\/]"
    r"|\\"
    r"|[\\/](?i:Users|home)"
    r"|~[\w.-]*[\\/]"
    r"|/"
    r"|(?i:%2f|%5c)"
)
# pydantic prints the offending value of a failed field as ``input_value=<repr>, input_type=<type>``
# on one line; the repr is the document's own data and may hold ``, input_type=`` itself, so it
# runs to the last one on the line (or to the end of the line when there is none).
_INPUT_VALUE = re.compile(r"input_value=(?:[^\r\n]*(?=, input_type=)|[^\r\n]*)")
_INPUT_VALUE_HIDDEN = "input_value=<hidden>"
# Where a validation failed is printed as dotted segments, and a segment may be a dict key of
# the document (a speaker's name). Two shapes carry it. Pydantic's block is a header
# ``N validation error(s) for <title>`` (anywhere in a line, then the line's end; the title is
# a class name, so over 500 characters it is not a header) and then AT MOST N entries; one entry
# is ONE location line (up to 2000 characters), a line of two spaces that ends its message with
# ``[type=...]``, and optionally a ``    For further information`` line. Where the next line is
# not such an entry the block ends and everything after is left byte for byte (a line that only
# says "3 validation errors for the upload" is no block). Only a matched entry's location line
# is rewritten. A key that itself holds a line break is outside this rule (the episode file's own
# keys never get this far: ``load_project`` masks them at the source). The other shape is the
# sentence older builds wrote for a damaged project file.
_VALIDATION_HEADER = re.compile(r"(?<!\d)(\d{1,6}) validation errors? for [^\r\n]{0,500}\r?\n")
_LOCATION_MAX = 2000
_FURTHER_INFO = "    For further information"
_UNREADABLE_PLACE = re.compile(
    r"(?P<head>\(unexpected contents at )"
    r"(?P<loc>(?s:.{0,2000}?)(?=\)\. Restore it from a backup)|[^\n]*)"
)
_LOOPBACK_V4 = re.compile(r"^127\.")
_LOOPBACK_V6 = frozenset({"::1", "0:0:0:0:0:0:0:1"})


def _mask_location(location: str, names: frozenset[str] | None) -> str:
    """``location`` with every segment that is not a number or a known field name as ``*``."""
    kept = names or frozenset()
    return ".".join(
        seg if seg == "*" or (seg.isdecimal() and seg.isascii()) or seg in kept else "*"
        for seg in location.split(".")
    )


def _entry_at(text: str, at: int) -> tuple[int, int] | None:
    """The end of the location line and of the entry that starts at ``at``, or ``None``."""
    nl = text.find("\n", at, at + _LOCATION_MAX + 2)
    if nl == -1:
        return None
    loc_end = nl - 1 if nl > at and text[nl - 1] == "\r" else nl
    if loc_end - at > _LOCATION_MAX or not text.startswith("  ", nl + 1):
        return None
    msg_nl = text.find("\n", nl + 1)
    msg_end = len(text) if msg_nl == -1 else msg_nl
    message = text[nl + 1 : msg_end].removesuffix("\r")
    if not message.endswith("]") or "[type=" not in message:
        return None
    end = msg_end
    if msg_nl != -1 and text.startswith(_FURTHER_INFO, msg_nl + 1):
        info_nl = text.find("\n", msg_nl + 1)
        end = len(text) if info_nl == -1 else info_nl
    return loc_end, end


def _mask_validation_locations(text: str, names: frozenset[str] | None) -> str:
    if "validation error" in text:
        pieces: list[str] = []
        pos = 0
        for header in _VALIDATION_HEADER.finditer(text):
            if header.start() < pos:
                continue
            at = header.end()
            for _ in range(int(header.group(1))):
                entry = _entry_at(text, at)
                if entry is None:
                    break
                loc_end, end = entry
                pieces.append(text[pos:at])
                pieces.append(_mask_location(text[at:loc_end], names) if loc_end > at else "")
                pieces.append(text[loc_end:end])
                pos = end
                at = end + 1
        pieces.append(text[pos:])
        text = "".join(pieces)
    if "(unexpected contents at " in text:
        text = _UNREADABLE_PLACE.sub(
            lambda m: m.group("head") + _mask_location(m.group("loc"), names), text
        )
    return text


def _path_forms(path: Path) -> list[str]:
    raw = str(path)
    forms = {raw, raw.replace("\\", "/"), raw.replace("/", "\\")}
    try:
        resolved = str(path.expanduser().resolve())
    except OSError:
        resolved = raw
    forms.update({resolved, resolved.replace("\\", "/"), resolved.replace("/", "\\")})
    return sorted((f for f in forms if f), key=len, reverse=True)


def _encoded_form(form: str) -> re.Pattern[str]:
    """Match ``form`` as a browser or server writes it in a URL: any character of it may be
    percent-encoded (UTF-8 bytes, hex in either case), and a space may be ``+``."""
    parts: list[str] = []
    for char in form:
        spellings = [re.escape(char)]
        escaped = "".join(f"%(?i:{byte:02x})" for byte in char.encode("utf-8"))
        spellings.append(escaped)
        if char == " ":
            spellings.append(r"\+")
        parts.append("(?:" + "|".join(spellings) + ")")
    return re.compile("".join(parts))


def _replace_path(text: str, path: Path, token: str) -> str:
    forms = _path_forms(path)
    for form in forms:
        if form and form in text:
            text = text.replace(form, token)
    if "%" in text or "+" in text:
        for form in forms:
            if form:
                text = _encoded_form(form).sub(lambda _m: token, text)
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


def redact_share_paths(text: str) -> str:
    """Replace the link token in every share route path in ``text``, plain or percent-encoded.

    The roots match in any letter case: the server answers ``/R/<token>`` with a 404, but
    uvicorn still logs the path.

    The routes are the guest ``/r/``, ``/rec/``, ``/api/review/`` and ``/mcp/`` roots (so
    ``/api/rec/`` too, through ``/rec/``) and the host ``/api/shares/<token>/revoke|restore`` and
    ``/api/shares/record/<token>/replace`` paths.
    A ``.`` or ``..`` segment (also ``%2e``) or a doubled separator before the token is skipped,
    so ``/r/../<token>`` and ``/api//review//<token>`` are masked; a walk-out through a named
    segment such as ``/r/x/../<token>`` is not.
    ``tests/test_share_path_routes.py`` fails when a mounted route puts a token somewhere else.
    """
    return _SHARE_TOKEN.sub(lambda m: f"{m.group('prefix')}<share-token>", text)


def sanitize(
    text: str,
    *,
    home: Path | None = None,
    workspace: Path | None = None,
    extra: Sequence[tuple[Path, str]] | None = None,
    field_names: frozenset[str] | None = None,
) -> str:
    """Return ``text`` with host paths and secrets replaced by placeholders.

    A validation error's location keeps its numbers and the ``field_names`` (the names the
    models declare); any other segment is a key of the document and becomes ``*``.

    Share routes go through ``redact_share_paths``. Bare coolnames in free text are not
    matched here: the diagnostics bundle masks the registry's tokens by value on top
    (``docs/setup.md``). ``token=`` values are covered by the secret-assignment rule.
    """
    if not text:
        return text
    out = _INPUT_VALUE.sub(_INPUT_VALUE_HIDDEN, text)
    out = _mask_validation_locations(out, field_names)
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
    out = _HOST_SESSION.sub(r"\1<redacted>", out)
    out = redact_share_paths(out)
    out = _EMAIL.sub("<email>", out)
    out = _IPV4.sub(_sub_ipv4, out)
    out = _IPV6.sub(_sub_ipv6, out)
    out = _B64_RUN.sub("<b64>", out)
    out = _HEX_RUN.sub("<hex>", out)
    return out


def _mask_values(text: str, secrets: Sequence[str], min_prefix: int | None) -> str:
    spans: list[tuple[int, int]] = []
    for secret in {s for s in secrets if s}:
        if min_prefix is not None and len(secret) > min_prefix:
            tail = "".join(f"(?:{re.escape(ch)}" for ch in secret[min_prefix:]) + ")?" * (
                len(secret) - min_prefix
            )
            pattern = re.escape(secret[:min_prefix]) + tail
        else:
            pattern = re.escape(secret)
        spans.extend(m.span() for m in re.finditer(pattern, text))
    pieces: list[str] = []
    pos = 0
    run_start = run_end = -1
    for start, end in sorted(spans):
        if start <= run_end:
            run_end = max(run_end, end)
            continue
        if run_start >= 0:
            pieces += (text[pos:run_start], "<redacted>")
            pos = run_end
        run_start, run_end = start, end
    if run_start >= 0:
        pieces += (text[pos:run_start], "<redacted>")
        pos = run_end
    pieces.append(text[pos:])
    return "".join(pieces)


def redact_secrets(text: str, secrets: Sequence[str] = (), *, min_prefix: int | None = None) -> str:
    """Mask known literal secrets and share-token path segments, nothing else.

    Unlike ``sanitize`` this keeps hostnames, IP addresses and paths readable, for
    operator-facing status lines. ``secrets`` are exact values (a host token, share
    tokens) replaced wherever they appear, overlapping matches merged into one so no
    secret is left half visible. With ``min_prefix`` a leading run of a secret at
    least that long is masked too, and text that holds a secret only once percent-decoded
    is returned decoded and masked.
    """
    if not text:
        return text
    out = _mask_values(text, secrets, min_prefix)
    decoded = unquote(out)
    decoded_masked = _mask_values(decoded, secrets, min_prefix)
    if decoded_masked != decoded:
        out = decoded_masked
    out = _AUTH_HEADER.sub(r"\1<redacted>", out)
    out = _SECRET_ASSIGN.sub(lambda m: f"{m.group(1)}=<redacted>", out)
    out = _HOST_SESSION.sub(r"\1<redacted>", out)
    out = redact_share_paths(out)
    return _HEX_RUN.sub("<hex>", out)


def mentions_host_path(text: str) -> bool:
    """Whether ``text`` contains a possible host path prefix.

    The guest boundary uses it to withhold text, never to scrub it: a path's end is ambiguous
    in prose (``Talkin' Shop`` ends at an apostrophe), so replacing the part that matched leaves
    folder-name fragments behind. Text bound for a share guest either has no path or is replaced
    whole (``CodedError.guest_message``, ``scrub_guest_progress_text``).
    Detection conservatively matches slash- or backslash-separated prose and URLs. Bare
    filenames without a path prefix remain allowed.
    """
    return _HOST_PATH.search(text) is not None
