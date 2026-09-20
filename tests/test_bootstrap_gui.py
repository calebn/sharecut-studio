"""Tests for first-run bootstrap service and GUI routes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _isolate_bootstrap_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)


def test_component_status_reports_structure(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp import config
    from podcast_mcp.services import bootstrap as boot

    monkeypatch.setattr(config, "cache_dir", lambda: tmp_path / "cache")
    monkeypatch.setattr(config, "whisper_cache_dir", lambda: tmp_path / "cache" / "whisper")
    monkeypatch.setattr(boot, "_ffmpeg_ready", lambda: False)
    monkeypatch.setattr(boot, "_whisper_ready", lambda _m=None: False)
    monkeypatch.setattr(boot, "_rnnoise_ready", lambda: False)

    status = boot.component_status()
    assert status["ready"] is False
    assert status["cdn_base"] is False
    assert status["components"]["ffmpeg"]["required_for_first_run"] is True
    assert status["components"]["whisper"]["required_for_first_run"] is True
    assert status["components"]["rnnoise"]["required_for_first_run"] is False
    assert "ffmpeg" in status["default_components"]
    assert status["whisper_model"] == "large-v3-turbo"
    assert any(item["id"] == "large-v3-turbo" for item in status["whisper_models"])


def test_run_bootstrap_rejects_torch_extras() -> None:
    from podcast_mcp.services.bootstrap import run_bootstrap

    with pytest.raises(ValueError, match="unsupported"):
        run_bootstrap(["speaker"])


def test_run_bootstrap_ffmpeg_skip_when_on_path(monkeypatch) -> None:
    from podcast_mcp.services import bootstrap as boot

    monkeypatch.setattr(boot.shutil, "which", lambda name: f"/usr/bin/{name}")
    out = boot.run_bootstrap(["ffmpeg"])
    assert out["ok"] is True
    assert out["results"]["ffmpeg"]["skipped"] is True


def test_whisper_ready_requires_matching_model(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp.services import bootstrap as boot

    cache = tmp_path / "whisper"
    cache.mkdir()
    blobs = cache / "models--Systran--faster-whisper-small" / "blobs"
    blobs.mkdir(parents=True)
    (blobs / "x").write_text("x")
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    assert boot._whisper_ready("small") is False

    (blobs / "model.bin").write_bytes(b"x")
    assert boot._whisper_ready("small") is True
    assert boot._whisper_ready("base") is False
    assert boot._whisper_ready("medium") is False


def test_whisper_ready_large_v3_does_not_match_turbo(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp.services import bootstrap as boot

    cache = tmp_path / "whisper"
    blob = cache / "models--Systran--faster-whisper-large-v3-turbo" / "blobs"
    blob.mkdir(parents=True)
    (blob / "model.bin").write_bytes(b"x")
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)

    assert boot._whisper_ready("large-v3-turbo") is True
    assert boot._whisper_ready("large-v3") is False


def test_gui_bootstrap_status_reports_cdn_base(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.example.test/bootstrap")
    client = TestClient(create_app())
    status = client.get("/api/bootstrap/status")
    assert status.status_code == 200
    assert status.json()["cdn_base"] is True


def test_gui_bootstrap_status_and_run(monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import shared_bootstrap_job_manager
    from podcast_mcp.gui.server import create_app

    def fake_status(whisper_model: str | None = None):
        return {
            "ready": False,
            "whisper_model": whisper_model,
            "components": {
                "ffmpeg": {"ok": False, "required_for_first_run": True},
                "whisper": {"ok": False, "required_for_first_run": True},
                "rnnoise": {"ok": False, "required_for_first_run": False},
            },
            "default_components": ["ffmpeg", "whisper"],
            "optional_components": ["rnnoise"],
        }

    def fake_run(components=None, *, whisper_model=None, force=False, progress=None):
        if progress is not None:
            progress.start("bootstrap", "Bootstrap assets", total=1)
            progress.update("bootstrap", 1, total=1, message="done")
            progress.end("bootstrap", message="Bootstrap complete")
        return {
            "ok": True,
            "results": {"ffmpeg": {"ok": True}, "whisper": {"ok": True}},
            "ready": True,
            "whisper_model": whisper_model,
            "components": {},
            "default_components": ["ffmpeg", "whisper"],
            "optional_components": ["rnnoise"],
        }

    monkeypatch.setattr("podcast_mcp.gui.routes.bootstrap.component_status", fake_status)
    monkeypatch.setattr("podcast_mcp.gui.bootstrap_jobs.run_bootstrap", fake_run)
    shared_bootstrap_job_manager(reset=True)
    client = TestClient(create_app())

    status = client.get("/api/bootstrap/status")
    assert status.status_code == 200
    assert status.json()["ready"] is False

    started = client.post("/api/bootstrap/run", json={"components": ["ffmpeg", "whisper"]})
    assert started.status_code == 200
    job_id = started.json()["job"]["id"]

    job = None
    for _ in range(50):
        snap = client.get(f"/api/bootstrap/status-job?job_id={job_id}")
        assert snap.status_code == 200
        job = snap.json()["job"]
        if job and job["status"] in ("ok", "error", "cancelled"):
            break
    assert job is not None
    assert job["status"] == "ok"

    # Second concurrent start while still "ok" should replace finished job.
    started2 = client.post("/api/bootstrap/run", json={"components": ["ffmpeg"]})
    assert started2.status_code == 200
    from podcast_mcp.whisper_models import DEFAULT_WHISPER_MODEL

    assert started.json()["job"]["whisper_model"] == DEFAULT_WHISPER_MODEL


def test_gui_bootstrap_rejects_unknown_whisper_model(tmp_path, monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import shared_bootstrap_job_manager
    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    shared_bootstrap_job_manager(reset=True)
    client = TestClient(create_app())
    bad = client.post(
        "/api/bootstrap/run",
        json={"components": ["whisper"], "whisper_model": "nope"},
    )
    assert bad.status_code == 400
    status = client.get("/api/bootstrap/status?whisper_model=nope")
    assert status.status_code == 400


def test_gui_bootstrap_cancel_and_missing_job(monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import shared_bootstrap_job_manager
    from podcast_mcp.gui.server import create_app

    gate = __import__("threading").Event()

    def slow_run(components=None, *, whisper_model=None, force=False, progress=None):
        gate.wait(timeout=5)
        return {
            "ok": True,
            "results": {},
            "ready": True,
            "whisper_model": whisper_model,
            "components": {},
            "default_components": ["ffmpeg", "whisper"],
            "optional_components": ["rnnoise"],
        }

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.bootstrap.component_status",
        lambda whisper_model=None: {"ready": False, "components": {}, "default_components": []},
    )
    monkeypatch.setattr("podcast_mcp.gui.bootstrap_jobs.run_bootstrap", slow_run)
    shared_bootstrap_job_manager(reset=True)
    client = TestClient(create_app())

    started = client.post("/api/bootstrap/run", json={"components": ["ffmpeg"]})
    assert started.status_code == 200
    job_id = started.json()["job"]["id"]

    conflict = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
    assert conflict.status_code == 409

    missing = client.post("/api/bootstrap/cancel", json={"job_id": "nope"})
    assert missing.status_code == 404

    cancelled = client.post("/api/bootstrap/cancel", json={"job_id": job_id})
    assert cancelled.status_code == 200
    gate.set()

    job = None
    for _ in range(50):
        snap = client.get(f"/api/bootstrap/status-job?job_id={job_id}")
        job = snap.json()["job"]
        if job and job["status"] in ("ok", "error", "cancelled"):
            break
    assert job is not None
    assert job["status"] == "cancelled"

    none_job = client.get("/api/bootstrap/status-job?job_id=missing")
    assert none_job.status_code == 200
    assert none_job.json()["job"] is None


def test_gui_bootstrap_events_sse(monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import shared_bootstrap_job_manager
    from podcast_mcp.gui.server import create_app

    def fake_run(components=None, *, whisper_model=None, force=False, progress=None):
        if progress is not None:
            progress.start("bootstrap", "Bootstrap assets", total=1)
            progress.message("bootstrap", "working")
            progress.update("bootstrap", 1, total=1, message="done")
            progress.end("bootstrap", message="Bootstrap complete")
        return {
            "ok": True,
            "results": {"ffmpeg": {"ok": True}},
            "ready": True,
            "whisper_model": whisper_model,
            "components": {},
            "default_components": ["ffmpeg", "whisper"],
            "optional_components": ["rnnoise"],
        }

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.bootstrap.component_status",
        lambda whisper_model=None: {"ready": False, "components": {}, "default_components": []},
    )
    monkeypatch.setattr("podcast_mcp.gui.bootstrap_jobs.run_bootstrap", fake_run)
    shared_bootstrap_job_manager(reset=True)
    client = TestClient(create_app())

    missing = client.get("/api/bootstrap/events?job_id=nope")
    assert missing.status_code == 404

    started = client.post("/api/bootstrap/run", json={"components": ["ffmpeg"]})
    job_id = started.json()["job"]["id"]

    with client.stream("GET", f"/api/bootstrap/events?job_id={job_id}") as stream:
        body = b"".join(stream.iter_bytes()).decode()
    assert "data:" in body
    assert job_id in body


def test_gui_bootstrap_run_value_error(monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import BootstrapJobManager
    from podcast_mcp.gui.server import create_app

    mgr = BootstrapJobManager()

    def boom(**_kwargs):
        raise ValueError("bad components")

    monkeypatch.setattr(mgr, "start", boom)
    app = create_app()
    app.state.bootstrap_jobs = mgr
    client = TestClient(app)
    res = client.post("/api/bootstrap/run", json={"components": ["ffmpeg"]})
    assert res.status_code == 400
    assert "bad components" in res.json()["detail"]


def test_gui_bootstrap_job_error_result(monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import shared_bootstrap_job_manager
    from podcast_mcp.gui.server import create_app

    def fail_run(components=None, *, whisper_model=None, force=False, progress=None):
        return {
            "ok": False,
            "results": {"ffmpeg": {"ok": False, "error": "download failed"}},
            "ready": False,
            "whisper_model": whisper_model,
            "components": {},
            "default_components": ["ffmpeg", "whisper"],
            "optional_components": ["rnnoise"],
        }

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.bootstrap.component_status",
        lambda whisper_model=None: {"ready": False, "components": {}, "default_components": []},
    )
    monkeypatch.setattr("podcast_mcp.gui.bootstrap_jobs.run_bootstrap", fail_run)
    shared_bootstrap_job_manager(reset=True)
    client = TestClient(create_app())

    started = client.post("/api/bootstrap/run", json={"components": ["ffmpeg"]})
    job_id = started.json()["job"]["id"]
    job = None
    for _ in range(50):
        snap = client.get(f"/api/bootstrap/status-job?job_id={job_id}")
        job = snap.json()["job"]
        if job and job["status"] in ("ok", "error", "cancelled"):
            break
    assert job is not None
    assert job["status"] == "error"
    assert "download failed" in (job.get("error") or "")


def test_run_bootstrap_whisper_forwards_model(monkeypatch) -> None:
    from podcast_mcp.services import bootstrap as boot

    seen: dict[str, str] = {}

    def fake_bootstrap(model_size: str):
        seen["model"] = model_size
        return {"ok": True, "model": model_size, "cache": "/tmp", "persist_error": None}

    monkeypatch.setattr(boot, "bootstrap_whisper_model", fake_bootstrap)
    monkeypatch.setattr(boot, "_ffmpeg_ready", lambda: True)
    monkeypatch.setattr(boot, "_rnnoise_ready", lambda: True)
    monkeypatch.setattr(boot, "_whisper_ready", lambda _m=None: True)
    out = boot.run_bootstrap(["whisper"], whisper_model="small.en")
    assert out["ok"] is True
    assert seen["model"] == "small.en"
    assert out["results"]["whisper"]["model"] == "small.en"


def test_gui_bootstrap_run_records_requested_whisper_model(monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import shared_bootstrap_job_manager
    from podcast_mcp.gui.server import create_app

    recorded: dict[str, object] = {}

    def fake_status(whisper_model: str | None = None):
        return {
            "ready": False,
            "whisper_model": whisper_model,
            "components": {
                "ffmpeg": {"ok": True, "required_for_first_run": True},
                "whisper": {"ok": False, "required_for_first_run": True},
                "rnnoise": {"ok": False, "required_for_first_run": False},
            },
            "default_components": ["ffmpeg", "whisper"],
            "optional_components": ["rnnoise"],
        }

    def fake_run(components=None, *, whisper_model=None, force=False, progress=None):
        recorded["components"] = list(components or [])
        recorded["whisper_model"] = whisper_model
        if progress is not None:
            progress.start("bootstrap", "Bootstrap assets", total=1)
            progress.update("bootstrap", 1, total=1, message="done")
            progress.end("bootstrap", message="Bootstrap complete")
        return {
            "ok": True,
            "results": {"whisper": {"ok": True, "model": whisper_model}},
            "ready": True,
            "whisper_model": whisper_model,
            "components": {},
            "default_components": ["ffmpeg", "whisper"],
            "optional_components": ["rnnoise"],
        }

    monkeypatch.setattr("podcast_mcp.gui.routes.bootstrap.component_status", fake_status)
    monkeypatch.setattr("podcast_mcp.gui.bootstrap_jobs.run_bootstrap", fake_run)
    shared_bootstrap_job_manager(reset=True)
    client = TestClient(create_app())

    started = client.post(
        "/api/bootstrap/run",
        json={"components": ["whisper"], "whisper_model": "small.en"},
    )
    assert started.status_code == 200
    job_id = started.json()["job"]["id"]
    for _ in range(50):
        snap = client.get(f"/api/bootstrap/status-job?job_id={job_id}")
        job = snap.json()["job"]
        if job and job["status"] in ("ok", "error", "cancelled"):
            break
    assert recorded["components"] == ["whisper"]
    assert recorded["whisper_model"] == "small.en"
