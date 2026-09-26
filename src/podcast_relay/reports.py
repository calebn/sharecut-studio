"""Public, opt-in diagnostics intake with durable local queue and issue publishing."""

from __future__ import annotations

import base64
import binascii
import http.client
import json
import os
import secrets
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from podcast_mcp.util.diagnostics_bundle_contract import (
    validate_diagnostics_bundle,
)

router = APIRouter()
_BODY_LIMIT = 7 * 1024 * 1024  # Base64 overhead above the 5 MiB ZIP cap.
_RETENTION_SECONDS = 30 * 86400


class ReportRequest(BaseModel):
    description: str = Field(min_length=10, max_length=4000)
    bundle: str = Field(min_length=1)
    consent: bool
    proof_of_work: str | None = Field(default=None, max_length=256)


def _settings() -> tuple[Path, str, str]:
    root = os.environ.get("PODCAST_REPORT_STORE", "").strip()
    public = os.environ.get("PODCAST_REPORT_PUBLIC_BASE_URL", "").rstrip("/")
    token = os.environ.get("PODCAST_REPORT_GITHUB_TOKEN", "")
    parsed = urlparse(public)
    if (
        not root
        or not token
        or not parsed.netloc
        or (
            parsed.scheme != "https"
            and not (
                parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            )
        )
    ):
        raise HTTPException(503, "report intake is not configured")
    return Path(root), public, token


@contextmanager
def _db(root: Path) -> Iterator[sqlite3.Connection]:
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / "reports.sqlite3", timeout=10, isolation_level=None)
    db.execute("PRAGMA busy_timeout=10000")
    db.execute(
        "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, created REAL NOT NULL, "
        "day TEXT NOT NULL, ip TEXT NOT NULL, description TEXT NOT NULL, "
        "state TEXT NOT NULL, issue_url TEXT, attempts INTEGER NOT NULL DEFAULT 0, "
        "claimed REAL NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0)"
    )
    try:
        yield db
    finally:
        db.close()


def _existing_issue(token: str, report_id: str, created: float) -> str | None:
    """Reconcile a crash after GitHub accepted an issue but before local commit."""
    marker = f"sharecut-report-id:{report_id}"
    conn = http.client.HTTPSConnection("api.github.com", timeout=15)
    try:
        for page in range(1, 21):
            conn.request(
                "GET",
                f"/repos/calebn/sharecut-studio/issues?state=all&labels=beta-report&per_page=100&page={page}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "sharecut-report-relay",
                },
            )
            response = conn.getresponse()
            body = response.read(1024 * 1024)
            if response.status != 200:
                raise RuntimeError(f"GitHub issue reconciliation failed ({response.status})")
            rows = json.loads(body)
            if not isinstance(rows, list):
                raise RuntimeError("GitHub returned invalid issue list")
            for row in rows:
                if marker in (row.get("body") or ""):
                    return str(row["html_url"])
            if not rows or len(rows) < 100:
                return None
            oldest = min(
                datetime.fromisoformat(row["created_at"].replace("Z", "+00:00")).timestamp()
                for row in rows
            )
            if oldest < created:
                return None
        raise RuntimeError("GitHub issue reconciliation page limit exceeded")
    finally:
        conn.close()


def _publish(
    token: str, description: str, bundle_url: str, version: str, report_id: str, created: float
) -> str:
    existing = _existing_issue(token, report_id, created)
    if existing:
        return existing
    body = json.dumps(
        {
            "title": f"[Beta report] Sharecut Studio {version}",
            "body": f"{description}\n\nDiagnostics ZIP (public for 30 days): {bundle_url}\n\n<!-- sharecut-report-id:{report_id} -->",
            "labels": ["beta-report"],
        }
    )
    conn = http.client.HTTPSConnection("api.github.com", timeout=15)
    try:
        conn.request(
            "POST",
            "/repos/calebn/sharecut-studio/issues",
            body=body.encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "sharecut-report-relay",
            },
        )
        response = conn.getresponse()
        result = response.read(64 * 1024)
        if response.status != 201:
            raise RuntimeError(f"GitHub issue creation failed ({response.status})")
        url = json.loads(result)["html_url"]
        if not isinstance(url, str) or not url.startswith(
            "https://github.com/calebn/sharecut-studio/issues/"
        ):
            raise RuntimeError("GitHub returned an invalid issue URL")
        return url
    finally:
        conn.close()


