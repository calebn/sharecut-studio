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
    assert [by_id[i]["tier"] for i in by_id] == [
        "required",
        "recommended",
        "recommended",
        "recommended",
    ]
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
    assert aligner["size_bytes"] == 360_000_000
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
            "tier": "required" if model_id == "whisper" else "recommended",
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


def _client() -> TestClient:
    from podcast_mcp.gui.server import create_app

    return TestClient(create_app())


def test_remove_model_deletes_the_downloaded_file_and_reports_the_record(
    tmp_path: Path, monkeypatch
) -> None:
    from podcast_mcp.util.model_assets import rnnoise_model_path

    monkeypatch.delenv("PODCAST_MCP_RNNOISE_MODEL", raising=False)
    path = rnnoise_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * 100)

    res = _client().delete("/api/bootstrap/models/rnnoise")

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["freed_bytes"] == 100
    assert body["model"]["id"] == "rnnoise"
    assert body["model"]["state"] == "missing"
    assert not path.exists()


def test_remove_model_that_is_not_installed_frees_nothing(monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_MCP_RNNOISE_MODEL", raising=False)

    res = _client().delete("/api/bootstrap/models/rnnoise")

    assert res.status_code == 200
    assert res.json()["freed_bytes"] == 0


def test_remove_whisper_deletes_only_the_asked_size(tmp_path: Path) -> None:
    from podcast_mcp.config.defaults import whisper_cache_dir
    from podcast_mcp.engines.models.whisper import WHISPER_PINS

    root = whisper_cache_dir()
    pinned = WHISPER_PINS["tiny.en"].hf_repo.replace("/", "--")
    mine = root / f"models--{pinned}"
    other = root / "models--Systran--faster-whisper-small.en"
    for folder in (mine, other):
        (folder / "snapshots").mkdir(parents=True)
        (folder / "snapshots" / "model.bin").write_bytes(b"w" * 10)

    res = _client().delete("/api/bootstrap/models/whisper", params={"whisper_model": "tiny.en"})

    assert res.status_code == 200
    assert res.json()["freed_bytes"] == 10
    assert not mine.exists()
    assert other.exists()


def test_remove_model_is_refused_while_a_download_runs(monkeypatch) -> None:
    import threading

    from podcast_mcp.services.jobs import shared_job_manager

    gate = threading.Event()

    def slow_run(*args, **kwargs):
        gate.wait(5)
        return {
            "ok": True,
            "results": {},
            "ready": True,
            "whisper_model": "x",
            "models": [],
            "tools": {},
        }

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", slow_run)
    shared_job_manager(reset=True)
    client = _client()
    started = client.post("/api/bootstrap/run", json={"components": ["rnnoise"]})
    assert started.status_code == 200

    res = client.delete("/api/bootstrap/models/rnnoise")

    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "bootstrap_job_running"
    assert res.json()["detail"]["running"] == ["rnnoise"]
    gate.set()


def test_remove_model_is_refused_while_a_pipeline_runs(monkeypatch) -> None:
    from unittest.mock import Mock

    from podcast_mcp.gui.routes import bootstrap
    from podcast_mcp.services.jobs import Job, JobManager

    manager = JobManager()
    manager._job = Job(id="busy-pipeline")
    remove = Mock(side_effect=AssertionError("A busy pipeline must not uninstall a model"))
    monkeypatch.setattr(bootstrap, "_jobs", lambda _request: manager)
    monkeypatch.setattr(bootstrap, "uninstall_model", remove)

    res = _client().delete("/api/bootstrap/models/rnnoise")

    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "pipeline_busy"
    assert res.json()["detail"] == "A job is running; remove the model when it finishes"
    remove.assert_not_called()


def test_remove_whisper_rejects_an_invalid_variant_before_accessing_models(
    tmp_path: Path, monkeypatch
) -> None:
    from unittest.mock import Mock

    from podcast_mcp.engines.models import registry
    from podcast_mcp.gui.routes import bootstrap
    from podcast_mcp.services.jobs import JobManager

    manager = JobManager()
    cache = tmp_path / "whisper-cache"
    cache.mkdir()
    sentinel = cache / "keep.bin"
    sentinel.write_bytes(b"unchanged")
    locate = Mock(return_value=cache)
    remove = Mock(side_effect=AssertionError("An invalid variant must not remove model files"))
    monkeypatch.setattr(bootstrap, "_jobs", lambda _request: manager)
    monkeypatch.setattr(registry, "whisper_cache_dir", locate)
    monkeypatch.setattr(registry.shutil, "rmtree", remove)

    res = _client().delete(
        "/api/bootstrap/models/whisper", params={"whisper_model": "not-a-whisper-size"}
    )

    assert res.status_code == 400
    assert res.headers["X-Sharecut-Error-Code"] == "invalid_request"
    assert "Unknown Whisper model" in res.json()["detail"]
    locate.assert_not_called()
    remove.assert_not_called()
    assert sentinel.read_bytes() == b"unchanged"


@pytest.mark.parametrize("admission", ["bootstrap", "pipeline", "agent"])
@pytest.mark.parametrize("removal_fails", [False, True])
def test_remove_model_excludes_admission_without_blocking_status_or_cancel(
    tmp_path: Path, monkeypatch, admission: str, removal_fails: bool
) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, Lock
    from unittest.mock import Mock

    from podcast_mcp.gui.routes import bootstrap
    from podcast_mcp.services.jobs import JobManager

    manager = JobManager()
    removing = Event()
    release = Event()
    removal_finished = Event()
    admission_attempted = Event()
    worker_finished = Event()
    real_io = Mock(side_effect=AssertionError("This test must not access model files"))

    class AdmissionProbe:
        def __init__(self):
            self.lock = Lock()

        def __enter__(self):
            if removing.is_set():
                admission_attempted.set()
            self.lock.acquire()

        def __exit__(self, *_args):
            self.lock.release()

    def fake_uninstall(model_id, variant):
        removing.set()
        try:
            assert release.wait(5)
            if removal_fails:
                raise RuntimeError("Test uninstall failed")
            return {"ok": True, "freed_bytes": 0, "model": {"id": model_id, "state": "missing"}}
        finally:
            removal_finished.set()

    def fake_worker(job):
        try:
            assert removal_finished.is_set()
        finally:
            worker_finished.set()

    def admit():
        if admission == "bootstrap":
            job, adopted = manager.start_bootstrap(components=["rnnoise"])
            assert not adopted
        elif admission == "pipeline":
            job = manager.start_render_preview(tmp_path / "unused.sharecut")
        else:
            job = manager.adopt_agent_job(tool_id="test", label="Test", claim="test-claim")
            worker_finished.set()
        assert removal_finished.is_set()
        return job

    def read_and_cancel():
        return (
            manager.status()["running"],
            manager.get_bootstrap_job(),
            manager.cancel(),
            manager.cancel_bootstrap(),
        )

    monkeypatch.setattr(bootstrap, "_jobs", lambda _request: manager)
    monkeypatch.setattr(manager, "_model_removal_lock", AdmissionProbe())
    monkeypatch.setattr(manager, "_run_bootstrap_job", fake_worker)
    monkeypatch.setattr(manager, "_run_job", fake_worker)
    monkeypatch.setattr(bootstrap, "uninstall_model", fake_uninstall)
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", real_io)
    monkeypatch.setattr("podcast_mcp.services.pipeline.bootstrap.remove_model", real_io)

    with ThreadPoolExecutor(max_workers=3) as pool:
        request = pool.submit(_client().delete, "/api/bootstrap/models/rnnoise")
        try:
            assert removing.wait(5)
            admitted = pool.submit(admit)
            assert admission_attempted.wait(5)
            assert pool.submit(read_and_cancel).result(timeout=5) == (False, None, None, None)
            assert not admitted.done()
        finally:
            release.set()
        if removal_fails:
            with pytest.raises(RuntimeError, match="Test uninstall failed"):
                request.result(timeout=5)
        else:
            assert request.result(timeout=5).status_code == 200
        assert admitted.result(timeout=5).kind == (
            "bootstrap"
            if admission == "bootstrap"
            else "render_preview"
            if admission == "pipeline"
            else "agent"
        )
        assert worker_finished.wait(5)

    real_io.assert_not_called()


def test_remove_model_is_refused_while_an_agent_job_runs(monkeypatch) -> None:
    from unittest.mock import Mock

    from podcast_mcp.gui.routes import bootstrap
    from podcast_mcp.services.jobs import JobManager

    manager = JobManager()
    manager.adopt_agent_job(tool_id="test", label="Test", claim="active-agent")
    remove = Mock(side_effect=AssertionError("A live agent must prevent model removal"))
    monkeypatch.setattr(bootstrap, "_jobs", lambda _request: manager)
    monkeypatch.setattr(bootstrap, "uninstall_model", remove)

    res = _client().delete("/api/bootstrap/models/rnnoise")

    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "pipeline_busy"
    remove.assert_not_called()


def test_remove_invalid_aligner_variant_preserves_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.models import registry

    cache = tmp_path / "aligner-cache"
    monkeypatch.setattr(registry, "word_aligner_cache_dir", lambda: cache)
    sentinel = cache / "synthetic-download" / "model.onnx"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_bytes(b"keep the installed model")

    response = _client().delete(
        "/api/bootstrap/models/word-aligner", params={"whisper_model": "not-an-aligner"}
    )

    assert response.status_code == 400
    assert response.headers["X-Sharecut-Error-Code"] == "invalid_request"
    assert sentinel.read_bytes() == b"keep the installed model"


def test_remove_whisper_matches_only_cache_entry_not_ancestors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.config.defaults import whisper_cache_dir

    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "faster-whisper-tiny" / "cache"))
    other = whisper_cache_dir() / "models--Systran--faster-whisper-small.en"
    sentinel = other / "snapshots" / "fake" / "model.bin"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_bytes(b"the other size")

    response = _client().delete("/api/bootstrap/models/whisper", params={"whisper_model": "tiny"})

    assert response.status_code == 200
    assert response.json()["freed_bytes"] == 0
    assert sentinel.read_bytes() == b"the other size"


