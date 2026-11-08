import json
import re
import threading

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.play_audit import premix_path
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import ChapterMarker, EpisodeProject, save_project
from podcast_mcp.project.io import RETIRED_PROJECT_FILENAME
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review_shares import create_share
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.pipeline import config_store
from podcast_mcp.services.pipeline import service as pipeline
from test_export_variant import (
    _canonical_snapshot,
    _current_mix,
    _FakeEngine,
    _seed_canonical_outputs,
)

POST = "/api/export/deliverables"
FILES = "/api/export/files"
STATUS = "/api/pipeline/status"
RELAYED = {"x-sharecut-relayed": "1"}
PROJECTION = {"id", "status", "current", "total", "message", "error"}


@pytest.fixture
def prepared(minimal_project, sample_wav, monkeypatch):
    ws = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    return ws, engine, sample_wav


def start(client, path, **body):
    res = client.post(POST, json={"path": str(path), **body})
    assert res.status_code == 200, res.text
    assert set(res.json()) == {"job_id", "job"}
    assert res.json()["job"]["id"] == res.json()["job_id"]
    return res.json()["job_id"]


def done(client, path, job_id):
    manager = client.app.state.jobs
    manager.wait(manager.get_job(job_id), timeout=5)
    res = client.get(STATUS, params={"path": str(path)})
    assert res.status_code == 200, res.text
    return next(job for job in res.json()["jobs"] if job["id"] == job_id)


def role_urls(ws):
    version = ws.project.review.versions[-1].id
    return {
        role: f"/api/review/{create_share(ws.project, review_version_id=version, capabilities=capabilities_for_role(role))['token']}/daw/export"
        for role in ("viewer", "commenter", "editor")
    }


def test_variant_route_round_trip_and_authority(prepared, monkeypatch):
    ws, engine, sample = prepared
    _seed_canonical_outputs(ws)
    guests = role_urls(ws)
    ws = ProjectWorkspace.open(ws.path)
    before = _canonical_snapshot(ws)
    client = TestClient(create_app(), client=("127.0.0.1", 61234))
    params = {"path": str(ws.path)}
    body = {**params, "target": "podcast", "formats": [{"ext": "wav"}]}
    assert client.post(POST, json=body, headers=RELAYED).status_code == 403
    for rejected in ("Broadcast", -16, "-16", "standard"):
        assert client.post(POST, json={**body, "target": rejected}).status_code == 422
    job_id = start(client, ws.path, target="podcast", formats=[{"ext": "wav"}])
    job = done(client, ws.path, job_id)
    assert job["status"] == "ok", job["error"]
    result = job["result"]
    assert set(result) == {"file_ids", "target", "master", "edit_head_id"}
    assert result["target"] == "podcast"
    assert result["edit_head_id"] == "preserve01"
    assert result["master"]["target"]["integrated_lufs"] == -16
    assert result["master"]["within_tolerance"] is True
    assert len(result["file_ids"]) == 1
    file_id = result["file_ids"][0]
    assert re.fullmatch(r"variants/[0-9a-f]{64}/audio\.wav", file_id)
    assert str(ws.path.parent) not in json.dumps(result)
    rows = client.get(FILES, params=params).json()["files"]
    variant = next(row for row in rows if row["id"] == file_id)
    assert variant["current"] is True
    assert variant["label"] == "Podcast (-16 LUFS) · WAV"
    assert variant["name"] == "audio.wav"
    assert str(ws.path.parent) not in json.dumps(rows)
    download_url = f"{FILES}/{file_id}"
    assert client.get(download_url, params=params).content == sample.read_bytes()
    ticket = variant["ticket"]
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "isolated-api-probe")
    remote = TestClient(client.app, client=("198.51.100.21", 61235))
    assert remote.get(download_url, params=params).status_code == 403
    assert (
        remote.get(download_url, params={**params, "ticket": ticket}).content == sample.read_bytes()
    )
    assert (
        remote.get(download_url, params={**params, "ticket": ticket}, headers=RELAYED).status_code
        == 403
    )
    bundle = ws.project.export_dir() / file_id.rsplit("/", 1)[0]
    (bundle / "unlisted.wav").write_bytes(b"private unlisted payload")
    for name in ("master.wav", "receipt.json", "master_qc.json", "unlisted.wav"):
        unlisted = f"{file_id.rsplit('/', 1)[0]}/{name}"
        assert client.get(f"{FILES}/{unlisted}", params=params).status_code == 404
        assert (
            remote.get(f"{FILES}/{unlisted}", params={**params, "ticket": ticket}).status_code
            == 403
        )
        assert client.get(f"{guests['editor']}/files/{unlisted}").status_code == 404
    for role in ("viewer", "commenter"):
        assert client.get(f"{guests[role]}/files").status_code == 403
        assert client.get(f"{guests[role]}/files/{file_id}").status_code == 403
    editor = client.get(f"{guests['editor']}/files")
    assert editor.status_code == 200
    row = next(row for row in editor.json()["files"] if row["id"] == file_id)
    assert "ticket" not in row
    assert str(ws.path.parent) not in editor.text
    assert client.get(f"{guests['editor']}/files/{file_id}").content == sample.read_bytes()
    guest_job = client.get(f"{guests['editor']}/jobs/{job_id}")
    assert guest_job.status_code == 200, guest_job.text
    assert set(guest_job.json()["job"]) == PROJECTION
    assert str(ws.path.parent) not in guest_job.text
    revealed = []
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.export_files.reveal_in_file_manager",
        lambda path: revealed.append(path) or True,
    )
    reveal = client.post(f"{FILES}/reveal", json={**params, "id": file_id})
    assert reveal.json() == {"revealed": True}
    assert revealed == [bundle / "audio.wav"]
    assert _canonical_snapshot(ws) == before
    assert engine.master_targets == [-16]


