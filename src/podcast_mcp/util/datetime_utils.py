"""Shared UTC timestamp formatting for persisted records."""

from datetime import UTC, datetime


def now_iso() -> str:
    """Return the current UTC time in the project's ISO 8601 form."""
    return datetime.now(UTC).isoformat()
