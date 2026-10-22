"""Tests for first-run bootstrap service and GUI routes."""

from __future__ import annotations

import urllib.error
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.models.registry import MODELS


@pytest.fixture(autouse=True)
def _isolate_bootstrap_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)


def test_component_status_reports_structure(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp.config import defaults as config
    from podcast_mcp.engines.models import registry
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(config, "cache_dir", lambda: tmp_path / "cache")
    monkeypatch.setattr(config, "whisper_cache_dir", lambda: tmp_path / "cache" / "whisper")
    monkeypatch.setattr(boot, "resolve_ffmpeg_pair", lambda **_kwargs: None)
    from podcast_mcp.engines.models.whisper import WhisperWeightsMissingError

    monkeypatch.setattr(
        registry, "whisper_model_problem", lambda m, **k: WhisperWeightsMissingError(m)
    )
    from podcast_mcp.engines.models.word_aligner import WordAlignerMissingError

    monkeypatch.setattr(registry, "rnnoise_model_path", lambda: tmp_path / "missing.rnnn")
    monkeypatch.setattr(
        registry,
        "word_aligner_problem",
        lambda *a, **k: WordAlignerMissingError("onnx-base"),
    )

    status = boot.component_status()
    assert status["ready"] is False
    assert status["cdn_base"] is False
    assert status["tools"] == {
        "ffmpeg": {"state": "missing", "source": "not found", "hint": None},
    }
    assert [row["id"] for row in status["models"]] == [spec.id for spec in MODELS]
    by_id = {row["id"]: row for row in status["models"]}
    assert [by_id[i]["tier"] for i in by_id] == ["required", "recommended", "offered", "offered"]
    assert by_id["whisper"]["purpose"] == "transcription"
    assert by_id["whisper"]["state"] == "missing"
    assert by_id["whisper"]["model"] == "large-v3-turbo"
    assert by_id["whisper"]["size"] == "~1.6 GB"
    assert by_id["whisper"]["size_bytes"] == 1_600_000_000
    assert (
        by_id["whisper"]["bootstrap"]
        == "podcast bootstrap --component whisper --whisper-model large-v3-turbo"
    )
    assert by_id["rnnoise"]["size_bytes"] == 297646
    assert status["whisper_model"] == "large-v3-turbo"
    assert any(item["id"] == "large-v3-turbo" for item in status["whisper_models"])

    aligner = by_id["word-aligner"]
    assert aligner["state"] == "missing"
    assert aligner["model"] == "onnx-base"
    assert aligner["size_bytes"] is None
    assert aligner["bootstrap"] == "podcast bootstrap --component word-aligner"
    removed = {
        "components",
        "default_components",
        "optional_components",
        "opt_in_components",
    }
    assert removed.isdisjoint(status)
    assert all(
        {"ok", "pin_mismatch", "required_for_first_run", "opt_in"}.isdisjoint(row)
        for row in status["models"]
    )
    assert "ffmpeg" not in by_id


def test_status_whisper_size_follows_the_requested_variant(monkeypatch) -> None:
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(boot, "resolve_ffmpeg_pair", lambda **_kwargs: None)
    whisper = boot.component_status(whisper_model="tiny.en")["models"][0]
    assert (whisper["model"], whisper["size"], whisper["size_bytes"]) == (
        "tiny.en",
        "~75 MB",
        75_000_000,
    )


def test_ready_needs_ffmpeg_and_every_required_model(monkeypatch) -> None:
    from podcast_mcp.services.pipeline import bootstrap as boot

    pair = type("Pair", (), {"source": "bundled", "is_available": lambda self: True})()
    monkeypatch.setattr(boot, "resolve_ffmpeg_pair", lambda **_kwargs: pair)
    monkeypatch.setattr(
        boot,
        "model_status",
        lambda model_id, variant=None: {
            "id": model_id,
            "tier": "required" if model_id == "whisper" else "offered",
            "state": "installed" if model_id == "whisper" else "missing",
        },
    )
    assert boot.component_status()["ready"] is True
    monkeypatch.setattr(
        boot,
        "model_status",
        lambda model_id, variant=None: {"id": model_id, "state": "update_needed"},
    )
    assert boot.component_status()["ready"] is False


def test_word_aligner_component_ok_has_no_hint(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(registry, "word_aligner_problem", lambda *a, **k: None)
    component = boot.model_status("word-aligner")
    assert component["state"] == "installed"
    assert "hint" not in component
    assert "bootstrap" not in component


def test_word_aligner_component_reports_unexpected_errors(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.services.pipeline import bootstrap as boot

    def raise_runtime_error(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(registry, "word_aligner_problem", raise_runtime_error)
    component = boot.model_status("word-aligner")
    assert component["state"] == "missing"
    assert component["hint"] == "boom"


def test_whisper_component_reports_unexpected_errors(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.services.pipeline import bootstrap as boot

    def raise_runtime_error(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(registry, "whisper_model_problem", raise_runtime_error)
    component = boot.model_status("whisper", "small.en")
    assert component["state"] == "missing"
    assert component["model"] == "small.en"
    assert component["hint"] == "boom"
    assert component["bootstrap"] == "podcast bootstrap --component whisper"


def test_whisper_component_missing_has_download_hint(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.engines.models.whisper import WhisperWeightsMissingError
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(
        registry, "whisper_model_problem", lambda m, **k: WhisperWeightsMissingError(m)
    )
    component = boot.model_status("whisper", "small.en")
    assert component["state"] == "missing"
    assert "pin_mismatch" not in component
    assert (
        component["bootstrap"] == "podcast bootstrap --component whisper --whisper-model small.en"
    )
    assert "is not downloaded" in component["hint"]
    assert "--whisper-model small.en" in component["hint"]


def test_run_bootstrap_word_aligner_downloads_when_missing(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.engines.models.word_aligner import WordAlignerMissingError
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(
        registry, "word_aligner_problem", lambda *a, **k: WordAlignerMissingError("onnx-base")
    )
    calls: dict[str, object] = {}

    def fake_bootstrap_word_aligner(model_id, *, force=False, on_progress=None):
        calls["force"] = force
        return {"ok": True, "model": model_id, "path": "/x"}

    monkeypatch.setattr(registry, "bootstrap_word_aligner", fake_bootstrap_word_aligner)
    out = boot.run_bootstrap(["word-aligner"])
    assert out["results"]["word-aligner"]["ok"] is True
    assert calls["force"] is False


def test_run_bootstrap_word_aligner_skips_when_cached(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(registry, "word_aligner_problem", lambda *a, **k: None)

    def fail_if_called(*a, **k):
        raise AssertionError("bootstrap_word_aligner should not run when cached")

    monkeypatch.setattr(registry, "bootstrap_word_aligner", fail_if_called)
    out = boot.run_bootstrap(["word-aligner"])
    assert out["results"]["word-aligner"] == {
        "ok": True,
        "skipped": True,
        "reason": "cached",
        "model": "onnx-base",
    }


def test_run_bootstrap_word_aligner_reports_download_error(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.engines.models.word_aligner import WordAlignerMissingError
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(
        registry, "word_aligner_problem", lambda *a, **k: WordAlignerMissingError("onnx-base")
    )

    def raise_error(*a, force=False, on_progress=None):
        raise urllib.error.URLError("network down")

    monkeypatch.setattr(registry, "bootstrap_word_aligner", raise_error)
    out = boot.run_bootstrap(["word-aligner"])
    plain = "Couldn't reach the download server. Check your internet connection and try again."
    assert out["results"]["word-aligner"] == {
        "ok": False,
        "error": plain,
        "failure": {"kind": "network", "status": None, "plain": plain},
    }


def test_run_bootstrap_reports_an_unexpected_error_generically(monkeypatch, caplog) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.services.pipeline import bootstrap as boot

    def raise_error(*a, force=False, on_progress=None):
        raise RuntimeError("/srv/secret.bin exploded")

    monkeypatch.setattr(registry, "bootstrap_rnnoise_model", raise_error)
    out = boot.run_bootstrap(["rnnoise"])
    assert out["results"]["rnnoise"] == {
        "ok": False,
        "error": "Noise reduction (RNNoise) could not be installed.",
    }
    assert "secret.bin exploded" in caplog.text


def test_run_bootstrap_default_installs_only_the_first_run_set(monkeypatch) -> None:
    from podcast_mcp.services.pipeline import bootstrap as boot

    installed: list[str] = []
    monkeypatch.setattr(
        boot,
        "install_model",
        lambda spec, *, whisper_model, force, cancel_check: (
            installed.append(spec.id) or {"ok": True}
        ),
    )
    out = boot.run_bootstrap(None)
    assert installed == ["whisper"]
    assert list(out["results"]) == ["whisper"]


def test_gui_bootstrap_run_accepts_word_aligner(monkeypatch) -> None:
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.jobs import shared_job_manager

    def fake_run(components=None, *, whisper_model=None, force=False, progress=None, **_extra):
        if progress is not None:
            progress.start("bootstrap", "Bootstrap assets", total=1)
            progress.end("bootstrap", message="Bootstrap complete")
        return {
            "ok": True,
            "results": {"word-aligner": {"ok": True}},
            "ready": True,
            "whisper_model": whisper_model,
            "models": [],
            "tools": {},
        }

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", fake_run)
    shared_job_manager(reset=True)
    client = TestClient(create_app())

    started = client.post("/api/bootstrap/run", json={"components": ["word-aligner"]})
    assert started.status_code == 200
    assert started.json()["job"]["components"] == ["word-aligner"]


def test_run_bootstrap_rejects_torch_extras() -> None:
    from podcast_mcp.services.pipeline.bootstrap import run_bootstrap

    with pytest.raises(ValueError, match="unsupported"):
        run_bootstrap(["speaker"])


def test_whisper_component_requires_matching_model(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp.services.pipeline import bootstrap as boot

    cache = tmp_path / "whisper"
    cache.mkdir()
    blobs = cache / "models--Systran--faster-whisper-small" / "blobs"
    blobs.mkdir(parents=True)
    (blobs / "x").write_text("x")
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: cache)
    assert boot.model_status("whisper", "small")["state"] == "missing"

    (blobs / "model.bin").write_bytes(b"x")
    assert boot.model_status("whisper", "small")["state"] == "installed"
    assert boot.model_status("whisper", "base")["state"] == "missing"
    assert boot.model_status("whisper", "medium")["state"] == "missing"


def test_whisper_component_large_v3_does_not_match_turbo(tmp_path: Path, monkeypatch) -> None:
    from model_pin_helpers import plant_pinned_whisper
    from podcast_mcp.services.pipeline import bootstrap as boot

    cache = tmp_path / "whisper"
    plant_pinned_whisper(cache, "large-v3-turbo", monkeypatch)
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: cache)

    assert boot.model_status("whisper", "large-v3-turbo")["state"] == "installed"
    assert boot.model_status("whisper", "large-v3")["state"] == "missing"


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
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.jobs import shared_job_manager

    def fake_status(whisper_model: str | None = None):
        return {
            "ready": False,
            "whisper_model": whisper_model,
            "tools": {"ffmpeg": {"state": "missing", "source": "not found", "hint": None}},
            "models": [{"id": "whisper", "state": "missing"}],
        }

    def fake_run(components=None, *, whisper_model=None, force=False, progress=None, **_extra):
        if progress is not None:
            progress.start("bootstrap", "Bootstrap assets", total=1)
            progress.update("bootstrap", 1, total=1, message="done")
            progress.end("bootstrap", message="Bootstrap complete")
        return {
            "ok": True,
            "results": {"whisper": {"ok": True}},
            "ready": True,
            "whisper_model": whisper_model,
            "models": [],
            "tools": {},
        }

    monkeypatch.setattr("podcast_mcp.gui.routes.bootstrap.component_status", fake_status)
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", fake_run)
    shared_job_manager(reset=True)
    client = TestClient(create_app())

    status = client.get("/api/bootstrap/status")
    assert status.status_code == 200
    assert status.json()["ready"] is False

    started = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
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
    started2 = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
    assert started2.status_code == 200
    from podcast_mcp.engines.models.whisper import DEFAULT_WHISPER_MODEL

    assert started.json()["job"]["whisper_model"] == DEFAULT_WHISPER_MODEL


def test_gui_bootstrap_rejects_unknown_whisper_model(tmp_path, monkeypatch) -> None:
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.jobs import shared_job_manager

    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    shared_job_manager(reset=True)
    client = TestClient(create_app())
    bad = client.post(
        "/api/bootstrap/run",
        json={"components": ["whisper"], "whisper_model": "nope"},
    )
    assert bad.status_code == 400
    status = client.get("/api/bootstrap/status?whisper_model=nope")
    assert status.status_code == 400


def test_gui_bootstrap_cancel_and_missing_job(monkeypatch) -> None:
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.jobs import shared_job_manager

    gate = __import__("threading").Event()

    def slow_run(components=None, *, whisper_model=None, force=False, progress=None, **_extra):
        gate.wait(timeout=5)
        return {
            "ok": True,
            "results": {},
            "ready": True,
            "whisper_model": whisper_model,
            "models": [],
            "tools": {},
        }

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.bootstrap.component_status",
        lambda whisper_model=None: {"ready": False, "models": [], "tools": {}},
    )
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", slow_run)
    shared_job_manager(reset=True)
    client = TestClient(create_app())

    started = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
    assert started.status_code == 200
    job_id = started.json()["job"]["id"]

    assert started.json()["adopted"] is False
    joined = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
    assert joined.status_code == 200
    assert joined.json()["adopted"] is True
    assert joined.json()["job"]["id"] == job_id

    conflict = client.post("/api/bootstrap/run", json={"components": ["whisper", "rnnoise"]})
    assert conflict.status_code == 409
    body = conflict.json()["detail"]
    assert "already running" in body["detail"]
    assert body["running"] == ["whisper"]
    assert body["cancelling"] is False

    missing = client.post("/api/bootstrap/cancel", json={"job_id": "nope"})
    assert missing.status_code == 404

    cancelled = client.post("/api/bootstrap/cancel", json={"job_id": job_id})
    assert cancelled.status_code == 200
    stopping = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
    assert stopping.status_code == 409
    assert stopping.json()["detail"]["cancelling"] is True
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
    import json

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.jobs import shared_job_manager

    def fake_run(components=None, *, whisper_model=None, force=False, progress=None, **_extra):
        if progress is not None:
            progress.start("bootstrap", "Bootstrap assets", total=1)
            progress.message("bootstrap", "working")
            progress.update("bootstrap", 1, total=1, message="done")
            progress.end("bootstrap", message="Bootstrap complete")
        return {
            "ok": True,
            "results": {"whisper": {"ok": True}},
            "ready": True,
            "whisper_model": whisper_model,
            "models": [],
            "tools": {},
        }

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.bootstrap.component_status",
        lambda whisper_model=None: {"ready": False, "models": [], "tools": {}},
    )
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", fake_run)
    shared_job_manager(reset=True)
    client = TestClient(create_app())

    missing = client.get("/api/bootstrap/events?job_id=nope")
    assert missing.status_code == 404

    started = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
    job_id = started.json()["job"]["id"]

    with client.stream("GET", f"/api/bootstrap/events?job_id={job_id}") as stream:
        body = b"".join(stream.iter_bytes()).decode()
    assert "data:" in body
    assert job_id in body
    frames = [
        json.loads(ln.removeprefix("data: ")) for ln in body.splitlines() if ln.startswith("data: ")
    ]
    assert frames[-1]["type"] == "done"


def test_gui_bootstrap_run_value_error(monkeypatch) -> None:
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.jobs import JobManager

    mgr = JobManager()

    def boom(**_kwargs):
        raise ValueError("bad components")

    monkeypatch.setattr(mgr, "start_bootstrap", boom)
    app = create_app()
    app.state.jobs = mgr
    client = TestClient(app)
    res = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
    assert res.status_code == 400
    assert "bad components" in res.json()["detail"]


def test_gui_bootstrap_job_error_result(monkeypatch) -> None:
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.jobs import shared_job_manager

    def fail_run(components=None, *, whisper_model=None, force=False, progress=None, **_extra):
        return {
            "ok": False,
            "results": {"whisper": {"ok": False, "error": "download failed"}},
            "ready": False,
            "whisper_model": whisper_model,
            "models": [],
            "tools": {},
        }

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.bootstrap.component_status",
        lambda whisper_model=None: {"ready": False, "models": [], "tools": {}},
    )
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", fail_run)
    shared_job_manager(reset=True)
    client = TestClient(create_app())

    started = client.post("/api/bootstrap/run", json={"components": ["whisper"]})
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
    from podcast_mcp.engines.models import registry
    from podcast_mcp.services.pipeline import bootstrap as boot

    seen: dict[str, object] = {}

    def fake_bootstrap(model_size: str, *, force: bool = False, on_progress=None):
        seen["model"] = model_size
        seen["force"] = force
        return {"ok": True, "model": model_size, "cache": "/tmp", "persist_error": None}

    monkeypatch.setattr(registry, "bootstrap_whisper_model", fake_bootstrap)
    monkeypatch.setattr(registry, "whisper_model_problem", lambda *a, **k: None)
    out = boot.run_bootstrap(["whisper"], whisper_model="small.en")
    assert out["ok"] is True
    assert seen["model"] == "small.en"
    assert seen["force"] is False
    assert out["results"]["whisper"]["model"] == "small.en"

    out = boot.run_bootstrap(["whisper"], whisper_model="small.en", force=True)
    assert seen["force"] is True


def test_gui_bootstrap_run_records_requested_whisper_model(monkeypatch) -> None:
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.jobs import shared_job_manager

    recorded: dict[str, object] = {}

    def fake_status(whisper_model: str | None = None):
        return {
            "ready": False,
            "whisper_model": whisper_model,
            "tools": {"ffmpeg": {"state": "installed", "source": "bundled", "hint": None}},
            "models": [{"id": "whisper", "state": "missing"}],
        }

    def fake_run(components=None, *, whisper_model=None, force=False, progress=None, **_extra):
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
            "models": [],
            "tools": {},
        }

    monkeypatch.setattr("podcast_mcp.gui.routes.bootstrap.component_status", fake_status)
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", fake_run)
    shared_job_manager(reset=True)
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


def test_run_bootstrap_word_aligner_refetches_a_pin_mismatch_without_force(
    tmp_path: Path, monkeypatch
) -> None:
    from model_pin_helpers import pin_word_aligner_to_fake_snapshot
    from podcast_mcp.services.pipeline import bootstrap as boot
    from podcast_mcp.util.model_manifest import clear_manifest_memo

    clear_manifest_memo()
    snap = pin_word_aligner_to_fake_snapshot(tmp_path / "snap", monkeypatch)
    good = (snap / "vocab.json").read_bytes()
    (snap / "vocab.json").write_bytes(b"tampered")
    downloads: list[bool] = []

    def fake_snapshot_download(repo, **kwargs):
        if kwargs.get("dry_run"):
            return []
        if not kwargs.get("local_files_only"):
            downloads.append(kwargs["force_download"])
            if kwargs["force_download"]:
                (snap / "vocab.json").write_bytes(good)
        return str(snap)

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download, raising=False)
    out = boot.run_bootstrap(["word-aligner"])
    assert out["results"]["word-aligner"]["ok"] is True
    assert downloads == [False, True]


def test_run_bootstrap_whisper_refetches_a_pin_mismatch_without_force(
    tmp_path: Path, monkeypatch
) -> None:
    from model_pin_helpers import plant_pinned_whisper
    from podcast_mcp.services.pipeline import bootstrap as boot
    from podcast_mcp.util.model_manifest import clear_manifest_memo

    clear_manifest_memo()
    cache = tmp_path / "whisper"
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: cache)
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    good = (snap / "vocabulary.txt").read_bytes()
    (snap / "vocabulary.txt").write_bytes(b"tampered")
    downloads: list[bool] = []

    def fake_snapshot_download(repo, **kwargs):
        if kwargs.get("dry_run"):
            return []
        if not kwargs.get("local_files_only"):
            downloads.append(kwargs["force_download"])
            if kwargs["force_download"]:
                (snap / "vocabulary.txt").write_bytes(good)
        return str(snap)

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download, raising=False)
    out = boot.run_bootstrap(["whisper"], whisper_model="small.en")
    assert out["results"]["whisper"]["ok"] is True
    assert downloads == [False, True]


def test_component_status_whisper_pin_mismatch(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.engines.models.whisper import WhisperPinMismatchError
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(
        registry,
        "whisper_model_problem",
        lambda m, **k: WhisperPinMismatchError(m, "model.bin sha256 abc does not match the pin"),
    )
    status = boot.component_status(whisper_model="small.en")
    whisper = status["models"][0]
    assert status["ready"] is False
    assert whisper["state"] == "update_needed"
    assert "does not match its pinned download" in whisper["hint"]
    assert whisper["bootstrap"] == (
        "podcast bootstrap --component whisper --whisper-model small.en --upgrade"
    )
    assert whisper["tier"] == "required"


def test_status_components_poll_memoised(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.services.pipeline import bootstrap as boot

    seen: list[bool] = []

    def fake_problem(*a, memoize: bool = False):
        seen.append(memoize)

    monkeypatch.setattr(registry, "whisper_model_problem", fake_problem)
    monkeypatch.setattr(registry, "word_aligner_problem", fake_problem)
    assert boot.model_status("whisper", "small.en")["state"] == "installed"
    assert boot.model_status("word-aligner")["state"] == "installed"
    assert seen == [True, True]


def test_word_aligner_component_flags_a_pin_mismatch(monkeypatch) -> None:
    from podcast_mcp.engines.models import registry
    from podcast_mcp.engines.models.word_aligner import WordAlignerPinMismatchError
    from podcast_mcp.services.pipeline import bootstrap as boot

    monkeypatch.setattr(
        registry,
        "word_aligner_problem",
        lambda *a, **k: WordAlignerPinMismatchError(
            "onnx-base", "vocab.json sha256 abc does not match the pin"
        ),
    )
    component = boot.model_status("word-aligner")
    assert component["state"] == "update_needed"
    assert component["bootstrap"] == "podcast bootstrap --component word-aligner --upgrade"
    assert "vocab.json" in component["hint"]


@pytest.mark.parametrize("executable", [True, False])
def test_first_run_readiness_checks_bare_and_nonexecutable_explicit_commands(
    monkeypatch, executable
):
    import podcast_mcp.util.binaries as binaries
    from podcast_mcp.services.pipeline import bootstrap as boot
    from podcast_mcp.util.binaries import FFmpegPair

    monkeypatch.setattr(binaries.shutil, "which", lambda _command: "found" if executable else None)
    monkeypatch.setattr(
        boot,
        "resolve_ffmpeg_pair",
        lambda **_kwargs: FFmpegPair("ffmpeg", "ffprobe", (9, 0, 2), "explicit"),
    )
    assert boot.component_status()["tools"]["ffmpeg"]["state"] == (
        "installed" if executable else "missing"
    )