def test_completed_variant_currentness_is_optional_for_saved_bundle(
    prepared, tmp_path, monkeypatch
):
    ws, engine, _ = prepared
    client = TestClient(create_app(), raise_server_exceptions=False)
    job_id = start(client, ws.path, target="podcast", formats=[{"ext": "wav"}])
    generated = done(client, ws.path, job_id)
    assert generated["status"] == "ok", generated["error"]
    file_id = generated["result"]["file_ids"][0]
    bundle = (ws.project.export_dir() / file_id).parent
    receipt = bundle / "receipt.json"
    before = receipt.read_bytes()
    params = {"path": str(ws.path)}
    invalid = tmp_path / "invalid-defaults.yaml"
    invalid.write_text("master: [\n", encoding="utf-8")

    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(invalid))
    stale_rows = client.get(FILES, params=params)
    download = client.get(f"{FILES}/{file_id}", params=params)
    assert stale_rows.status_code == 200
    stale = next(row for row in stale_rows.json()["files"] if row["id"] == file_id)
    assert stale["current"] is False
    assert (download.status_code, download.content) == (200, (bundle / "audio.wav").read_bytes())

    monkeypatch.delenv("PODCAST_MCP_PIPELINE_DEFAULTS")
    current_rows = client.get(FILES, params=params)
    current = next(row for row in current_rows.json()["files"] if row["id"] == file_id)
    assert current["current"] is True
    assert receipt.read_bytes() == before
    assert engine.master_calls == 1


def test_variant_inventory_does_not_load_config_without_admitted_audio(prepared):
    from podcast_mcp.services.pipeline.export_variant import completed_variant_files

    ws, _, _ = prepared
    calls = []

    assert completed_variant_files(ws.project, load_config=lambda: calls.append(True)) == ()
    assert calls == []


def test_named_generation_does_not_use_fallback_config(prepared, tmp_path, monkeypatch):
    ws, engine, _ = prepared
    invalid = tmp_path / "invalid-defaults.yaml"
    invalid.write_text("master: [\n", encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(invalid))
    client = TestClient(create_app())

    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[]))

    assert job["status"] == "error"
    assert job["result"] is None
    assert engine.master_calls == 0
    assert not (ws.project.export_dir() / "variants").exists()


