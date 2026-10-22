"""A model the action needs is not installed: one refusal every surface words the same way.

Raised by ``engines.models.registry.require_model`` at the entry of an action. The message
names the model, its size and the command that installs it, and is built only from those
fields, never from a hint, so it carries no host path. This is a leaf module (no registry
import) so the engines can raise and catch it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from podcast_mcp.util.coded_error import CodedError


class ModelMissing(CodedError, RuntimeError):
    """A model is not downloaded (``missing``) or does not match its pin (``update_needed``)."""

    code = "model_needed"

    def __init__(
        self,
        *,
        id: str,
        model: str,
        label: str,
        purpose: str,
        size: str,
        size_bytes: int | None,
        command: str,
        state: str,
    ) -> None:
        self.id = id
        self.model = model
        self.label = label
        self.purpose = purpose
        self.size = size
        self.size_bytes = size_bytes
        self.command = command
        self.state = state
        super().__init__(f"needs {label} ({size}); run `{command}`")

    @classmethod
    def from_record(cls, rec: Mapping[str, Any]) -> ModelMissing:
        return cls(
            id=rec["id"],
            model=rec["model"],
            label=rec["label"],
            purpose=rec["purpose"],
            size=rec["size"],
            size_bytes=rec["size_bytes"],
            command=rec["bootstrap"],
            state=rec["state"],
        )

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "model": self.model,
            "label": self.label,
            "purpose": self.purpose,
            "size": self.size,
            "size_bytes": self.size_bytes,
            "command": self.command,
            "state": self.state,
        }
