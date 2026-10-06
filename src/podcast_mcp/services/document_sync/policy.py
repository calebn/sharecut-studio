"""Apply-vs-propose policy for structural and selected-range document commands.

Host (``caps is None``) and guests with ``edit`` **apply** immediately (undo via
History) and may approve or reject pending decisions. Guests with ``suggest``
only **propose** pending decisions for review. View/comment-only shares are
denied. A guest's capabilities decide on every surface (DAW, transcript, guest
MCP); only the host's own agents are told apart by surface.
"""

from __future__ import annotations

from enum import StrEnum

from podcast_mcp.edits.edit_reasons import GUEST_SUGGEST_REASON
from podcast_mcp.edits.share_capabilities import CAP_EDIT, CAP_SUGGEST, has_capability

# Structural ops share one command type; policy chooses apply vs propose.
STRUCTURAL_COMMANDS: frozenset[str] = frozenset(
    {
        "SplitAtTime",
        "DeleteClip",
        "RippleDeleteClip",
    }
)

# Commands that can create a pending edit; ``_apply`` stamps the submitter's author.
AUTHORED_COMMANDS: frozenset[str] = frozenset(
    {"SuggestPendingEdit", "EditSelectedRange", *STRUCTURAL_COMMANDS}
)


class StructuralMutationMode(StrEnum):
    APPLY = "apply"
    PROPOSE = "propose"


def resolve_structural_mode(
    caps: list[str] | None,
    requested: str | None = None,
) -> StructuralMutationMode:
    """Return apply/propose for structural commands, or raise PermissionError.

    ``requested == "propose"`` forces PROPOSE when caps allow suggest or edit
    (offline demotion path).
    """
    if requested == StructuralMutationMode.PROPOSE.value:
        if caps is None or has_capability(caps, CAP_EDIT) or has_capability(caps, CAP_SUGGEST):
            return StructuralMutationMode.PROPOSE
        raise PermissionError("share capabilities do not allow structural timeline mutations")
    if caps is None:
        return StructuralMutationMode.APPLY
    if has_capability(caps, CAP_EDIT):
        return StructuralMutationMode.APPLY
    if has_capability(caps, CAP_SUGGEST):
        return StructuralMutationMode.PROPOSE
    raise PermissionError("share capabilities do not allow structural timeline mutations")


def resolve_range_mode(
    caps: list[str] | None,
    range_policy: str,
    requested: str | None = None,
) -> StructuralMutationMode:
    """Apply/propose for ``EditSelectedRange``.

    A guest follows the structural policy on every surface: ``edit`` applies and
    ``suggest`` proposes. The host applies from the interactive DAW
    (``range_policy == "apply"``); the host's own MCP/CLI agents always propose.
    """
    if caps is None and range_policy != "apply":
        return StructuralMutationMode.PROPOSE
    return resolve_structural_mode(caps, requested)


def may_decide_exact_range(caps: list[str] | None, range_policy: str) -> bool:
    """Whether ``ApproveEdits`` / ``RejectEdits`` may decide exact range proposals.

    Approving applies the edit, so the interactive host and ``edit`` guests (any
    surface) may; the host's own MCP/CLI agents may not.
    """
    if caps is None:
        return range_policy == "apply"
    return has_capability(caps, CAP_EDIT)


def authorize_pending_update(
    caps: list[str] | None, author: str | None, edit_author: str | None
) -> None:
    """Raise PermissionError unless *caps* / *author* may retime a pending edit.

    Host and ``edit`` guests retime any pending edit. A ``suggest``-only guest
    retimes only the suggestions its own share made (``edit_author == author``);
    an edit with no author belongs to no guest.
    """
    if caps is None or has_capability(caps, CAP_EDIT):
        return
    if has_capability(caps, CAP_SUGGEST) and author is not None and edit_author == author:
        return
    raise PermissionError("suggest-only shares may retime only their own suggestions")


def range_reason(
    caps: list[str] | None,
    range_policy: str,
    mode: StructuralMutationMode,
) -> str:
    """Reason code stamped on a selected-range decision."""
    if caps is not None:
        return "guest:range" if mode is StructuralMutationMode.APPLY else GUEST_SUGGEST_REASON
    return "host:range" if range_policy == "apply" else "agent:range"


def structural_mode_from_payload(payload: dict) -> StructuralMutationMode:
    """Read injected ``_structural_mode`` (set by DocumentSyncService.submit)."""
    raw = payload.get("_structural_mode", StructuralMutationMode.APPLY.value)
    try:
        return StructuralMutationMode(str(raw))
    except ValueError as exc:
        raise ValueError(f"invalid _structural_mode: {raw!r}") from exc