def test_absence_and_null_keep_canonical_adoption_and_config(prepared, monkeypatch):
    ws, _, _ = prepared
    client = TestClient(create_app())
    from podcast_mcp.services.pipeline import AudioExportResult

    calls = []

    def canonical(self, formats, *, cancel_check):
        configured = self._run_defaults()["master"]["integrated_lufs"]
        calls.append((self.ws.path.name, formats, configured))
        path = self.ws.project.export_dir() / "test_episode.wav"
        return AudioExportResult([path], {"target_integrated_lufs": configured}, "before")

    monkeypatch.setattr(pipeline.PipelineService, "export_audio", canonical)
    retired = ws.path.with_name(RETIRED_PROJECT_FILENAME)
    ws.path.rename(retired)
    config_store().put(
        ws.path, config={"master": {"integrated_lufs": -19}}, enabled_steps=None, unattended=True
    )
    target = done(client, retired, start(client, retired, target="broadcast", formats=[]))
    assert target["status"] == "ok", target["error"]
    assert retired.exists() and not ws.path.exists()
    assert not calls
    for args in ({}, {"target": None}):
        path = retired if retired.exists() else ws.path
        job = done(client, path, start(client, path, **args))
        assert job["status"] == "ok", job["error"]
        assert job["result"] == {
            "paths": [str(ws.project.export_dir() / "test_episode.wav")],
            "master": {"target_integrated_lufs": -19},
            "edit_head_id": "before",
        }
    assert calls == [("episode.sharecut", None, -19), ("episode.sharecut", None, -19)]
    assert ws.path.exists() and not retired.exists()


def test_qc_terminal_error_preserves_requested_and_measured_peak(prepared):
    ws, engine, _ = prepared
    engine.qc = {"integrated_lufs": -19.3, "true_peak_db": -0.1}
    client = TestClient(create_app())
    job = done(client, ws.path, start(client, ws.path, target="streaming", formats=[]))
    assert job["status"] == "error"
    assert job["error_code"] == "export_variant_qc_failed"
    assert job["result"] is None
    assert not list((ws.project.export_dir() / "variants").iterdir())
    assert str(ws.path.parent) not in job["error"]
    assert "measured -19.3 LUFS and -0.1 dBTP" in job["error"]
    assert "Requested -14 LUFS" in job["error"]
    assert "No variant was published." in job["error"]
    assert len(job["error"]) <= 200


def test_malformed_bundle_does_not_hide_canonical_files(prepared):
    ws, _, sample = prepared
    output = ws.project.export_dir() / "test_episode.wav"
    output.write_bytes(sample.read_bytes())
    client = TestClient(create_app(), raise_server_exceptions=False)
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[]))
    assert job["status"] == "ok"
    file_id = job["result"]["file_ids"][0]
    receipt = (ws.project.export_dir() / file_id).with_name("receipt.json")
    record = json.loads(receipt.read_text())
    record["formats"] = [[]]
    receipt.write_text(json.dumps(record))
    files = client.get(FILES, params={"path": str(ws.path)})
    canonical = client.get(f"{FILES}/test_episode.wav", params={"path": str(ws.path)})
    cached = done(client, ws.path, start(client, ws.path, target="podcast", formats=[]))
    assert (files.status_code, canonical.status_code, cached["error_code"]) == (
        200,
        200,
        "export_variant_cache_corrupt",
    )
    assert canonical.content == sample.read_bytes()
    assert all(row["id"] != file_id for row in files.json()["files"])


@pytest.mark.parametrize("field,value", [("qc.plan", "bad\ud800"), ("qc.measured.bad\ud800", 1.0)])
def test_malformed_unicode_receipt_is_skipped_and_cache_refused(prepared, field, value):
    import hashlib

    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util.coded_error import CodedValueError

    ws, _, sample = prepared
    (ws.project.export_dir() / "test_episode.wav").write_bytes(sample.read_bytes())
    service = PipelineService(ws)
    result = service.export_variant(ExportTarget.PODCAST, formats=[])
    receipt_path = (ws.project.export_dir() / result.file_ids[0]).with_name("receipt.json")
    record = json.loads(receipt_path.read_text())
    if field == "qc.plan":
        record["qc"]["plan"] = value
    else:
        record["qc"]["measured"]["bad\ud800"] = value
    sidecar = receipt_path.with_name("master_qc.json")
    sidecar.write_text(json.dumps(record["qc"]))
    sidecar_bytes = sidecar.read_bytes()
    record["files"]["master_qc.json"] = {
        "size": len(sidecar_bytes),
        "sha256": hashlib.sha256(sidecar_bytes).hexdigest(),
    }
    receipt_path.write_text(json.dumps(record))

    with pytest.raises(CodedValueError) as caught:
        service.export_variant(ExportTarget.PODCAST, formats=[])
    assert caught.value.code == "export_variant_cache_corrupt"
    assert result.file_ids[0] not in {row.id for row in ExportFilesService(ws).list()}


