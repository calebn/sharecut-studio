"""Public report intake and bounded ZIP contract."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from podcast_mcp.util.diagnostics_bundle_contract import validate_diagnostics_bundle
from podcast_relay import reports


def bundle(files: dict[str, str] | None = None) -> bytes:
    entries = files or {
        "report.json": json.dumps({"app_version": "1.2", "created_at": "2026-09-26T00:00:00Z"}),
        "README.txt": "read me",
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


@pytest.mark.parametrize(
    "files",
    [
        {"report.json": "{}", "README.txt": "x"},
        {"report.json": '{"app_version":"1","created_at":"now"}', "../evil.log": "x"},
        {"report.json": '{"app_version":"1","created_at":"now"}', "README.txt": "x", "x.wav": "x"},
    ],
)
def test_contract_rejects_bad_members(files: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        validate_diagnostics_bundle(bundle(files))


def test_contract_rejects_expansion() -> None:
    data = bundle(
        {
            "report.json": '{"app_version":"1","created_at":"now"}',
            "README.txt": "x",
            "huge.log": "x" * (8 * 1024 * 1024 + 1),
        }
    )
    with pytest.raises(ValueError, match="expanded"):
        validate_diagnostics_bundle(data)


def test_relay_intake_queue_publish_and_public_link(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_REPORT_STORE", str(tmp_path))
    monkeypatch.setenv("PODCAST_REPORT_PUBLIC_BASE_URL", "https://relay.example.test")
    monkeypatch.setenv("PODCAST_REPORT_GITHUB_TOKEN", "secret")
    app = FastAPI()
    app.include_router(reports.router)
    client = TestClient(app)
    payload = {
        "description": "The app fails to open my episode",
        "bundle": base64.b64encode(bundle_bytes := bundle()).decode(),
        "consent": True,
    }
    created = client.post("/api/reports", json=payload)
    assert created.status_code == 200
    status_path = created.json()["status_url"].removeprefix("https://relay.example.test")
    assert client.get(status_path).json() == {"status": "queued", "issue_url": None}
    report_id = status_path.rsplit("/", 1)[-1]
    assert client.get(f"/api/reports/bundles/{report_id}").content == bundle_bytes
    seen: list[tuple[str, str]] = []

    def publisher(
        token: str,
        description: str,
        url: str,
        version: str,
        report_id: str,
        created: float,
        before_post: object,
    ) -> str:
        seen.append((token, url))
        return "https://github.com/calebn/sharecut-studio/issues/123"

    monkeypatch.setattr(reports, "_publish", publisher)
    reports.process_queue(tmp_path, "https://relay.example.test", "secret")
    assert seen == [("secret", f"https://relay.example.test/api/reports/bundles/{report_id}")]
    assert client.get(status_path).json()["status"] == "published"
    assert "secret" not in json.dumps(client.get(status_path).json())


def test_relay_caps_consent_and_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_REPORT_STORE", str(tmp_path))
    monkeypatch.setenv("PODCAST_REPORT_PUBLIC_BASE_URL", "https://relay.example.test")
    monkeypatch.setenv("PODCAST_REPORT_GITHUB_TOKEN", "secret")
    app = FastAPI()
    app.include_router(reports.router)
    client = TestClient(app)
    payload = {
        "description": "The app fails to open my episode",
        "bundle": base64.b64encode(bundle()).decode(),
        "consent": False,
    }
    assert client.post("/api/reports", json=payload).status_code == 400
    payload["consent"] = True
    for _ in range(3):
        assert client.post("/api/reports", json=payload).status_code == 200
    assert client.post("/api/reports", json=payload).status_code == 429
    attempts = []

    def failing(*args: object) -> str:
        attempts.append(1)
        raise RuntimeError("GitHub offline")

    monkeypatch.setattr(reports, "_publish", failing)
    reports.process_queue(tmp_path, "https://relay.example.test", "secret")
    assert attempts == [1]
    monkeypatch.setattr(
        reports, "_publish", lambda *_: "https://github.com/calebn/sharecut-studio/issues/123"
    )
    reports.process_queue(tmp_path, "https://relay.example.test", "secret")
    with reports._db(tmp_path) as db:
        assert db.execute("SELECT COUNT(*) FROM reports WHERE state='published'").fetchone()[0] == 1


def test_relay_accepts_base64_body_above_proxy_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    monkeypatch.setenv("PODCAST_REPORT_STORE", str(tmp_path))
    monkeypatch.setenv("PODCAST_REPORT_PUBLIC_BASE_URL", "https://relay.example.test")
    monkeypatch.setenv("PODCAST_REPORT_GITHUB_TOKEN", "secret")
    app = FastAPI()
    app.include_router(reports.router)
    client = TestClient(app)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("report.json", '{"app_version":"1","created_at":"now"}')
        archive.writestr("README.txt", "read me")
        archive.writestr("random.log", os.urandom(4 * 1024 * 1024))
    result = client.post(
        "/api/reports",
        json={
            "description": "Large but allowed diagnostics",
            "bundle": base64.b64encode(output.getvalue()).decode(),
            "consent": True,
        },
    )
    assert result.status_code == 200
    assert result.json()["status"] == "queued"


def test_relay_global_cap_is_durable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_REPORT_STORE", str(tmp_path))
    monkeypatch.setenv("PODCAST_REPORT_PUBLIC_BASE_URL", "https://relay.example.test")
    monkeypatch.setenv("PODCAST_REPORT_GITHUB_TOKEN", "secret")
    with reports._db(tmp_path) as db:
        now = reports.time.time()
        day = reports.datetime.fromtimestamp(now, reports.UTC).date().isoformat()
        db.executemany(
            "INSERT INTO reports(id,created,day,ip,description,state) VALUES(?,?,?,?,?,'queued')",
            [
                (
                    str(i),
                    now,
                    day,
                    str(i),
                    "existing",
                )
                for i in range(100)
            ],
        )
    app = FastAPI()
    app.include_router(reports.router)
    client = TestClient(app)
    result = client.post(
        "/api/reports",
        json={
            "description": "New report is rejected",
            "bundle": base64.b64encode(bundle()).decode(),
            "consent": True,
        },
    )
    assert result.status_code == 429


def test_relay_ip_cap_is_atomic_across_connections(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setenv("PODCAST_REPORT_STORE", str(tmp_path))
    monkeypatch.setenv("PODCAST_REPORT_PUBLIC_BASE_URL", "https://relay.example.test")
    monkeypatch.setenv("PODCAST_REPORT_GITHUB_TOKEN", "secret")
    payload = {
        "description": "Several simultaneous failure reports",
        "bundle": base64.b64encode(bundle()).decode(),
        "consent": True,
    }

    def submit(_: int) -> int:
        app = FastAPI()
        app.include_router(reports.router)
        return TestClient(app).post("/api/reports", json=payload).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(submit, range(8)))
    assert codes.count(200) == 3
    assert codes.count(429) == 5


def test_contract_accepts_flat_unicode_and_hidden_logs_and_bounds_version() -> None:
    data = bundle(
        {
            "report.json": '{"app_version":"1","created_at":"now"}',
            "README.txt": "x",
            "épisode.log": "one",
            ".debug.log": "two",
        }
    )
    assert validate_diagnostics_bundle(data).files[-2:] == ("épisode.log", ".debug.log")
    data = bundle(
        {
            "report.json": json.dumps({"app_version": "x" * 81, "created_at": "now"}),
            "README.txt": "x",
        }
    )
    with pytest.raises(ValueError, match="app version"):
        validate_diagnostics_bundle(data)


def test_publisher_lock_prevents_second_worker_during_slow_reconciliation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with reports._db(tmp_path) as db:
        db.execute(
            "INSERT INTO reports(id,created,day,ip,description,state) VALUES(?,?,?,?,?,'queued')",
            (
                "report",
                reports.time.time(),
                "today",
                "ip",
                "A useful report",
            ),
        )
    bundles = tmp_path / "bundles"
    bundles.mkdir()
    (bundles / "report.zip").write_bytes(bundle())
    entered = threading.Event()
    release = threading.Event()
    posts: list[str] = []

    def slow_reconciliation(*args: object) -> None:
        for page in range(20):
            if page == 9:
                entered.set()
                assert release.wait(5)

    class Response:
        status = 201

        def read(self, limit: int) -> bytes:
            return b'{"html_url":"https://github.com/calebn/sharecut-studio/issues/123"}'

    class Connection:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def request(self, method: str, path: str, **kwargs: object) -> None:
            if method == "POST":
                posts.append("posted")

        def getresponse(self) -> Response:
            return Response()

        def close(self) -> None:
            pass

    monkeypatch.setattr(reports, "_existing_issue", slow_reconciliation)
    monkeypatch.setattr(reports.http.client, "HTTPSConnection", Connection)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(reports.process_queue, tmp_path, "https://relay.test", "token")
        assert entered.wait(5)
        second = pool.submit(reports.process_queue, tmp_path, "https://relay.test", "token")
        second.result(timeout=5)
        release.set()
        first.result(timeout=5)
    assert posts == ["posted"]
    with reports._db(tmp_path) as db:
        assert db.execute("SELECT state FROM reports WHERE id='report'").fetchone() == (
            "published",
        )


def test_post_started_recovery_never_reposts_when_marker_not_visible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with reports._db(tmp_path) as db:
        db.execute(
            "INSERT INTO reports(id,created,day,ip,description,state,post_started) "
            "VALUES(?,?,?,?,?,'publishing',1)",
            ("report", reports.time.time(), "today", "ip", "A useful report"),
        )
    monkeypatch.setattr(reports, "_existing_issue", lambda *_: None)
    monkeypatch.setattr(reports, "_publish", lambda *_: pytest.fail("must not POST again"))
    reports.process_queue(tmp_path, "https://relay.test", "token")
    with reports._db(tmp_path) as db:
        assert db.execute("SELECT state FROM reports WHERE id='report'").fetchone() == (
            "publish_uncertain",
        )


def test_post_started_recovery_reconciles_existing_issue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with reports._db(tmp_path) as db:
        db.execute(
            "INSERT INTO reports(id,created,day,ip,description,state,post_started) "
            "VALUES(?,?,?,?,?,'publishing',1)",
            ("report", reports.time.time(), "today", "ip", "A useful report"),
        )
    monkeypatch.setattr(
        reports,
        "_existing_issue",
        lambda *_: "https://github.com/calebn/sharecut-studio/issues/123",
    )
    monkeypatch.setattr(reports, "_publish", lambda *_: pytest.fail("must not POST again"))
    reports.process_queue(tmp_path, "https://relay.test", "token")
    with reports._db(tmp_path) as db:
        assert db.execute("SELECT state,issue_url FROM reports WHERE id='report'").fetchone() == (
            "published",
            "https://github.com/calebn/sharecut-studio/issues/123",
        )


def test_status_and_download_share_id_and_retention_policy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_REPORT_STORE", str(tmp_path))
    monkeypatch.setenv("PODCAST_REPORT_PUBLIC_BASE_URL", "https://relay.test")
    monkeypatch.setenv("PODCAST_REPORT_GITHUB_TOKEN", "token")
    app = FastAPI()
    app.include_router(reports.router)
    client = TestClient(app)
    with reports._db(tmp_path) as db:
        db.execute(
            "INSERT INTO reports(id,created,day,ip,description,state) VALUES(?,?,?,?,?,'queued')",
            ("old", 1, "today", "ip", "A useful report"),
        )
    for report_id in ("old", "bad%2Fid", "bad%5Cid"):
        assert client.get(f"/api/reports/{report_id}").status_code == 404
        assert client.get(f"/api/reports/bundles/{report_id}").status_code == 404


def test_stale_claim_cannot_commit_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with reports._db(tmp_path) as db:
        db.execute(
            "INSERT INTO reports(id,created,day,ip,description,state) VALUES(?,?,?,?,?,'queued')",
            ("report", reports.time.time(), "today", "ip", "A useful report"),
        )
    (tmp_path / "bundles").mkdir()
    (tmp_path / "bundles/report.zip").write_bytes(bundle())

    def stale(*args: object) -> str:
        with reports._db(tmp_path) as db:
            db.execute("UPDATE reports SET claim_token='replacement' WHERE id='report'")
        return "https://github.com/calebn/sharecut-studio/issues/123"

    monkeypatch.setattr(reports, "_publish", stale)
    reports.process_queue(tmp_path, "https://relay.test", "token")
    with reports._db(tmp_path) as db:
        assert db.execute("SELECT state,issue_url FROM reports WHERE id='report'").fetchone() == (
            "publishing",
            None,
        )


def test_intake_storage_does_not_block_event_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_REPORT_STORE", str(tmp_path))
    monkeypatch.setenv("PODCAST_REPORT_PUBLIC_BASE_URL", "https://relay.test")
    monkeypatch.setenv("PODCAST_REPORT_GITHUB_TOKEN", "token")
    entered = threading.Event()
    release = threading.Event()

    def slow_store(*args: object) -> dict[str, str]:
        entered.set()
        assert release.wait(5)
        return {"status": "queued", "status_url": "https://relay.test/api/reports/id"}

    monkeypatch.setattr(reports, "_store_report", slow_store)
    app = FastAPI()
    app.include_router(reports.router)

    @app.get("/ping")
    def ping() -> dict[str, bool]:
        return {"ok": True}

    async def run() -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            post = asyncio.create_task(client.post("/api/reports", content=b"{}"))
            assert await asyncio.to_thread(entered.wait, 5)
            assert (await asyncio.wait_for(client.get("/ping"), timeout=1)).status_code == 200
            release.set()
            assert (await post).status_code == 200

    asyncio.run(run())


def test_permanent_github_failure_is_actionable_without_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with reports._db(tmp_path) as db:
        db.execute(
            "INSERT INTO reports(id,created,day,ip,description,state) VALUES(?,?,?,?,?,'queued')",
            ("report", reports.time.time(), "today", "ip", "A useful report"),
        )
    (tmp_path / "bundles").mkdir()
    (tmp_path / "bundles/report.zip").write_bytes(bundle())

    def rejected(*args: object) -> str:
        callback = args[-1]
        assert callable(callback)
        callback()
        raise reports.PublishError(422)

    monkeypatch.setattr(reports, "_publish", rejected)
    reports.process_queue(tmp_path, "https://relay.test", "token")
    with reports._db(tmp_path) as db:
        assert db.execute("SELECT state FROM reports WHERE id='report'").fetchone() == ("failed",)
    reports.process_queue(tmp_path, "https://relay.test", "token")
    with reports._db(tmp_path) as db:
        assert db.execute("SELECT attempts FROM reports WHERE id='report'").fetchone() == (1,)


def test_github_issue_title_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(reports, "_existing_issue", lambda *_: None)
    sent: list[dict[str, object]] = []

    class Response:
        status = 201

        def read(self, limit: int) -> bytes:
            return b'{"html_url":"https://github.com/calebn/sharecut-studio/issues/123"}'

    class Connection:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def request(self, method: str, path: str, **kwargs: object) -> None:
            sent.append(json.loads(kwargs["body"]))

        def getresponse(self) -> Response:
            return Response()

        def close(self) -> None:
            pass

    monkeypatch.setattr(reports.http.client, "HTTPSConnection", Connection)
    reports._publish("token", "description", "https://relay.test/bundle", "v" * 500, "id", 1)
    assert len(sent[0]["title"]) <= reports._TITLE_LIMIT
