"""Capability constants and helpers for review share tokens."""

from __future__ import annotations

CAP_VIEW = "view"
CAP_PLAY = "play"
CAP_COMMENT = "comment"
CAP_REPLY = "reply"
CAP_ACTION = "action"
CAP_SUGGEST = "suggest"
CAP_EDIT = "edit"
CAP_MCP = "mcp"
CAP_JOIN = "join"
CAP_MONITOR = "monitor"

ALL_CAPABILITIES: list[str] = [
    CAP_VIEW,
    CAP_PLAY,
    CAP_COMMENT,
    CAP_REPLY,
    CAP_ACTION,
    CAP_SUGGEST,
    CAP_EDIT,
    CAP_MCP,
    CAP_JOIN,
    CAP_MONITOR,
]

DEFAULT_CAPABILITIES: list[str] = [
    CAP_PLAY,
    CAP_COMMENT,
    CAP_REPLY,
    CAP_ACTION,
]
VIEWER_CAPABILITIES: list[str] = [
    CAP_PLAY,
    CAP_VIEW,
]
COMMENTER_CAPABILITIES: list[str] = [
    CAP_PLAY,
    CAP_COMMENT,
    CAP_REPLY,
    CAP_ACTION,
]
EDITOR_CAPABILITIES: list[str] = [
    CAP_PLAY,
    CAP_VIEW,
    CAP_COMMENT,
    CAP_REPLY,
    CAP_ACTION,
    CAP_SUGGEST,
    CAP_EDIT,
]

# Docs-like role presets → capability lists (link shares stay login-free).
ROLE_PRESETS: dict[str, list[str]] = {
    "viewer": list(VIEWER_CAPABILITIES),
    "commenter": list(COMMENTER_CAPABILITIES),
    "editor": list(EDITOR_CAPABILITIES),
}

_KNOWN = frozenset(ALL_CAPABILITIES)
_ROLES = frozenset(ROLE_PRESETS)

RECORD_ROLE_GUEST = "guest"
RECORD_ROLE_PRODUCER = "producer"
RECORD_ROLE_PRESETS: dict[str, list[str]] = {
    RECORD_ROLE_GUEST: [CAP_JOIN, CAP_MONITOR, CAP_COMMENT],
    RECORD_ROLE_PRODUCER: [CAP_MONITOR, CAP_COMMENT],
}
_RECORD_ROLES = frozenset(RECORD_ROLE_PRESETS)


def record_capabilities_for_role(role: str) -> list[str]:
    """Expand a record-session role to a capability list."""
    key = str(role or "").strip().lower()
    if key not in _RECORD_ROLES:
        raise ValueError(f"unknown record role {role!r}; expected one of {sorted(_RECORD_ROLES)}")
    return list(RECORD_ROLE_PRESETS[key])


def record_role_for_capabilities(caps: list[str] | None) -> str | None:
    """Return ``guest`` if join is granted, ``producer`` if monitor without join."""
    s = set(caps or [])
    if CAP_JOIN in s:
        return RECORD_ROLE_GUEST
    if CAP_MONITOR in s:
        return RECORD_ROLE_PRODUCER
    return None


def capabilities_for_role(role: str, *, with_mcp: bool = False) -> list[str]:
    """Expand a Docs-like role name to a capability list.

    Raises ``ValueError`` for unknown roles. When *with_mcp* is true, appends
    ``mcp`` if not already present (Editor+agent, etc.).
    """
    key = str(role or "").strip().lower()
    if key not in _ROLES:
        raise ValueError(f"unknown share role {role!r}; expected one of {sorted(_ROLES)}")
    caps = list(ROLE_PRESETS[key])
    if with_mcp and CAP_MCP not in caps:
        caps.append(CAP_MCP)
    return caps


def normalize_capabilities(caps: list[str] | str | None) -> list[str]:
    """Return a deduplicated, validated capability list.

    ``None`` or empty input returns ``DEFAULT_CAPABILITIES`` (commenter-like).
    String input is split on commas. Unknown capability names are silently dropped.
    ``view`` implies ``play`` for streaming.
    """
    if not caps:
        return list(DEFAULT_CAPABILITIES)
    raw = [c.strip() for c in caps.split(",") if c.strip()] if isinstance(caps, str) else list(caps)
    seen: set[str] = set()
    out: list[str] = []
    for c in raw:
        if c in _KNOWN and c not in seen:
            out.append(c)
            seen.add(c)
    if CAP_VIEW in seen and CAP_PLAY not in seen:
        out.insert(0, CAP_PLAY)
    return out if out else list(DEFAULT_CAPABILITIES)


def resolve_share_capabilities(
    *,
    role: str | None = None,
    capabilities: list[str] | str | None = None,
    with_mcp: bool = False,
    kind: str = "review",
) -> list[str]:
    """Resolve CLI/MCP inputs: role preset wins when set; else raw capabilities."""
    if kind == "record":
        if not role:
            raise ValueError("record shares require --role guest or producer")
        return record_capabilities_for_role(role)
    if kind != "review":
        raise ValueError(f"unknown share kind {kind!r}")
    if role:
        return normalize_capabilities(capabilities_for_role(role, with_mcp=with_mcp))
    caps = normalize_capabilities(capabilities)
    if with_mcp and CAP_MCP not in caps:
        caps = [*caps, CAP_MCP]
    return caps


def has_capability(caps: list[str] | None, cap: str) -> bool:
    """Return True if *cap* is granted (with view→play and comment→reply aliases)."""
    s = set(caps or [])
    if cap == CAP_PLAY and CAP_VIEW in s:
        return True
    if cap == CAP_REPLY and CAP_COMMENT in s:
        return True
    return cap in s


def guest_mode(caps: list[str] | None) -> str:
    """Return the highest-privilege guest mode implied by a capability list.

    Hierarchy: ``edit`` > ``suggest`` > ``comment`` / ``reply`` / ``action`` > ``view``.
    """
    c = caps or []
    if CAP_EDIT in c:
        return "edit"
    if CAP_SUGGEST in c:
        return "suggest"
    if CAP_COMMENT in c or CAP_REPLY in c or CAP_ACTION in c:
        return "comment"
    if CAP_PLAY in c or CAP_VIEW in c:
        return "view"
    return "none"


def docs_role_for_capabilities(caps: list[str] | None) -> str:
    """Best-effort Docs-like role label for a capability list (for UI/docs)."""
    mode = guest_mode(caps)
    if mode == "edit":
        return "editor"
    if mode == "suggest":
        return "editor"
    if mode == "comment":
        return "commenter"
    if mode == "view":
        return "viewer"
    return "none"
