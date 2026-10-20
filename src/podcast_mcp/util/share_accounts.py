"""Feature flag for unfinished guest accounts / Restricted shares.

Production defaults fail closed: no ``/auth`` mount and no minting of
``restricted`` / ``require_sign_in`` shares. Set ``PODCAST_SHARE_ACCOUNTS=1``
only for stub tests and future account UI work.
"""

from __future__ import annotations

from podcast_mcp import settings

_ROADMAP_HINT = (
    "Restricted / require_sign_in shares are not production yet "
    "(see ROADMAP.md: Guest sign-in / account UI). "
    "Use a link share, or set PODCAST_SHARE_ACCOUNTS=1 for local stub testing."
)


def share_accounts_enabled() -> bool:
    return settings.flag("PODCAST_SHARE_ACCOUNTS")


def require_share_accounts_for_restricted(
    *,
    general_access: str,
    require_sign_in: bool,
) -> None:
    """Raise ValueError when minting Restricted identity without the escape hatch."""
    if share_accounts_enabled():
        return
    ga = (general_access or "link").strip().lower()
    if ga == "restricted" or require_sign_in:
        raise ValueError(_ROADMAP_HINT)
