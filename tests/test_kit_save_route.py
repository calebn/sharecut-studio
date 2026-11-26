"""``POST /api/kits``: Studio saves a kit through the one ``save_kit`` the CLI and MCP use."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.segments.kit import KitStore, kit_id_for
from podcast_mcp.segments.kit_summary import make_entry, save_kit
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.util.coded_error import CodedValueError
from segment_helpers import make_segment_dir

CODE = "X-Sharecut-Error-Code"


@pytest.fixture(autouse=True)
def _config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config = tmp_path / "config"
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(config))
    return config


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), client=("127.0.0.1", 50000))


@pytest.fixture
def ids(tmp_path: Path) -> list[str]:
    store = SegmentStore()
    return [
        store.add(make_segment_dir(tmp_path / "in", name=name, audio=audio)).id
        for name, audio in (("Warm Intro", b"fLaC-one"), ("Sign Off", b"fLaC-two"))
    ]


def _body(ids: list[str], **over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Show Kit",
        "entries": [
            {"segment_id": ids[0], "at": "start"},
            {"segment_id": ids[1], "at": "end"},
        ],
    }
    body.update(over)
    return body


def test_saves_a_new_kit_then_a_new_version_then_reports_unchanged(
    client: TestClient, ids: list[str]
) -> None:
    kit_id = kit_id_for("Show Kit")

    first = client.post("/api/kits", json=_body(ids))
    assert (first.status_code, first.json()) == (
        200,
        {"status": "added", "id": kit_id, "version": 1},
    )

    again = client.post("/api/kits", json=_body(ids))
    assert (again.status_code, again.json()["status"], again.json()["version"]) == (
        200,
        "unchanged",
        1,
    )

    changed = client.post("/api/kits", json=_body(ids, entries=[{"segment_id": ids[0], "at": 30}]))
    assert (changed.status_code, changed.json()) == (
        200,
        {"status": "new_version", "id": kit_id, "version": 2},
    )

    rows = {row["id"]: row for row in client.get("/api/kits").json()}
    assert (rows[kit_id]["version"], rows[kit_id]["entries"], rows[kit_id]["usable"]) == (
        2,
        1,
        True,
    )


def test_entries_keep_their_order_at_and_note(client: TestClient, ids: list[str]) -> None:
    entries = [
        {"segment_id": ids[1], "at": "end", "note": "Last", "version": 1},
        {"segment_id": ids[0], "at": 12.5},
    ]
    assert client.post("/api/kits", json=_body(ids, entries=entries)).status_code == 200
    saved = KitStore().get(kit_id_for("Show Kit"))
    assert [(e.segment_id, e.at, e.version, e.note) for e in saved.entries] == [
        (ids[1], "end", 1, "Last"),
        (ids[0], 12.5, None, None),
    ]


def test_same_entries_as_the_cli_path_save_the_same_bytes(
    client: TestClient, ids: list[str]
) -> None:
    save_kit(
        KitStore(),
        SegmentStore(),
        "Show Kit",
        [make_entry(ids[0], None, "start"), make_entry(ids[1], None, "end")],
    )
    res = client.post("/api/kits", json=_body(ids))
    assert (res.status_code, res.json()) == (
        200,
        {"status": "unchanged", "id": kit_id_for("Show Kit"), "version": 1},
    )
    assert [kit.version for kit in KitStore().list()] == [1]


def test_two_start_entries_are_saved_in_the_order_sent(client: TestClient, ids: list[str]) -> None:
    # Each start entry goes to the very start when it applies, so the second lands ahead of the
    # first; the kit file itself keeps the order the sheet sent and warns about it.
    entries = [{"segment_id": ids[0], "at": "start"}, {"segment_id": ids[1], "at": "start"}]
    assert client.post("/api/kits", json=_body(ids, entries=entries)).status_code == 200
    saved = KitStore().get(kit_id_for("Show Kit"))
    assert [(e.segment_id, e.at) for e in saved.entries] == [
        (ids[0], "start"),
        (ids[1], "start"),
    ]


@pytest.mark.parametrize(
    ("name", "status", "code"),
    [
        ("!!! ???", 422, "kit_name_invalid"),
        ("日本", 422, "kit_name_invalid"),
        ("", 422, "kit_name_invalid"),
        ("   ", 422, "kit_name_invalid"),
        ("7", 200, None),
        ("Café", 200, None),
        ("\uff53\uff48\uff4f\uff57", 200, None),
        ("日本 show", 200, None),
        ("Show", 200, None),
        ("  Show Kit  ", 200, None),
        ("x" * 200 + "  ", 200, None),
        ("x" * 201, 422, "kit_invalid"),
    ],
)
def test_names_answer_as_the_sheets_kit_name_rule_expects(
    client: TestClient, ids: list[str], name: str, status: int, code: str | None
) -> None:
    # gui/web/src/kits/kitName.test.ts holds the same table; change both together.
    res = client.post("/api/kits", json=_body(ids, name=name))
    assert res.status_code == status, res.text
    if code is None:
        assert res.json()["id"] == kit_id_for(name)
    else:
        assert res.headers[CODE] == code


def test_a_damaged_segment_is_not_checked_so_the_kit_saves(
    client: TestClient, ids: list[str]
) -> None:
    # save_kit asks only that each segment and version exist; the sheet's picker is what keeps a
    # damaged one out. The kit then shows as not usable until the segment is back.
    damaged = SegmentStore().directory / ids[0] / "v1" / "segment.json"
    damaged.write_text("not json")
    res = client.post("/api/kits", json=_body(ids))
    assert (res.status_code, res.json()["status"]) == (200, "added")
    rows = {row["id"]: row for row in client.get("/api/kits").json()}
    assert rows[kit_id_for("Show Kit")]["usable"] is False


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"name": "日本"}, 422, "kit_name_invalid"),
        ({"name": "   "}, 422, "kit_name_invalid"),
        ({"name": "x" * 201}, 422, "kit_invalid"),
        ({"entries": []}, 422, "kit_invalid"),
        ({"entries": [{"segment_id": "seg", "at": "start"}] * 33}, 422, "kit_invalid"),
        ({"entries": [{"segment_id": "not an id!", "at": "start"}]}, 422, "kit_invalid"),
        ({"entries": [{"segment_id": "x", "at": -1.0}]}, 422, "kit_invalid"),
        ({"entries": [{"segment_id": "x", "at": "middle"}]}, 422, "kit_invalid"),
        (
            {"entries": [{"segment_id": "warm-intro", "at": "start", "version": 0}]},
            422,
            "segment_version_invalid",
        ),
    ],
)
def test_refuses_what_the_cli_and_mcp_refuse_with_the_same_code(
    client: TestClient, ids: list[str], body: dict[str, Any], status: int, code: str
) -> None:
    res = client.post("/api/kits", json=_body(ids, **body))
    assert (res.status_code, res.headers[CODE]) == (status, code), res.text
    assert KitStore().list() == []


def test_a_segment_missing_from_the_library_is_a_409_that_names_it(
    client: TestClient, ids: list[str]
) -> None:
    entries = [
        {"segment_id": ids[0], "at": "start"},
        {"segment_id": "ghost-0000", "at": "end"},
        {"segment_id": ids[1], "at": "end", "version": 9},
    ]
    res = client.post("/api/kits", json=_body(ids, entries=entries))
    assert (res.status_code, res.headers[CODE]) == (409, "kit_segment_missing")
    assert "entry 2" in res.text and "entry 3" in res.text
    assert KitStore().list() == []


def test_a_busy_library_is_a_409(
    client: TestClient, ids: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def busy(self: KitStore, kit: object) -> object:
        raise CodedValueError("Another action is using the kit library.", code="kit_busy")

    monkeypatch.setattr(KitStore, "add", busy)
    res = client.post("/api/kits", json=_body(ids))
    assert (res.status_code, res.headers[CODE]) == (409, "kit_busy")


@pytest.mark.parametrize(
    "bad",
    [
        {"extra": 1},
        {"name": 5},
        {"entries": [{"segment_id": "a", "at": True}]},
        {"entries": [{"segment_id": "a", "at": "start", "version": "1"}]},
        {"entries": [{"segment_id": "a", "at": "start", "version": True}]},
        {"entries": [{"segment_id": "a", "at": "start", "path": "/x"}]},
        {"entries": [{"at": "start"}]},
    ],
)
def test_a_body_of_the_wrong_shape_is_refused_before_anything_is_saved(
    client: TestClient, ids: list[str], bad: dict[str, Any]
) -> None:
    res = client.post("/api/kits", json=_body(ids, **bad))
    assert res.status_code == 422, res.text
    assert KitStore().list() == []


def test_a_forged_origin_cannot_save_a_kit(client: TestClient, ids: list[str]) -> None:
    res = client.post("/api/kits", json=_body(ids), headers={"Origin": "https://evil.example"})
    assert res.status_code == 403
    assert KitStore().list() == []