def test_receipt_admission_preserves_valid_unicode(prepared):
    import hashlib

    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline.export_variant_receipt import admit_bundle

    ws, _, sample = prepared
    (ws.project.export_dir() / "test_episode.wav").write_bytes(sample.read_bytes())
    result = PipelineService(ws).export_variant(ExportTarget.PODCAST, formats=[])
    receipt_path = (ws.project.export_dir() / result.file_ids[0]).with_name("receipt.json")
    record = json.loads(receipt_path.read_text())
    record["qc"]["plan"] = "loudnorm café 🎙"
    record["qc"]["measured"]["測定"] = record["qc"]["measured"].pop("lra")
    sidecar = receipt_path.with_name("master_qc.json")
    sidecar.write_text(json.dumps(record["qc"], ensure_ascii=False))
    sidecar_bytes = sidecar.read_bytes()
    record["files"]["master_qc.json"] = {
        "size": len(sidecar_bytes),
        "sha256": hashlib.sha256(sidecar_bytes).hexdigest(),
    }
    receipt_path.write_text(json.dumps(record, ensure_ascii=False))
    admitted = admit_bundle(receipt_path.parent, result.file_ids[0].split("/")[1])
    assert admitted.qc.plan == "loudnorm café 🎙"


@pytest.mark.parametrize("option", [{"channels": 3}, {"sample_rate": 48001}])
def test_mp3_encoder_constraints_refuse_before_mastering(prepared, option):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util.coded_error import CodedValueError

    ws, engine, _ = prepared
    with pytest.raises(CodedValueError) as caught:
        PipelineService(ws).export_variant(ExportTarget.PODCAST, formats=[{"ext": "mp3", **option}])
    assert caught.value.code == "export_variant_format_invalid"
    assert engine.master_calls == 0


def test_conflicting_format_alias_cannot_bypass_raw_field_validation(prepared):
    ws, engine, _ = prepared
    client = TestClient(create_app())
    specs = [{"ext": None, "extension": "flac", "dest": "/synthetic/untrusted-output.flac"}]
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=specs))
    assert (job["status"], job["error_code"], engine.master_calls) == (
        "error",
        "export_variant_format_invalid",
        0,
    )


def test_cache_hit_reports_current_request_edit_head(prepared):
    ws, engine, _ = prepared
    client = TestClient(create_app())
    first = done(client, ws.path, start(client, ws.path, target="podcast", formats=[]))
    assert first["status"] == "ok", first["error"]
    assert first["result"]["edit_head_id"] == "root"
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate(
            "Before chapter",
            "Add chapter",
            lambda project: project.chapters.append(ChapterMarker(time=0, title="Opening")),
        )
    receipt_path = (ws.project.export_dir() / first["result"]["file_ids"][0]).with_name(
        "receipt.json"
    )
    generation_receipt = receipt_path.read_bytes()
    current_head = ProjectWorkspace.open(ws.path).project.history.edit_head_id()
    assert current_head != "root"
    second = done(client, ws.path, start(client, ws.path, target="podcast", formats=[]))
    assert second["status"] == "ok", second["error"]
    assert first["result"]["file_ids"] == second["result"]["file_ids"]
    assert engine.master_calls == 1
    assert second["result"]["edit_head_id"] == current_head
    assert receipt_path.read_bytes() == generation_receipt
    assert json.loads(generation_receipt)["edit_head_id"] == "root"


def test_missing_encoder_output_is_a_coded_refusal(sample_wav, tmp_path, monkeypatch):
    project = EpisodeProject.create("test_episode", str(tmp_path / "isolated audit media folder"))
    project.ensure_dirs()
    ws = _current_mix(save_project(project), sample_wav)
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    monkeypatch.setattr(engine, "export_audio", lambda *args, **kwargs: None)
    client = TestClient(create_app())
    job = done(
        client, ws.path, start(client, ws.path, target="broadcast", formats=[{"ext": "flac"}])
    )
    assert job["status"] == "error" and job["result"] is None
    assert not list((ws.project.export_dir() / "variants").iterdir())
    assert (job["error_code"], "audit media folder" in job["error"]) == (
        "export_variant_unmeasured",
        False,
    )


