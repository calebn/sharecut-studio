"""``/api/import/inbox/{id}``: the one file the iOS app received, fetched once and dropped, host only."""

from __future__ import annotations

import uuid
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.routes.deps import host_gate
from podcast_mcp.gui.server import create_app
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

CODE = "X-Sharecut-Error-Code"
ENV = "PODCAST_IOS_INBOX_DIR"


@pytest.fixture
def inbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "inbox"
    root.mkdir()
    monkeypatch.setenv(ENV, str(root))
    return root


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), client=("127.0.0.1", 50000))


def _receive(inbox: Path, name: str = "My Clip.sharecutseg", data: bytes = b"PK-bytes") -> str:
    inbox_id = str(uuid.uuid4())
    (inbox / inbox_id).mkdir()
    (inbox / inbox_id / name).write_bytes(data)
    return inbox_id


def _receive_as(inbox: Path, folder: str) -> None:
    (inbox / folder).mkdir()
    (inbox / folder / "My Clip.sharecutseg").write_bytes(b"PK-bytes")


def test_the_file_streams_with_its_name_and_is_never_cached(
    inbox: Path, client: TestClient
) -> None:
    inbox_id = _receive(inbox)

    res = client.get(f"/api/import/inbox/{inbox_id}")

    assert res.status_code == 200
    assert res.content == b"PK-bytes"
    assert res.headers["cache-control"] == "no-store"
    assert "filename*=utf-8''My%20Clip.sharecutseg" in res.headers["content-disposition"]


def test_a_non_ascii_name_is_encoded_in_the_disposition(inbox: Path, client: TestClient) -> None:
    inbox_id = _receive(inbox, name="Café.sharecutkit")

    res = client.get(f"/api/import/inbox/{inbox_id}")

    assert res.status_code == 200
    assert "filename*=utf-8''Caf%C3%A9.sharecutkit" in res.headers["content-disposition"]


def test_the_content_type_is_an_opaque_download(inbox: Path, client: TestClient) -> None:
    inbox_id = _receive(inbox)

    res = client.get(f"/api/import/inbox/{inbox_id}")

    assert res.headers["content-type"] == "application/octet-stream"


def test_a_quote_in_the_name_is_percent_encoded_not_left_raw(
    inbox: Path, client: TestClient
) -> None:
    inbox_id = _receive(inbox, name='My "Clip" Café.sharecutseg')

    res = client.get(f"/api/import/inbox/{inbox_id}")

    assert res.status_code == 200
    disposition = res.headers["content-disposition"]
    assert disposition == "attachment; filename*=utf-8''My%20%22Clip%22%20Caf%C3%A9.sharecutseg"
    assert '"' not in disposition


def test_delete_is_one_shot(inbox: Path, client: TestClient) -> None:
    inbox_id = _receive(inbox)

    first = client.delete(f"/api/import/inbox/{inbox_id}")
    again = client.delete(f"/api/import/inbox/{inbox_id}")
    fetched = client.get(f"/api/import/inbox/{inbox_id}")

    assert (first.status_code, first.json()) == (200, {"dropped": inbox_id})
    assert (again.status_code, fetched.status_code) == (404, 404)
    assert again.headers[CODE] == "import_inbox_unknown"
    assert not (inbox / inbox_id).exists()


@pytest.mark.parametrize(
    "bad_id",
    [
        "..",
        "%2e%2e",
        "..%2f..%2fetc",
        "not-a-uuid",
        "A" * 8 + "-0000-4000-8000-000000000000",
        "12345678-1234-1234-1234-123456789abc",
        "4DE57C6A-98B3-4EE0-A203-5B8829A60452",
        "4de57c6a-98b3-4ee0-a203-5b8829a60452x",
        "%00",
    ],
)
def test_a_malformed_id_is_refused_as_missing(inbox: Path, client: TestClient, bad_id: str) -> None:
    (inbox.parent / "secret.sharecutseg").write_bytes(b"secret")

    for method in ("GET", "DELETE"):
        res = client.request(method, f"/api/import/inbox/{bad_id}")
        assert res.status_code in {404, 405}
        assert b"secret" not in res.content
    assert (inbox.parent / "secret.sharecutseg").exists()


