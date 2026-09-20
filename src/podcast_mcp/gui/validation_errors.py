"""Safe, user-facing formatting for FastAPI request validation failures."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

_INVALID_REQUEST = "Invalid request. Please refresh and try again."
_REQUEST_LOCATIONS = frozenset({"body", "query", "path", "header", "cookie"})


def format_validation_errors(errors: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Return a stable 422 payload without exposing Pydantic implementation detail.

    FastAPI's default error ``ctx`` for discriminated unions includes every accepted
    tag, which is both unhelpful in the UI and needlessly exposes the command set.
    Keep the documented list-shaped ``detail`` field while replacing each item with
    the small, safe subset clients need to identify its field.
    """
    detail = [_sanitize_error(error) for error in errors]
    message = detail[0]["msg"] if detail else _INVALID_REQUEST
    return {"message": message, "detail": detail}


def _sanitize_error(error: Mapping[str, Any]) -> dict[str, Any]:
    loc = _location(error.get("loc"))
    return {
        "loc": loc,
        "msg": _friendly_message(error, loc),
        "type": "invalid_request",
    }


def _location(value: object) -> list[str | int]:
    """Normalize Pydantic's tuple locations to the documented JSON-array shape."""
    if not isinstance(value, (tuple, list)):
        return []
    return [part for part in value if isinstance(part, (str, int))]


def _friendly_message(error: Mapping[str, Any], loc: Sequence[str | int]) -> str:
    error_type = error.get("type")
    field = _field_name(loc)
    if error_type == "union_tag_invalid":
        tag = _invalid_tag(error)
        return f"Unknown command type {tag!r}. Please refresh and try again."
    if error_type == "union_tag_not_found":
        return "Missing required field 'type'."
    if error_type == "missing":
        return f"Missing required field {field!r}." if field else _INVALID_REQUEST
    return f"Invalid value for {field!r}." if field else _INVALID_REQUEST


def _invalid_tag(error: Mapping[str, Any]) -> str:
    context = error.get("ctx")
    if not isinstance(context, Mapping):
        return "unknown"
    tag = context.get("tag")
    return tag if isinstance(tag, str) and tag else "unknown"


def _field_name(loc: Sequence[str | int]) -> str:
    """Extract a human-facing field path without request transport prefixes."""
    fields = [str(part) for part in loc if part not in _REQUEST_LOCATIONS]
    return fields[-1] if fields else ""
