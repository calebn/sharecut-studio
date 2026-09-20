"""Apply-vs-propose policy for structural timeline document commands.

Host (``caps is None``) and guests with ``edit`` **apply** immediately (undo via
History). Guests with ``suggest`` only **propose** pending decisions for host
approval. View/comment-only shares are denied.
"""

from __future__ import annotations

from enum import StrEnum

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


def structural_mode_from_payload(payload: dict) -> StructuralMutationMode:
    """Read injected ``_structural_mode`` (set by DocumentSyncService.submit)."""
    raw = payload.get("_structural_mode", StructuralMutationMode.APPLY.value)
    try:
        return StructuralMutationMode(str(raw))
    except ValueError as exc:
        raise ValueError(f"invalid _structural_mode: {raw!r}") from exc