def test_remove_whisper_counts_blob_payload_without_snapshot_links(tmp_path: Path) -> None:
    from podcast_mcp.config.defaults import whisper_cache_dir
    from podcast_mcp.engines.models.registry import remove_model
    from podcast_mcp.engines.models.whisper import WHISPER_PINS

    folder = whisper_cache_dir() / f"models--{WHISPER_PINS['tiny.en'].hf_repo.replace('/', '--')}"
    blob = folder / "blobs" / "weights"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"w" * 100)
    snapshot = folder / "snapshots" / "fake" / "model.bin"
    snapshot.parent.mkdir(parents=True)
    snapshot.symlink_to(blob)

    assert remove_model("whisper", "tiny.en") == 100
    assert not folder.exists()


@pytest.mark.parametrize("location", ["inside", "outside"])
def test_remove_aligner_refuses_user_supplied_directory(tmp_path, monkeypatch, location):
    from podcast_mcp.config.defaults import word_aligner_cache_dir
    from podcast_mcp.engines.models import registry

    cache = word_aligner_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(registry, "word_aligner_cache_dir", lambda: cache)
    supplied = (cache if location == "inside" else tmp_path) / "supplied-aligner"
    supplied.mkdir()
    sentinel = supplied / "model.onnx"
    sentinel.write_bytes(b"user supplied synthetic weights")
    unrelated = cache / "unrelated-note.txt"
    unrelated.write_bytes(b"unrelated cache content")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(supplied))
    response = _client().delete("/api/bootstrap/models/word-aligner")
    assert sentinel.read_bytes() == b"user supplied synthetic weights"
    assert unrelated.read_bytes() == b"unrelated cache content"
    assert response.status_code == 409
    assert response.headers["X-Sharecut-Error-Code"] == "model_not_removable"


