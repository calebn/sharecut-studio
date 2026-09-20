from __future__ import annotations

from dataclasses import dataclass

from podcast_mcp.util.review import approve_by_id, filter_items, reject_by_id


@dataclass
class Item:
    id: str
    flag: bool = False


def test_approve_and_reject_by_id():
    items = [Item("a"), Item("b"), Item("c")]
    n = approve_by_id(
        items, ["a", "c"], get_id=lambda x: x.id, on_approve=lambda x: setattr(x, "flag", True)
    )
    assert n == 2
    assert items[0].flag and not items[1].flag and items[2].flag
    kept, removed = reject_by_id(items, ["b"], get_id=lambda x: x.id)
    assert removed == 1
    assert len(kept) == 2


def test_filter_items_by_id_and_predicate():
    items = [Item("a"), Item("b"), Item("c")]
    filtered = filter_items(
        items,
        get_id=lambda x: x.id,
        ids={"a", "c"},
        predicates=[lambda x: x.id != "c"],
    )
    assert [x.id for x in filtered] == ["a"]


def test_filter_items_without_predicates():
    items = [Item("a"), Item("b")]
    filtered = filter_items(items, get_id=lambda x: x.id, ids={"a"})
    assert [x.id for x in filtered] == ["a"]


def test_filter_items_without_filters():
    items = [Item("a"), Item("b")]
    filtered = filter_items(items, get_id=lambda x: x.id)
    assert [x.id for x in filtered] == ["a", "b"]
