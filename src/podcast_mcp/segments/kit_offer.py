"""Whether an episode should be offered the show kit, and which kits it can offer. No I/O."""

from __future__ import annotations

from typing import Any

from podcast_mcp.segments.kit import KitListing
from podcast_mcp.segments.kit_summary import MissingEntry


def offer_report(
    has_clips: bool,
    has_segment_refs: bool,
    listing: KitListing,
    missing_by_kit: dict[str, list[MissingEntry]],
    resolved_by_kit: dict[str, list[int]],
) -> dict[str, Any]:
    """First matching rule gives the reason; damaged kits are ignored."""
    kits: list[dict[str, Any]] = []
    unusable: list[dict[str, Any]] = []
    if not has_clips:
        reason = "no_clips"
    elif has_segment_refs:
        reason = "already_has_segments"
    elif not listing.kits:
        reason = "no_kits"
    else:
        for kit in sorted(listing.kits, key=lambda k: (k.name, k.id)):
            failing = missing_by_kit.get(kit.id, [])
            if failing:
                unusable.append(
                    {
                        "id": kit.id,
                        "name": kit.name,
                        "version": kit.version,
                        "missing": len(failing),
                        "problem": failing[0].problem,
                    }
                )
                continue
            kits.append(
                {
                    "id": kit.id,
                    "name": kit.name,
                    "version": kit.version,
                    "entries": [
                        {
                            "segment_id": entry.segment_id,
                            "version": version,
                            "at": entry.at,
                            "note": entry.note,
                        }
                        for entry, version in zip(kit.entries, resolved_by_kit[kit.id], strict=True)
                    ],
                }
            )
        reason = "offer" if kits else "no_usable_kits"
    return {"offer": reason == "offer", "reason": reason, "kits": kits, "unusable": unusable}