def test_remove_aligner_targets_only_its_downloaded_repository(tmp_path, monkeypatch):
    from podcast_mcp.config.defaults import word_aligner_cache_dir
    from podcast_mcp.engines.models import registry
    from podcast_mcp.engines.models.word_aligner import DEFAULT_WORD_ALIGNER, word_aligner_model

    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    cache = word_aligner_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(registry, "word_aligner_cache_dir", lambda: cache)
    model = word_aligner_model(DEFAULT_WORD_ALIGNER)
    target = cache / f"models--{model.hf_repo.replace('/', '--')}"
    target.mkdir()
    (target / "model.onnx").write_bytes(b"synthetic weights")
    other = cache / "unrelated-repository"
    other.mkdir()
    sentinel = other / "keep.txt"
    sentinel.write_bytes(b"unrelated")
    response = _client().delete("/api/bootstrap/models/word-aligner")
    assert response.status_code == 200
    assert response.json()["freed_bytes"] == len(b"synthetic weights")
    assert not target.exists()
    assert sentinel.read_bytes() == b"unrelated"


@pytest.mark.parametrize("linked", ["cache", "entry"])
@pytest.mark.parametrize("model_id", ["word-aligner", "whisper"])
def test_remove_model_refuses_linked_root_or_repository(tmp_path, monkeypatch, model_id, linked):
    from podcast_mcp.engines.models import registry
    from podcast_mcp.engines.models.whisper import WHISPER_PINS
    from podcast_mcp.engines.models.word_aligner import DEFAULT_WORD_ALIGNER, word_aligner_model

    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    repo = (
        WHISPER_PINS["tiny.en"].hf_repo
        if model_id == "whisper"
        else word_aligner_model(DEFAULT_WORD_ALIGNER).hf_repo
    )
    repository_name = f"models--{repo.replace('/', '--')}"
    outside = tmp_path / "outside"
    outside.mkdir()
    if linked == "cache":
        target = outside / repository_name
        target.mkdir()
        root = tmp_path / "linked-cache"
        root.symlink_to(outside, target_is_directory=True)
    else:
        target = outside
        root = tmp_path / "cache"
        root.mkdir()
        (root / repository_name).symlink_to(target, target_is_directory=True)
    sentinel = target / "weights"
    sentinel.write_bytes(b"synthetic external weights")
    monkeypatch.setattr(
        registry,
        "whisper_cache_dir" if model_id == "whisper" else "word_aligner_cache_dir",
        lambda: root,
    )
    response = _client().delete(
        f"/api/bootstrap/models/{model_id}",
        params={"whisper_model": "tiny.en"} if model_id == "whisper" else None,
    )
    assert response.status_code == 409
    assert response.headers["X-Sharecut-Error-Code"] == "model_not_removable"
    assert sentinel.read_bytes() == b"synthetic external weights"
    assert (root if linked == "cache" else root / repository_name).is_symlink()