def test_cache_receipt_rejects_untyped_edit_head(prepared):
    ws, _, _ = prepared
    client = TestClient(create_app())
    first = done(client, ws.path, start(client, ws.path, target="broadcast", formats=[]))
    assert first["status"] == "ok", first["error"]
    file_id = first["result"]["file_ids"][0]
    receipt = (ws.project.export_dir() / file_id).with_name("receipt.json")
    record = json.loads(receipt.read_text())
    record["edit_head_id"] = {"host_path": str(ws.path)}
    receipt.write_text(json.dumps(record))
    job = done(client, ws.path, start(client, ws.path, target="broadcast", formats=[]))
    assert (job["status"], job["error_code"], job["result"]) == (
        "error",
        "export_variant_cache_corrupt",
        None,
    )


def test_cache_refuses_bundle_with_consistent_failed_qc(prepared):
    from hashlib import sha256

    from podcast_mcp.engines.mastering import MasterQcLimits, MasterTarget, master_qc_issues

    ws, _, _ = prepared
    client = TestClient(create_app())
    first = done(client, ws.path, start(client, ws.path, target="broadcast", formats=[]))
    assert first["status"] == "ok", first["error"]
    file_id = first["result"]["file_ids"][0]
    bundle = (ws.project.export_dir() / file_id).parent
    receipt = bundle / "receipt.json"
    record = json.loads(receipt.read_text())
    qc = record["qc"]
    qc["measured"]["integrated_lufs"] = -36.0
    qc["issues"] = master_qc_issues(
        qc["measured"], MasterTarget(**qc["target"]), MasterQcLimits(**qc["limits"]), qc["limiter"]
    )
    assert qc["issues"]
    qc["within_tolerance"] = False
    qc_bytes = json.dumps(qc).encode()
    (bundle / "master_qc.json").write_bytes(qc_bytes)
    record["files"]["master_qc.json"] = {
        "size": len(qc_bytes),
        "sha256": sha256(qc_bytes).hexdigest(),
    }
    receipt.write_text(json.dumps(record))
    download = client.get(f"{FILES}/{file_id}", params={"path": str(ws.path)})
    job = done(client, ws.path, start(client, ws.path, target="broadcast", formats=[]))
    assert (download.status_code, job["status"], job["error_code"]) == (
        404,
        "error",
        "export_variant_cache_corrupt",
    )


def test_cache_refuses_noncanonical_receipt_file_id(prepared):
    ws, _, _ = prepared
    client = TestClient(create_app())
    first = done(client, ws.path, start(client, ws.path, target="broadcast", formats=[]))
    assert first["status"] == "ok", first["error"]
    file_id = first["result"]["file_ids"][0]
    receipt = (ws.project.export_dir() / file_id).with_name("receipt.json")
    record = json.loads(receipt.read_text())
    record["formats"][0]["ext"] = "WAV"
    receipt.write_text(json.dumps(record))
    job = done(client, ws.path, start(client, ws.path, target="broadcast", formats=[]))
    assert (job["status"], job["error_code"], job["result"]) == (
        "error",
        "export_variant_cache_corrupt",
        None,
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("premix_sha256", "0" * 64),
        ("measured", 10**400),
        ("input_stats", 1),
    ],
)
def test_corrupt_source_and_numbers_preserve_canonical_access(prepared, field, value):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util.coded_error import CodedFileNotFoundError, CodedValueError

    ws, engine, _ = prepared
    _seed_canonical_outputs(ws)
    before = _canonical_snapshot(ws)
    service = PipelineService(ws)
    result = service.export_variant(ExportTarget.PODCAST, formats=[])
    receipt = (ws.project.export_dir() / result.file_ids[0]).with_name("receipt.json")
    record = json.loads(receipt.read_text())
    if field == "premix_sha256":
        record["source"][field] = value
    elif field == "measured":
        record["qc"][field]["integrated_lufs"] = value
    else:
        record["qc"][field] = value
    receipt.write_text(json.dumps(record))
    files = ExportFilesService(ws)
    assert result.file_ids[0] not in {item.id for item in files.list()}
    assert (
        files.open("test_episode.wav").path.read_bytes()
        == before[ws.project.export_dir() / "test_episode.wav"]
    )
    with pytest.raises(CodedFileNotFoundError):
        files.open(result.file_ids[0])
    with pytest.raises(CodedValueError) as caught:
        service.export_variant(ExportTarget.PODCAST, formats=[])
    assert caught.value.code == "export_variant_cache_corrupt"
    assert engine.master_calls == 1
    assert _canonical_snapshot(ws) == before


