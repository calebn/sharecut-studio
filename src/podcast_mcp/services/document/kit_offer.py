"""Whether an episode should be offered the show kit; read-only, nothing is journaled."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from podcast_mcp.segments.kit import KitStore
from podcast_mcp.segments.kit_offer import offer_report
from podcast_mcp.segments.kit_summary import MissingEntry, failing_entries
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.document.read_only_open import open_read_only


def report_kit_offer(
    project_path: Path | str, kit_store: KitStore, segment_store: SegmentStore
) -> dict[str, Any]:
    """Whether to offer the show kit to this episode, and the kits it can offer.

    A kit is offered when each entry's segment version passes the cheap read. Audio is not
    hashed, so ``kit apply`` can still refuse a same-size change.
    """
    workspace = open_read_only(project_path)
    clips = workspace.project.clips
    has_refs = any(clip.segment_ref is not None for clip in clips)
    listing = kit_store.scan()
    missing_by_kit: dict[str, list[MissingEntry]] = {}
    resolved_by_kit: dict[str, list[int]] = {}
    if clips and not has_refs:
        for kit in listing.kits:
            failing, versions = failing_entries(kit, segment_store)
            if failing:
                missing_by_kit[kit.id] = failing
            else:
                resolved_by_kit[kit.id] = versions
    return offer_report(bool(clips), has_refs, listing, missing_by_kit, resolved_by_kit)
