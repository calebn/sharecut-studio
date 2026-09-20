from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


def filter_items(
    items: list[T],
    *,
    get_id: Callable[[T], str],
    ids: set[str] | None = None,
    predicates: list[Callable[[T], bool]] | None = None,
) -> list[T]:
    out: list[T] = []
    for item in items:
        if ids is not None and get_id(item) not in ids:
            continue
        if predicates and not all(pred(item) for pred in predicates):
            continue
        out.append(item)
    return out


def approve_by_id(
    items: list[T],
    ids: list[str],
    *,
    get_id: Callable[[T], str],
    on_approve: Callable[[T], None],
) -> int:
    id_set = set(ids)
    count = 0
    for item in items:
        if get_id(item) in id_set:
            on_approve(item)
            count += 1
    return count


def reject_by_id(
    items: list[T],
    ids: list[str],
    *,
    get_id: Callable[[T], str],
) -> tuple[list[T], int]:
    id_set = set(ids)
    before = len(items)
    kept = [item for item in items if get_id(item) not in id_set]
    return kept, before - len(kept)