@pytest.mark.parametrize("replacement", ["symlink", "directory"])
def test_swapped_parent_preserves_unowned_stage(prepared, monkeypatch, tmp_path, replacement):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util.coded_error import CodedValueError

    ws, engine, _ = prepared
    _seed_canonical_outputs(ws)
    before = _canonical_snapshot(ws)
    retained = tmp_path / "retained-owned-parent"
    outside = tmp_path / "unowned-parent"
    outside.mkdir()
    markers = []
    master = engine.master_loudness

    def swap(source, output, **kwargs):
        result = master(source, output, **kwargs)
        root = output.parent.parent
        root.rename(retained)
        if replacement == "symlink":
            root.symlink_to(outside, target_is_directory=True)
        else:
            root.mkdir()
        substitute = root / output.parent.name
        substitute.mkdir()
        marker = substitute / "keep"
        marker.write_bytes(b"unowned")
        markers.append(marker)
        return result

    monkeypatch.setattr(engine, "master_loudness", swap)
    with pytest.raises(CodedValueError):
        PipelineService(ws).export_variant(ExportTarget.PODCAST, formats=[])
    assert all(marker.read_bytes() == b"unowned" for marker in markers)
    assert _canonical_snapshot(ws) == before


def test_platform_refusal_preserves_default_exports(prepared, monkeypatch):
    import sys

    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.owned_stage import owned_stage_supported

    ws, engine, _ = prepared
    _seed_canonical_outputs(ws)
    before = _canonical_snapshot(ws)
    if sys.platform == "win32":
        assert not owned_stage_supported()
    else:
        assert owned_stage_supported()
        monkeypatch.setattr(service_module, "owned_stage_supported", lambda: False)
    client = TestClient(create_app())
    job = done(client, ws.path, start(client, ws.path, target="broadcast", formats=[]))
    assert job["status"] == "error"
    assert job["error_code"] == "export_variant_storage_invalid"
    assert engine.master_calls == 0
    assert not (ws.project.export_dir() / "variants").exists()
    assert (
        client.get(f"{FILES}/test_episode.wav", params={"path": str(ws.path)}).content
        == before[ws.project.export_dir() / "test_episode.wav"]
    )
    assert _canonical_snapshot(ws) == before


def test_platform_refusal_precedes_ffmpeg_construction(prepared, monkeypatch):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    ws, _, _ = prepared
    monkeypatch.setattr(service_module, "owned_stage_supported", lambda: False)
    calls = []

    def construct_engine():
        calls.append("ffmpeg")
        raise RuntimeError("engine construction must not run")

    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", construct_engine)
    with pytest.raises(CodedValueError) as caught:
        PipelineService(ws).export_variant(ExportTarget.PODCAST, formats=[])
    assert caught.value.code == "export_variant_storage_invalid"
    assert calls == []
    assert not (ws.project.export_dir() / "variants").exists()


@pytest.mark.parametrize(
    "field,value",
    [
        (("qc", "measured", "lra"), True),
        (("qc", "measured", "lra"), "7"),
        (("qc", "measured", "lra"), float("inf")),
        (("qc", "input_stats"), {"unknown": 10**400}),
        (("qc", "plan"), {}),
        (("qc", "normalization_type"), 1),
        (("qc", "limiter"), {"converged": True}),
        (("edit_head_id",), True),
        (("schema",), True),
        (("formats",), [[]]),
        (("formats",), [None]),
        (("source", "premix_revision"), [1, 2, True, 4]),
        (("source", "mix_gains"), [["host", True]]),
        (("master_target", "lra"), 10**400),
        (("qc_limits", "lufs_tolerance_lu"), False),
    ],
)
def test_nested_receipt_corruption_has_one_public_boundary(prepared, field, value):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util.coded_error import CodedValueError

    ws, engine, _ = prepared
    _seed_canonical_outputs(ws)
    before = _canonical_snapshot(ws)
    service = PipelineService(ws)
    result = service.export_variant(ExportTarget.PODCAST, formats=[])
    path = (ws.project.export_dir() / result.file_ids[0]).with_name("receipt.json")
    receipt = json.loads(path.read_text())
    cursor = receipt
    for key in field[:-1]:
        cursor = cursor[key]
    cursor[field[-1]] = value
    path.write_text(json.dumps(receipt))
    files = ExportFilesService(ws)
    assert result.file_ids[0] not in {row.id for row in files.list()}
    assert (
        files.open("test_episode.wav").path.read_bytes()
        == before[ws.project.export_dir() / "test_episode.wav"]
    )
    with pytest.raises(CodedValueError) as caught:
        service.export_variant(ExportTarget.PODCAST, formats=[])
    assert caught.value.code == "export_variant_cache_corrupt"
    assert engine.master_calls == 1
    assert _canonical_snapshot(ws) == before


