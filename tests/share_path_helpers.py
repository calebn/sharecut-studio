"""Share-route paths with dot segments and doubled slashes, in the spellings a log can hold."""

from __future__ import annotations

SHAPES = (
    "/r/./T",
    "/r/../T",
    "/rec/./T",
    "/rec/../T",
    "/api/review/./T",
    "/api/review/../T",
    "/api/rec/./T",
    "/api/rec/../T",
    "/api/./review/T/daw/meta",
    "/api//review//T/daw/meta",
)
SPELLINGS = ("plain", "lower-percent-dot", "upper-percent-dot", "percent-slash", "mixed")


def spell(shape: str, name: str, token: str) -> str:
    lower = shape.replace("..", "%2e%2e").replace("/./", "/%2e/")
    spelled = {
        "plain": shape,
        "lower-percent-dot": lower,
        "upper-percent-dot": lower.replace("%2e", "%2E"),
        "percent-slash": shape.replace("/", "%2F"),
        "mixed": lower.replace("/", "%2F", 1),
    }[name]
    return spelled.replace("T", token)
