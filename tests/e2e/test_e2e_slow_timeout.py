from __future__ import annotations

import pytest

from .conftest import E2E_SLOW_TIMEOUT_SEC, apply_e2e_slow_timeout


class _FakeItem:
    """Just enough of ``pytest.Item`` for ``apply_e2e_slow_timeout``."""

    def __init__(self, markers: list[pytest.Mark]) -> None:
        self._markers = list(markers)
        self.added: list[pytest.Mark] = []

    def get_closest_marker(self, name: str) -> pytest.Mark | None:
        for marker in [*self.added, *self._markers]:
            if marker.name == name:
                return marker
        return None

    def add_marker(self, marker: pytest.MarkDecorator) -> None:
        self.added.append(marker.mark)


def test_e2e_slow_item_gets_the_tier_timeout() -> None:
    item = _FakeItem([pytest.mark.e2e_slow.mark])

    apply_e2e_slow_timeout([item])

    marker = item.get_closest_marker("timeout")
    assert marker is not None
    assert marker.args == (E2E_SLOW_TIMEOUT_SEC,)


def test_non_e2e_slow_item_is_untouched() -> None:
    item = _FakeItem([pytest.mark.e2e.mark])

    apply_e2e_slow_timeout([item])

    assert item.added == []


def test_explicit_timeout_marker_is_not_overridden() -> None:
    item = _FakeItem([pytest.mark.e2e_slow.mark, pytest.mark.timeout(900).mark])

    apply_e2e_slow_timeout([item])

    assert item.added == []


def test_custom_seconds_argument() -> None:
    item = _FakeItem([pytest.mark.e2e_slow.mark])

    apply_e2e_slow_timeout([item], seconds=42)

    marker = item.get_closest_marker("timeout")
    assert marker is not None
    assert marker.args == (42,)