@pytest.mark.parametrize("damage", ["missing", "empty", "directory", "symlink", "encoder_error"])
def test_output_failures_are_path_free_and_retryable(prepared, monkeypatch, damage):
    import subprocess

    ws, engine, sample = prepared
    _seed_canonical_outputs(ws)
    before = _canonical_snapshot(ws)
    encode = engine.export_audio

    def broken(source, output, **kwargs):
        if damage == "empty":
            output.write_bytes(b"")
        elif damage == "directory":
            output.mkdir()
        elif damage == "symlink":
            output.symlink_to(sample)
        elif damage == "encoder_error":
            raise subprocess.CalledProcessError(1, ["ffmpeg", str(output)], stderr=str(ws.path))

    client = TestClient(create_app())
    monkeypatch.setattr(engine, "export_audio", broken)
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "flac"}]))
    assert job["status"] == "error" and job["result"] is None
    assert job["error_code"] == "export_variant_unmeasured"
    assert str(ws.path) not in job["error"] and "audio.flac" not in job["error"]
    assert not list((ws.project.export_dir() / "variants").iterdir())
    monkeypatch.setattr(engine, "export_audio", encode)
    retry = done(
        client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "flac"}])
    )
    assert retry["status"] == "ok"
    assert _canonical_snapshot(ws) == before


@pytest.mark.parametrize("at_move", [False, True])
def test_stage_substitution_is_preserved(prepared, monkeypatch, at_move):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util import owned_stage
    from podcast_mcp.util.coded_error import CodedValueError

    ws, engine, _ = prepared
    markers = []
    original_master = engine.master_loudness
    rename = owned_stage.rename_noreplace

    def substitute(path):
        path.rename(path.with_name("retained-owned-stage"))
        path.mkdir()
        marker = path / "unowned"
        marker.write_bytes(b"preserve")
        markers.append(marker)

    def fail(source, output, **kwargs):
        original_master(source, output, **kwargs)
        if not at_move:
            substitute(output.parent)
        raise RuntimeError("private encoder failure")

    def moving(src, dst, root_fd, **kwargs):
        if dst == "stage":
            substitute(ws.project.export_dir() / "variants" / src)
        return rename(src, dst, root_fd, **kwargs)

    monkeypatch.setattr(engine, "master_loudness", fail)
    if at_move:
        monkeypatch.setattr(owned_stage, "rename_noreplace", moving)
    with pytest.raises(CodedValueError) as caught:
        PipelineService(ws).export_variant(ExportTarget.PODCAST, formats=[])
    assert caught.value.code == "export_variant_unmeasured"
    assert all(path.read_bytes() == b"preserve" for path in markers)
    assert (ws.project.export_dir() / "variants/retained-owned-stage/master.wav").is_file()


def test_post_commit_sync_failure_preserves_published_bundle(prepared, monkeypatch):
    import os

    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util import owned_stage
    from podcast_mcp.util.coded_error import CodedValueError

    ws, _, _ = prepared
    sync = os.fsync
    rename = owned_stage.rename_noreplace
    committed = False

    def publish(*args, **kwargs):
        nonlocal committed
        rename(*args, **kwargs)
        committed = True

    def fail_sync(fd):
        if committed:
            raise OSError("sync failure")
        sync(fd)

    monkeypatch.setattr(owned_stage, "rename_noreplace", publish)
    monkeypatch.setattr(os, "fsync", fail_sync)
    with pytest.raises(CodedValueError) as caught:
        PipelineService(ws).export_variant(ExportTarget.PODCAST, formats=[])
    assert caught.value.code == "export_variant_storage_invalid"
    assert "No variant was published" not in str(caught.value)
    rows = ExportFilesService(ws).list()
    assert len(rows) == 1
    assert ExportFilesService(ws).open(rows[0].id).path.is_file()


