"""Apply-vs-propose policy for structural and selected-range document commands.

Host (``caps is None``) and guests with ``edit`` **apply** immediately (undo via
History). Guests with ``suggest`` only **propose** pending decisions for host
approval. View/comment-only shares are denied.
"""

from __future__ import annotations

from enum import StrEnum

from podcast_mcp.edits.edit_reasons import GUEST_SUGGEST_REASON, is_guest_suggestion
from podcast_mcp.edits.share_capabilities import CAP_EDIT, CAP_SUGGEST, has_capability

# Structural ops share one command type; policy chooses apply vs propose.
STRUCTURAL_COMMANDS: frozenset[str] = frozenset(
    {
        "SplitAtTime",
        "DeleteClip",
        "RippleDeleteClip",
    }
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

    An interactive DAW (``range_policy == "apply"``) follows the structural policy,
    so a host or ``edit`` guest applies and a ``suggest`` guest proposes. Any other
    caller (MCP agents) always proposes.
    """
    if range_policy != "apply":
        return StructuralMutationMode.PROPOSE
    return resolve_structural_mode(caps, requested)


def authorize_pending_update(caps: list[str] | None, reason: str | None) -> None:
    """Raise PermissionError unless *caps* may retime a pending edit with *reason*.

    Host and ``edit`` guests retime any pending edit. A ``suggest``-only guest
    retimes only guest suggestions; retiming a host or agent edit is editing.
    """
    if caps is None or has_capability(caps, CAP_EDIT):
        return
    if has_capability(caps, CAP_SUGGEST) and is_guest_suggestion(reason):
        return
    raise PermissionError("suggest-only shares may retime only guest suggestions")


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
