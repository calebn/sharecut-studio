from __future__ import annotations

import pytest

from podcast_mcp.util.text import count_noun


@pytest.mark.parametrize(
    ("n", "expected"),
    [(0, "0 issues"), (1, "1 issue"), (2, "2 issues"), (10, "10 issues")],
)
def test_count_noun(n: int, expected: str) -> None:
    assert count_noun(n, "issue") == expected