def test_cleanup_failure_preserves_primary_refusal(prepared, monkeypatch):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util import owned_stage
    from podcast_mcp.util.coded_error import CodedValueError

    ws, engine, _ = prepared
    engine.qc = {"integrated_lufs": -40.0, "true_peak_db": -2.0}

    def refuse(*args, **kwargs):
        raise OSError("cleanup failed")

    monkeypatch.setattr(owned_stage, "rename_noreplace", refuse)
    with pytest.raises(CodedValueError) as caught:
        PipelineService(ws).export_variant(ExportTarget.PODCAST, formats=[])
    assert caught.value.code == "export_variant_qc_failed"
    assert all(
        path.name.startswith(".") for path in (ws.project.export_dir() / "variants").iterdir()
    )


@pytest.mark.parametrize("moment", ["before_commit", "after_commit"])
def test_cancel_job_publication_boundary(prepared, monkeypatch, moment):
    from podcast_mcp.services.pipeline import export_variant

    ws, engine, _ = prepared
    entered, release = threading.Event(), threading.Event()

    def hold():
        entered.set()
        assert release.wait(5), "fixture did not release gated export"

    if moment == "before_commit":
        encode = engine.export_audio

        def paused_encode(*args, **kwargs):
            encode(*args, **kwargs)
            hold()

        monkeypatch.setattr(engine, "export_audio", paused_encode)
    else:
        publish = export_variant._publish

        def paused_publish(*args):
            publish(*args)
            hold()

        monkeypatch.setattr(export_variant, "_publish", paused_publish)
    client = TestClient(create_app())
    job_id = start(client, ws.path, target="broadcast", formats=[{"ext": "flac"}])
    try:
        assert entered.wait(5)
        res = client.post("/api/pipeline/cancel", json={"job_id": job_id})
        assert res.status_code == 200, res.text
    finally:
        release.set()
    job = done(client, ws.path, job_id)
    assert job["status"] == "cancelled"
    root = ws.project.export_dir() / "variants"
    if moment == "before_commit":
        assert job["result"] is None and not list(root.iterdir())
    else:
        assert job["result"]["target"] == "broadcast"
        assert all((ws.project.export_dir() / item).is_file() for item in job["result"]["file_ids"])
        assert all(not p.name.startswith(".partial-") for p in root.iterdir())


@pytest.mark.parametrize(
    "raw",
    [
        '{"schema":1,"schema":1}',
        '{"qc":NaN}',
        "[" * 1100 + "]" * 1100,
        '{"schema":' + "9" * 5000 + "}",
    ],
)
def test_malformed_json_cannot_break_canonical_inventory(prepared, raw):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util.coded_error import CodedValueError

    ws, engine, _ = prepared
    _seed_canonical_outputs(ws)
    service = PipelineService(ws)
    result = service.export_variant(ExportTarget.PODCAST, formats=[])
    receipt = (ws.project.export_dir() / result.file_ids[0]).with_name("receipt.json")
    receipt.write_text(raw)
    files = ExportFilesService(ws)
    assert result.file_ids[0] not in {row.id for row in files.list()}
    assert files.open("test_episode.wav").path.read_bytes() == b"canonical artifact 5"
    with pytest.raises(CodedValueError) as caught:
        service.export_variant(ExportTarget.PODCAST, formats=[])
    assert caught.value.code == "export_variant_cache_corrupt"
    assert engine.master_calls == 1


def test_mapping_producer_roundtrips_unknown_plan_and_stats(prepared, monkeypatch):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService

    ws, engine, _ = prepared
    original = engine.master_loudness

    def master(*args, **kwargs):
        original(*args, **kwargs)
        return {"input_stats": {"producer_extension": 3.25}, "normalization_type": "producer-mode"}

    monkeypatch.setattr(engine, "master_loudness", master)
    service = PipelineService(ws)
    first = service.export_variant(ExportTarget.BROADCAST, formats=[])
    second = service.export_variant(ExportTarget.BROADCAST, formats=[])
    assert second == first
    assert second.master.plan == "unknown"
    assert second.master.input_stats == {"producer_extension": 3.25}
    assert second.master.normalization_type == "producer-mode"
    assert engine.master_calls == 1
    assert all(ExportFilesService(ws).open(file_id).path.is_file() for file_id in second.file_ids)
