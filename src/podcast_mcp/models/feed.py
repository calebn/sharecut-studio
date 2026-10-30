"""The podcast listing state an episode project stores: pins and minted identity.

Nothing derived is stored. A pin carries the digest of the value it replaced so a
later read can tell that the auto value moved (``podcast_mcp.feed.resolve``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

FieldValue = str | int | float | bool | list[str]
PinAuthor = Literal["person", "agent"]


class Pin(BaseModel):
    value: FieldValue
    # Digest of the auto value at edit time; None when the field had none to compare with.
    basis: str | None = None
    by: PinAuthor = "person"


class FeedSection(BaseModel):
    """``EpisodeProject.feed``: the show link, minted identity and per-episode pins."""

    show_id: str | None = None
    guid: str | None = None
    first_exported_at: str | None = None
    pins: dict[str, Pin] = Field(default_factory=dict)

    def mint_identity(self, now: datetime | None = None) -> bool:
        """Give the episode its guid and first export time once; neither changes after.

        Returns whether anything was written, so a caller saves only then.
        """
        changed = False
        if self.guid is None:
            self.guid = f"urn:uuid:{uuid4()}"
            changed = True
        if self.first_exported_at is None:
            self.first_exported_at = (
                (now or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            )
            changed = True
        return changed
