"""Capability constants and helpers for review share tokens."""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Any

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


class ReviewRole(StrEnum):
    """Review-link roles, as in Google Docs (communication philosophy § Terminology)."""

    VIEWER = "viewer"
    COMMENTER = "commenter"
    EDITOR = "editor"


# The one role table (#1050). Each role holds the previous role's capabilities and
# more: a Commenter comments and suggests, and suggestions wait for an Editor or
# the host. Every gate (document commands, guest MCP tools, guest mode) derives
# from it.
REVIEW_ROLE_CAPABILITIES: Mapping[ReviewRole, tuple[str, ...]] = {
    ReviewRole.VIEWER: (CAP_PLAY, CAP_VIEW),
    ReviewRole.COMMENTER: (
        CAP_PLAY,
        CAP_VIEW,
        CAP_COMMENT,
        CAP_REPLY,
        CAP_ACTION,
        CAP_SUGGEST,
    ),
    ReviewRole.EDITOR: (
        CAP_PLAY,
        CAP_VIEW,
        CAP_COMMENT,
        CAP_REPLY,
        CAP_ACTION,
        CAP_SUGGEST,
        CAP_EDIT,
    ),
}

# A share minted without naming capabilities is a Commenter link.
DEFAULT_CAPABILITIES: list[str] = list(REVIEW_ROLE_CAPABILITIES[ReviewRole.COMMENTER])

_KNOWN = frozenset(ALL_CAPABILITIES)

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
    """Expand a review-link role name to its capability list.

    Raises ``ValueError`` for unknown roles. When *with_mcp* is true, appends
    ``mcp`` (the opt-in MCP URL is orthogonal to the role).
    """
    try:
        key = ReviewRole(str(role or "").strip().lower())
    except ValueError:
        raise ValueError(
            f"unknown share role {role!r}; expected one of {[r.value for r in ReviewRole]}"
        ) from None
    caps = list(REVIEW_ROLE_CAPABILITIES[key])
    if with_mcp:
        caps.append(CAP_MCP)
    return caps


def review_role_for_capabilities(caps: list[str] | None) -> ReviewRole | None:
    """The highest review role whose whole capability set *caps* holds, else ``None``.

    ``mcp`` plays no part. A set that holds no role in full (a listen-only link
    without ``view``, a record link) has no review role.
    """
    for role in reversed(ReviewRole):
        if all(has_capability(caps, cap) for cap in REVIEW_ROLE_CAPABILITIES[role]):
            return role
    return None


def normalize_capabilities(caps: list[str] | str | None) -> list[str]:
    """Return a deduplicated, validated capability list.

    ``None`` or empty input returns ``DEFAULT_CAPABILITIES`` (a Commenter link).
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


def has_capability(caps: list[str] | None, cap: str) -> bool:
    """Return True if *cap* is granted (with view→play and comment→reply aliases)."""
    s = set(caps or [])
    if cap == CAP_PLAY and CAP_VIEW in s:
        return True
    if cap == CAP_REPLY and CAP_COMMENT in s:
        return True
    return cap in s


_ROLE_GUEST_MODE: Mapping[ReviewRole, str] = {
    ReviewRole.VIEWER: "view",
    ReviewRole.COMMENTER: "comment",
    ReviewRole.EDITOR: "edit",
}


def guest_mode(caps: list[str] | None) -> str:
    """Guest UI mode: ``edit``, ``comment`` or ``view`` from the review role.

    A link with no review role (no ``view``) opens the listen page: ``comment``
    when it may comment, ``view`` when it may only play, else ``none``.
    """
    role = review_role_for_capabilities(caps)
    if role is not None:
        return _ROLE_GUEST_MODE[role]
    if any(has_capability(caps, cap) for cap in (CAP_COMMENT, CAP_REPLY, CAP_ACTION)):
        return "comment"
    if has_capability(caps, CAP_PLAY):
        return "view"
    return "none"


def share_author(share: Mapping[str, Any]) -> str:
    """``EditDecision.author`` for a share guest: ``share:`` plus the share's registry id.

    The id is minted at random when the share is created, so it reveals nothing
    about the token, and a coolname recycled from cooldown gets a new one. A
    share without an id cannot author edits.
    """
    share_id = share.get("id")
    if not share_id:
        raise KeyError("invalid or revoked share token")
    return f"share:{share_id}"