@pytest.mark.parametrize(
    "folder",
    [
        "4de57c6a-98b3-4ee0-a203-5b8829a60452\n",
        "4de57c6a-98b3-4ee0-a203-5b8829a60452\nx",
        "4de57c6a-98b3-1ee0-a203-5b8829a60452",
        "4de57c6a-98b3-7ee0-a203-5b8829a60452",
        "4DE57C6A-98B3-4EE0-A203-5B8829A60452",
    ],
    ids=["trailing-newline", "newline-and-text", "version-1", "version-7", "uppercase"],
)
def test_an_id_that_is_not_exactly_a_lowercase_v4_is_never_served(
    inbox: Path, client: TestClient, folder: str
) -> None:
    """The folder really exists under that literal name, so only the id check can refuse it."""
    _receive_as(inbox, folder)
    url_id = quote(folder, safe="")

    assert client.get(f"/api/import/inbox/{url_id}").status_code == 404
    assert client.delete(f"/api/import/inbox/{url_id}").status_code == 404
    assert (inbox / folder / "My Clip.sharecutseg").exists()


def test_a_directory_as_the_only_member_is_not_served(inbox: Path, client: TestClient) -> None:
    inbox_id = "4de57c6a-98b3-4ee0-a203-5b8829a60452"
    (inbox / inbox_id / "nested.sharecutseg").mkdir(parents=True)

    res = client.get(f"/api/import/inbox/{inbox_id}")

    assert res.status_code == 404
    assert res.headers[CODE] == "import_inbox_unknown"


def test_a_symlinked_entry_is_not_followed(inbox: Path, client: TestClient, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "x.sharecutseg").write_bytes(b"secret")
    inbox_id = str(uuid.uuid4())
    (inbox / inbox_id).symlink_to(outside, target_is_directory=True)

    assert client.get(f"/api/import/inbox/{inbox_id}").status_code == 404
    assert client.delete(f"/api/import/inbox/{inbox_id}").status_code == 404
    assert (outside / "x.sharecutseg").exists()


def test_a_symlinked_file_is_not_served(inbox: Path, client: TestClient, tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"secret")
    inbox_id = str(uuid.uuid4())
    (inbox / inbox_id).mkdir()
    (inbox / inbox_id / "a.sharecutseg").symlink_to(secret)

    assert client.get(f"/api/import/inbox/{inbox_id}").status_code == 404


@pytest.mark.parametrize("members", [0, 2])
def test_an_entry_without_exactly_one_file_is_missing(
    inbox: Path, client: TestClient, members: int
) -> None:
    inbox_id = str(uuid.uuid4())
    (inbox / inbox_id).mkdir()
    for index in range(members):
        (inbox / inbox_id / f"{index}.sharecutseg").write_bytes(b"x")

    assert client.get(f"/api/import/inbox/{inbox_id}").status_code == 404


def test_an_unknown_id_is_missing(inbox: Path, client: TestClient) -> None:
    res = client.get(f"/api/import/inbox/{uuid.uuid4()}")

    assert res.status_code == 404
    assert res.headers[CODE] == "import_inbox_unknown"
    assert res.headers["cache-control"] == "no-store"


def test_a_missing_directory_is_missing(
    tmp_path: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(ENV, str(tmp_path / "never-created"))
    path = f"/api/import/inbox/{uuid.uuid4()}"

    assert client.get(path).status_code == 404
    assert client.delete(path).status_code == 404


def test_without_the_variable_nothing_is_served(
    inbox: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    inbox_id = _receive(inbox)
    monkeypatch.delenv(ENV)

    assert client.get(f"/api/import/inbox/{inbox_id}").status_code == 404
    assert client.delete(f"/api/import/inbox/{inbox_id}").status_code == 404
    assert (inbox / inbox_id).exists()


@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_a_relayed_request_is_refused_and_leaves_the_file(inbox: Path, method: str) -> None:
    inbox_id = _receive(inbox)
    relayed = TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )

    res = relayed.request(method, f"/api/import/inbox/{inbox_id}")

    assert (res.status_code, res.headers[CODE]) == (403, "authz_denied")
    assert (inbox / inbox_id).exists()


@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_a_foreign_origin_is_refused(inbox: Path, client: TestClient, method: str) -> None:
    inbox_id = _receive(inbox)

    res = client.request(
        method, f"/api/import/inbox/{inbox_id}", headers={"Origin": "https://evil.example"}
    )

    assert res.status_code == 403
    assert (inbox / inbox_id).exists()


def test_both_routes_are_mounted_under_the_host_gate() -> None:
    gated = [
        route
        for included in create_app().routes
        if hasattr(included, "original_router")
        and any(
            depends.dependency is host_gate for depends in included.include_context.dependencies
        )
        for route in included.original_router.routes
        if getattr(route, "path", "") == "/api/import/inbox/{inbox_id}"
    ]

    assert sorted(method for route in gated for method in route.methods - {"HEAD"}) == [
        "DELETE",
        "GET",
    ]
