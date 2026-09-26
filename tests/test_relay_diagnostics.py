"""Public report intake and bounded ZIP contract."""

from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

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
        "bundle": base64.b64encode(bundle()).decode(),
        "consent": True,
    }
    created = client.post("/api/reports", json=payload)
    assert created.status_code == 200
    status_path = created.json()["status_url"].removeprefix("https://relay.example.test")
    assert client.get(status_path).json() == {"status": "queued", "issue_url": None}
    report_id = status_path.rsplit("/", 1)[-1]
    assert client.get(f"/api/reports/bundles/{report_id}").content == bundle()
    seen: list[tuple[str, str]] = []

    def publisher(
        token: str, description: str, url: str, version: str, report_id: str, created: float
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