def process_queue(root: Path, public: str, token: str) -> None:
    """Process queued reports; lease rows atomically across relay workers."""
    with _db(root) as db:
        db.execute("BEGIN IMMEDIATE")
        cutoff = time.time() - _RETENTION_SECONDS
        expired = db.execute("SELECT id FROM reports WHERE created < ?", (cutoff,)).fetchall()
        db.execute("DELETE FROM reports WHERE created < ?", (cutoff,))
        row = db.execute(
            "SELECT id, description, attempts, created FROM reports WHERE "
            "(state='queued' AND next_attempt<=?) OR (state='publishing' AND claimed<?) "
            "ORDER BY created LIMIT 1",
            (time.time(), time.time() - 120),
        ).fetchone()
        if row:
            db.execute(
                "UPDATE reports SET state='publishing', attempts=attempts+1, claimed=? WHERE id=?",
                (time.time(), row[0]),
            )
        db.commit()
    for (expired_id,) in expired:
        (root / "bundles" / f"{expired_id}.zip").unlink(missing_ok=True)
    if not row:
        return
    report_id, description, previous_attempts, created = row
    bundle = root / "bundles" / f"{report_id}.zip"
    try:
        preview = validate_diagnostics_bundle(bundle.read_bytes())
        issue_url = _publish(
            token,
            description,
            f"{public}/api/reports/bundles/{report_id}",
            preview.app_version,
            report_id,
            created,
        )
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
        http.client.HTTPException,
    ):
        with _db(root) as db:
            db.execute(
                "UPDATE reports SET state='queued', next_attempt=? WHERE id=?",
                (time.time() + min(3600, 30 * 2 ** min(previous_attempts + 1, 7)), report_id),
            )
        return
    with _db(root) as db:
        db.execute(
            "UPDATE reports SET state='published', issue_url=? WHERE id=?", (issue_url, report_id)
        )


def start_report_worker() -> None:
    """Retry queued reports without another user request; operator controls lifecycle."""

    def run() -> None:
        while True:
            try:
                root, public, token = _settings()
                process_queue(root, public, token)
            except (HTTPException, OSError, sqlite3.Error):
                pass
            time.sleep(30)

    threading.Thread(target=run, name="report-publisher", daemon=True).start()


@router.post("/api/reports")
async def submit_report(request: Request) -> dict[str, str]:
    root, public, _token = _settings()
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > _BODY_LIMIT:
            raise HTTPException(413, "report request too large")
    try:
        payload = ReportRequest.model_validate_json(bytes(data))
    except ValueError:
        raise HTTPException(400, "invalid report request") from None
    if not payload.consent:
        raise HTTPException(400, "public upload consent is required")
    try:
        encoded = payload.bundle.encode("ascii")
        bundle = base64.b64decode(encoded, validate=True)
    except (UnicodeEncodeError, binascii.Error):
        raise HTTPException(400, "invalid diagnostics bundle") from None
    try:
        validate_diagnostics_bundle(bundle)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    day = datetime.fromtimestamp(now, UTC).date().isoformat()
    report_id = secrets.token_urlsafe(24)
    target = root / "bundles" / f"{report_id}.zip"
    try:
        with _db(root) as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT COUNT(*) FROM reports WHERE day=?", (day,)).fetchone()[0] >= 100:
                raise HTTPException(429, "daily report limit reached")
            if (
                db.execute(
                    "SELECT COUNT(*) FROM reports WHERE day=? AND ip=?", (day, ip)
                ).fetchone()[0]
                >= 3
            ):
                raise HTTPException(429, "daily IP report limit reached")
            if (
                db.execute(
                    "SELECT COUNT(*) FROM reports WHERE state IN ('queued','publishing')"
                ).fetchone()[0]
                >= 1000
            ):
                raise HTTPException(503, "report queue full")
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as sink:
                sink.write(bundle)
                sink.flush()
                os.fsync(sink.fileno())
            db.execute(
                "INSERT INTO reports(id,created,day,ip,description,state) VALUES(?,?,?,?,?,'queued')",
                (report_id, now, day, ip, payload.description),
            )
            db.commit()
    except HTTPException:
        raise
    except (OSError, sqlite3.Error):
        target.unlink(missing_ok=True)
        raise HTTPException(503, "report storage unavailable") from None
    return {"status": "queued", "status_url": f"{public}/api/reports/{report_id}"}


@router.get("/api/reports/{report_id}")
def report_status(report_id: str) -> dict[str, str | None]:
    root, _public, _token = _settings()
    if (
        len(report_id) > 64
        or not report_id.isascii()
        or not all(char.isalnum() or char in "-_" for char in report_id)
    ):
        raise HTTPException(404, "report not found")
    with _db(root) as db:
        row = db.execute(
            "SELECT state,issue_url FROM reports WHERE id=? AND created>=?",
            (report_id, time.time() - _RETENTION_SECONDS),
        ).fetchone()
    if not row:
        raise HTTPException(404, "report not found")
    return {"status": "queued" if row[0] == "publishing" else row[0], "issue_url": row[1]}


@router.get("/api/reports/bundles/{report_id}")
def public_bundle(report_id: str) -> FileResponse:
    root, _public, _token = _settings()
    if (
        len(report_id) > 64
        or not report_id.isascii()
        or not all(char.isalnum() or char in "-_" for char in report_id)
    ):
        raise HTTPException(404, "report not found")
    with _db(root) as db:
        row = db.execute(
            "SELECT 1 FROM reports WHERE id=? AND created>=?",
            (report_id, time.time() - _RETENTION_SECONDS),
        ).fetchone()
    target = root / "bundles" / f"{report_id}.zip"
    if not row or not target.is_file():
        raise HTTPException(404, "report not found")
    return FileResponse(
        target,
        media_type="application/zip",
        filename="sharecut-diagnostics.zip",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
