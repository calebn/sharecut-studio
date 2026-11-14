"""``redact_share_paths`` knows every mounted route that puts a link token in its path."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path

import pytest

from podcast_mcp.util.redact import redact_share_paths

INVENTORY = Path(__file__).resolve().parents[1] / "contracts" / "route-inventory.json"
TOKEN_PARAMETER = re.compile(r"\{[^}:]*token[^}:]*\}")
TOKEN = "velvet-quokka-umbra"


def _token_routes() -> list[str]:
    routes = json.loads(INVENTORY.read_text(encoding="utf-8"))["routes"]
    return sorted({row["path"] for row in routes if TOKEN_PARAMETER.search(row["path"])})


def test_the_inventory_has_token_routes() -> None:
    assert len(_token_routes()) > 50


def test_no_mounted_route_puts_a_token_where_the_redactor_cannot_see_it() -> None:
    uncovered = [
        path
        for path in _token_routes()
        if TOKEN in redact_share_paths(TOKEN_PARAMETER.sub(TOKEN, path))
    ]

    assert uncovered == [], "add the route's prefix to util/redact.py _SHARE_PATH_ROOTS"


@pytest.mark.parametrize("fold", [str.upper, str.title])
def test_every_token_route_is_covered_in_upper_and_mixed_case(fold: Callable[[str], str]) -> None:
    uncovered = [
        path
        for path in _token_routes()
        if TOKEN
        in redact_share_paths(TOKEN.join(fold(part) for part in TOKEN_PARAMETER.split(path)))
    ]

    assert uncovered == []
