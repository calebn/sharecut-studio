import hashlib
import json
import os
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


@pytest.mark.parametrize("invalid_yaml", ["master: [\n", "- master\n"])
def test_completed_variant_currentness_is_optional_for_saved_bundle(
    prepared, tmp_path, monkeypatch, invalid_yaml
):
    ws, engine, _ = prepared
    _seed_canonical_outputs(ws)
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
    invalid.write_text(invalid_yaml, encoding="utf-8")

    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(invalid))
    stale_rows = client.get(FILES, params=params)
    download = client.get(f"{FILES}/{file_id}", params=params)
    assert stale_rows.status_code == 200
    stale_files = {row["id"]: row for row in stale_rows.json()["files"]}
    assert {"test_episode.wav", file_id} <= stale_files.keys()
    stale = stale_files[file_id]
    assert stale["current"] is False
    assert (download.status_code, download.content) == (200, (bundle / "audio.wav").read_bytes())
    assert client.get(f"{FILES}/test_episode.wav", params=params).content == (
        b"canonical artifact 5"
    )

    monkeypatch.delenv("PODCAST_MCP_PIPELINE_DEFAULTS")
    current_rows = client.get(FILES, params=params)
    current = next(row for row in current_rows.json()["files"] if row["id"] == file_id)
    assert current["current"] is True

    premix = premix_path(ws.project)
    unavailable = premix.with_name("premix.saved-for-inventory-test.wav")
    premix.rename(unavailable)
    try:
        unavailable_rows = client.get(FILES, params=params)
        unavailable_files = {row["id"]: row for row in unavailable_rows.json()["files"]}
        assert unavailable_rows.status_code == 200
        assert {"test_episode.wav", file_id} <= unavailable_files.keys()
        assert unavailable_files[file_id]["current"] is False
        assert (
            client.get(f"{FILES}/{file_id}", params=params).content
            == (bundle / "audio.wav").read_bytes()
        )
        assert (
            client.get(f"{FILES}/test_episode.wav", params=params).content
            == b"canonical artifact 5"
        )
    finally:
        unavailable.rename(premix)

    recovered_rows = client.get(FILES, params=params)
    recovered = next(row for row in recovered_rows.json()["files"] if row["id"] == file_id)
    assert recovered["current"] is True
    assert receipt.read_bytes() == before
    assert engine.master_calls == 1


def test_variant_inventory_does_not_load_config_without_admitted_audio(prepared):
    from podcast_mcp.services.pipeline.export_variant import completed_variant_files

    ws, _, _ = prepared
    assert completed_variant_files(ws.project) == ()


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


@pytest.fixture
def saved_bundle(prepared):
    from podcast_mcp.models import Transcript, TranscriptWord
    from podcast_mcp.services.document import TranscriptService

    ws, engine, sample = prepared

    def add_words(project):
        project.transcripts = [
            Transcript(
                track_id="host",
                words=[TranscriptWord(text="Hello.", start=0.0, end=0.5)],
            )
        ]

    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate("before transcript", "after transcript", add_words)
        TranscriptService(ws).export(["md", "srt"])
    canonical = ws.project.export_dir() / "test_episode.wav"
    canonical.write_bytes(sample.read_bytes())
    client = TestClient(create_app(), client=("127.0.0.1", 61234), raise_server_exceptions=False)
    generated = done(
        client,
        ws.path,
        start(client, ws.path, target="podcast", formats=[{"ext": "wav"}]),
    )
    assert generated["status"] == "ok", generated["error"]
    file_id = generated["result"]["file_ids"][0]
    listed = client.get(FILES, params={"path": str(ws.path)})
    assert listed.status_code == 200
    rows = {row["id"]: row for row in listed.json()["files"]}
    assert set(rows) == {"test_episode.wav", "test_episode.md", "test_episode.srt", file_id}
    assert all(row["current"] for row in rows.values())
    return ws, engine, client, rows, file_id


@pytest.mark.parametrize(
    "payload,transcript_current",
    [
        (b'custom: !!int ""\n', False),
        (b"custom: !!bool banana\n", False),
        (b"custom: !!timestamp invalid\n", False),
        (b"mix: [invalid]\n", True),
        (b"mix: {premix_peak_ceiling_db: []}\n", True),
        (b"master: [\n", False),
        (b"- master\n", False),
        (b"created_at: 2026-99-99\n", False),
        (b"custom: \xff\n", False),
    ],
    ids=[
        "empty-int",
        "bad-bool",
        "bad-timestamp",
        "mix-list",
        "mix-leaf",
        "syntax",
        "root",
        "date",
        "utf8",
    ],
)
def test_saved_bundle_config_failure_preserves_all_tickets(
    saved_bundle, tmp_path, monkeypatch, payload, transcript_current
):
    import yaml

    from podcast_mcp.config.defaults import bundled_defaults
    from podcast_mcp.services.pipeline.export_variant import _source_certificate

    ws, engine, client, rows, file_id = saved_bundle
    params = {"path": str(ws.path)}
    expected = {name: (ws.project.export_dir() / name).read_bytes() for name in rows}
    receipt_path = (ws.project.export_dir() / file_id).parent / "receipt.json"
    receipt = receipt_path.read_bytes()
    source_digest = json.loads(receipt)["source_digest"]
    assert _source_certificate(ws.project, ws.effective_config()).digest == source_digest
    canonical_before = _canonical_snapshot(ws)
    bundle_ids = {path.name for path in receipt_path.parent.parent.iterdir()}
    valid = yaml.safe_dump(bundled_defaults()).encode()
    override = tmp_path / "defaults.yaml"
    override.write_bytes(valid)
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(override))
    remote = TestClient(client.app, client=("198.51.100.21", 61235), raise_server_exceptions=False)
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "isolated-config-regression")
    override.write_bytes(payload)
    listed = client.get(FILES, params=params)
    downloads = {
        name: remote.get(f"{FILES}/{name}", params={**params, "ticket": row["ticket"]})
        for name, row in rows.items()
    }
    failed = done(
        client,
        ws.path,
        start(client, ws.path, target="broadcast", formats=[{"ext": "wav"}]),
    )
    assert failed["status"] == "error", failed
    assert failed["result"] is None
    assert {path.name for path in receipt_path.parent.parent.iterdir()} == bundle_ids
    assert engine.master_targets == [-16]
    override.write_bytes(valid)
    restored = client.get(FILES, params=params)
    assert restored.status_code == 200
    recovered = {row["id"]: row for row in restored.json()["files"]}
    assert set(recovered) == set(rows)
    assert all(row["current"] for row in recovered.values())
    for name, row in rows.items():
        response = remote.get(f"{FILES}/{name}", params={**params, "ticket": row["ticket"]})
        assert (response.status_code, response.content) == (200, expected[name])
    assert receipt_path.read_bytes() == receipt
    assert _source_certificate(ws.project, ws.effective_config()).digest == source_digest
    assert _canonical_snapshot(ws) == canonical_before
    observed = {
        "list": listed.status_code,
        "tickets": {name: res.status_code for name, res in downloads.items()},
    }
    print(json.dumps(observed, sort_keys=True))
    assert observed == {"list": 200, "tickets": dict.fromkeys(rows, 200)}
    invalid_rows = {row["id"]: row for row in listed.json()["files"]}
    assert set(invalid_rows) == set(rows)
    assert invalid_rows["test_episode.wav"]["current"] is True
    assert invalid_rows[file_id]["current"] is False
    for name in ("test_episode.md", "test_episode.srt"):
        assert invalid_rows[name]["current"] is transcript_current
    assert {name: response.content for name, response in downloads.items()} == expected
    print(
        json.dumps(
            {
                "payload": payload.decode("utf-8", errors="backslashreplace"),
                "source_digest": source_digest,
                "source_current": invalid_rows[file_id]["current"],
                "transcript_current": invalid_rows["test_episode.md"]["current"],
                "canonical_current": invalid_rows["test_episode.wav"]["current"],
                "restored_current": all(row["current"] for row in recovered.values()),
                "receipt_unchanged": receipt_path.read_bytes() == receipt,
                "canonical_unchanged": _canonical_snapshot(ws) == canonical_before,
                "saved_ticket_bytes_equal": True,
                "generation": {"status": failed["status"], "result": failed["result"]},
            },
            sort_keys=True,
        )
    )


@pytest.mark.parametrize("poison", ["config", "renderer"])
def test_saved_bundle_ticket_open_has_no_comparison_dependency(saved_bundle, monkeypatch, poison):
    ws, _, client, rows, _ = saved_bundle
    expected = {name: (ws.project.export_dir() / name).read_bytes() for name in rows}

    def fail(*args, **kwargs):
        raise RuntimeError("comparison must not authorize files")

    if poison == "config":
        monkeypatch.setattr(ProjectWorkspace, "effective_config", fail)
    else:
        monkeypatch.setattr(
            "podcast_mcp.services.document.transcript.render_transcript_formats", fail
        )
    responses = {
        name: client.get(f"{FILES}/{name}", params={"path": str(ws.path), "ticket": row["ticket"]})
        for name, row in rows.items()
    }
    assert {name: res.status_code for name, res in responses.items()} == dict.fromkeys(rows, 200)
    assert {name: res.content for name, res in responses.items()} == expected


@pytest.mark.parametrize("gated", [False, True], ids=["inactive", "active"])
@pytest.mark.parametrize(
    "section,key",
    [("analysis", "ml_backend"), ("analysis", "reconcile_on_render"), ("gate_fill", "mode")],
)
def test_named_export_rejects_consumed_containers_only(
    prepared, tmp_path, monkeypatch, gated, section, key
):
    import yaml

    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import write_stem_hash

    ws, engine, _ = prepared
    if gated:
        with write_grant(WriteGrantKind.DISPATCHER):
            ws.mutate(
                "before gate",
                "after gate",
                lambda project: setattr(project.tracks[0], "transcript_gate", True),
            )
        write_stem_hash(ws.project, "host", defaults=load_defaults())
    defaults = load_defaults()
    defaults[section][key] = ["invalid"]
    path = tmp_path / "containers.yaml"
    path.write_text(yaml.safe_dump(defaults), encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(path))
    client = TestClient(create_app(), raise_server_exceptions=False)
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "wav"}]))
    if gated:
        assert job["status"] == "error", job
        assert job["result"] is None
        assert engine.master_targets == []
        root = ws.project.export_dir() / "variants"
        assert not root.exists() or list(root.iterdir()) == []
    else:
        assert job["status"] == "ok", job["error"]
        file_id = job["result"]["file_ids"][0]
        response = client.get(f"{FILES}/{file_id}", params={"path": str(ws.path)})
        assert (response.status_code, response.content) == (
            200,
            premix_path(ws.project).read_bytes(),
        )
        assert engine.master_targets == [-16]


@pytest.mark.parametrize(
    "patch,source_current,transcript_current",
    [
        ({"mix": {"premix_peak_ceiling_db": []}}, False, True),
        ({"export": {"captions": {"max_lines": []}}}, True, False),
        ({"transcribe": {"decode": {"condition_on_previous_text": {}}}}, True, False),
    ],
)
def test_staged_comparison_inputs_are_independent(
    saved_bundle, patch, source_current, transcript_current
):
    ws, _, client, rows, file_id = saved_bundle
    before = _canonical_snapshot(ws)
    receipt_path = (ws.project.export_dir() / file_id).parent / "receipt.json"
    receipt = receipt_path.read_bytes()
    config_store().put(ws.path, config=patch)
    response = client.get(FILES, params={"path": str(ws.path)})
    assert response.status_code == 200
    found = {row["id"]: row for row in response.json()["files"]}
    assert set(found) == set(rows)
    assert found[file_id]["current"] is source_current
    assert found["test_episode.md"]["current"] is transcript_current
    assert found["test_episode.srt"]["current"] is transcript_current
    assert found["test_episode.wav"]["current"] is True
    for name, row in rows.items():
        downloaded = client.get(
            f"{FILES}/{name}", params={"path": str(ws.path), "ticket": row["ticket"]}
        )
        assert downloaded.status_code == 200
        assert downloaded.content == (ws.project.export_dir() / name).read_bytes()
    config_store().put(ws.path, config={}, reset=True)
    restored = client.get(FILES, params={"path": str(ws.path)}).json()["files"]
    assert all(row["current"] for row in restored)
    assert receipt_path.read_bytes() == receipt
    assert _canonical_snapshot(ws) == before


def test_listing_selects_one_private_config_snapshot(saved_bundle, monkeypatch):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.services.document import export_files

    ws, _, client, _, _ = saved_bundle
    calls = []
    config = load_defaults()

    def selected(self):
        calls.append(self.path)
        if len(calls) != 1:
            raise RuntimeError("listing reloaded its configuration")
        return config

    original_digest = export_files.current_source_digest

    def digest(project, snapshot):
        result = original_digest(project, snapshot)
        config["export"]["captions"] = []
        return result

    monkeypatch.setattr(export_files, "current_source_digest", digest)
    monkeypatch.setattr(ProjectWorkspace, "effective_config", selected)
    response = client.get(FILES, params={"path": str(ws.path)})
    assert response.status_code == 200
    assert all(row["current"] for row in response.json()["files"])
    assert calls == [ws.path]


@pytest.mark.parametrize(
    "patch",
    [
        {"mix": []},
        {"mix": {"premix_peak_ceiling_db": []}},
        {"analysis": {"reconcile_on_render": []}},
        {"analysis": {"heuristics": {"bleed_text_match_enabled": {}}}},
        {"gate_fill": {"mode": []}},
    ],
)
def test_config_changed_before_commit_refuses_publication(prepared, monkeypatch, patch):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import write_stem_hash

    ws, engine, _ = prepared
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate(
            "before gate",
            "after gate",
            lambda project: setattr(project.tracks[0], "transcript_gate", True),
        )
    write_stem_hash(ws.project, "host", defaults=load_defaults())
    before = _canonical_snapshot(ws)
    original = engine.master_loudness

    def master(*args, **kwargs):
        result = original(*args, **kwargs)
        config_store().put(ws.path, config=patch)
        return result

    monkeypatch.setattr(engine, "master_loudness", master)
    client = TestClient(create_app(), raise_server_exceptions=False)
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "wav"}]))
    assert job["status"] == "error"
    assert job["result"] is None
    assert engine.master_calls == 1
    assert list((ws.project.export_dir() / "variants").iterdir()) == []
    assert _canonical_snapshot(ws) == before
    print(json.dumps({"recheck": job["status"], "result": job["result"], "bundles": 0}))


@pytest.mark.parametrize("timed", [False, True])
def test_source_admission_uses_actual_timed_clips(prepared, timed):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import write_stem_hash
    from podcast_mcp.models import Clip
    from podcast_mcp.models.clip_timing import ClipTiming, TimingStep

    ws, engine, _ = prepared
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate(
            "before clip",
            "after clip",
            lambda project: setattr(
                project,
                "clips",
                [
                    Clip(
                        id="host-clip",
                        track_id="host",
                        source_start=0,
                        source_end=2.0,
                        timeline_start=0,
                        timing=ClipTiming(steps=[TimingStep(at=1.0, delta_sec=0.01)])
                        if timed
                        else None,
                    )
                ],
            ),
        )
    write_stem_hash(ws.project, "host", defaults=load_defaults())
    config_store().put(ws.path, config={"inaudible_cuts": {"micro_fade_ms": []}})
    client = TestClient(create_app(), raise_server_exceptions=False)
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "wav"}]))
    assert job["status"] == ("error" if timed else "ok"), job
    assert engine.master_calls == (0 if timed else 1)
    if timed:
        assert job["result"] is None


@pytest.mark.parametrize(
    "patch",
    [
        {"analysis": []},
        {"analysis": {"heuristics": []}},
        {"analysis": {"heuristics": {"bleed_text_match_enabled": {}}}},
        {"analysis": {"heuristics": {"min_fade_ms": []}}},
        {"gate_fill": []},
    ],
)
def test_gated_source_shapes_are_refused_before_mastering(prepared, patch):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import write_stem_hash

    ws, engine, _ = prepared
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate(
            "before gate",
            "after gate",
            lambda project: setattr(project.tracks[0], "transcript_gate", True),
        )
    write_stem_hash(ws.project, "host", defaults=load_defaults())
    config_store().put(ws.path, config=patch)
    client = TestClient(create_app(), raise_server_exceptions=False)
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "wav"}]))
    assert job["status"] == "error", job
    assert job["result"] is None
    assert engine.master_calls == 0
    assert not (ws.project.export_dir() / "variants").exists()


@pytest.mark.parametrize("with_media", [False, True], ids=["no-media", "muted"])
def test_unmixed_gated_track_does_not_consume_gate_config(prepared, with_media):
    from podcast_mcp.models import Track

    ws, engine, _ = prepared
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate(
            "before inactive track",
            "after inactive track",
            lambda project: project.tracks.append(
                Track(
                    id="unused",
                    label="Unused",
                    transcript_gate=True,
                    media=project.tracks[0].media if with_media else None,
                    muted=with_media,
                )
            ),
        )
    config_store().put(ws.path, config={"analysis": [], "gate_fill": []})
    client = TestClient(create_app(), raise_server_exceptions=False)
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "wav"}]))
    assert job["status"] == "ok", job
    assert engine.master_calls == 1


def test_nondefault_inputs_preserve_actual_source_certificate(prepared):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import mix_gains, write_premix_hash, write_stem_hash
    from podcast_mcp.services.pipeline.export_variant import _source_certificate

    ws, _, _ = prepared
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate(
            "before gate",
            "after gate",
            lambda project: setattr(project.tracks[0], "transcript_gate", True),
        )
    config = load_defaults()
    config["mix"]["premix_peak_ceiling_db"] = "-2.5"
    config["analysis"]["ml_backend"] = False
    config["analysis"]["heuristics"]["bleed_dominance_db"] = "4.5"
    config["analysis"]["heuristics"]["bleed_text_match_min_dominance_db"] = None
    config["gate_fill"]["mode"] = None
    config_store().put(ws.path, config=config)
    config = ws.effective_config()
    write_stem_hash(ws.project, "host", defaults=config)
    write_premix_hash(ws.project, mix_gains(ws.project), trim_db=None, defaults=config)
    before = _source_certificate(ws.project, config)
    canonical = _canonical_snapshot(ws)
    client = TestClient(create_app(), raise_server_exceptions=False)
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "wav"}]))
    assert job["status"] == "ok", job
    file_id = job["result"]["file_ids"][0]
    receipt = json.loads(((ws.project.export_dir() / file_id).parent / "receipt.json").read_bytes())
    assert receipt["source_digest"] == before.digest
    assert _source_certificate(ws.project, config) == before
    rows = client.get(FILES, params={"path": str(ws.path)}).json()["files"]
    assert next(row for row in rows if row["id"] == file_id)["current"] is True
    assert (
        client.get(f"{FILES}/{file_id}", params={"path": str(ws.path)}).content
        == premix_path(ws.project).read_bytes()
    )
    assert _canonical_snapshot(ws) == canonical
    print(
        json.dumps(
            {
                "nondefault_source_digest": before.digest,
                "current": True,
                "canonical_unchanged": True,
            }
        )
    )


def test_source_fingerprint_runtime_error_is_not_unavailable(saved_bundle, monkeypatch):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import export_variant

    ws, _, _, _, _ = saved_bundle

    def fail(*args, **kwargs):
        raise RuntimeError("fingerprint programming failure")

    monkeypatch.setattr(export_variant, "_source_certificate", fail)
    with pytest.raises(RuntimeError, match="fingerprint programming failure"):
        ExportFilesService(ws).listed()


@pytest.fixture
def request_workspace(minimal_project, request):
    sample_wav = request.getfixturevalue(getattr(request, "param", "sample_wav"))

    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import mix_gains, write_premix_hash, write_stem_hash
    from podcast_mcp.models import MediaAsset, Track, TrackRole
    from podcast_mcp.util.tracks import stem_path

    ws = ProjectWorkspace.open(minimal_project)
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate(
            "before source",
            "after source",
            lambda project: project.tracks.append(
                Track(
                    id="host",
                    label="Host",
                    role=TrackRole.DIALOGUE,
                    media=MediaAsset(path="raw/host.wav"),
                )
            ),
        )
    (ws.project.raw_dir() / "host.wav").write_bytes(sample_wav.read_bytes())
    stem = stem_path(ws.project, "host")
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    os.utime(stem, ns=(1_000_000_000, 1_000_000_000))
    defaults = load_defaults()
    write_stem_hash(ws.project, "host", defaults=defaults)
    premix_path(ws.project).write_bytes(sample_wav.read_bytes())
    write_premix_hash(ws.project, mix_gains(ws.project), trim_db=None, defaults=defaults)
    (ws.project.export_dir() / "test_episode.wav").write_bytes(sample_wav.read_bytes())
    return ws


@pytest.mark.parametrize(
    "patch,after_encode",
    [
        ({"master": []}, False),
        ({"export": []}, False),
        ({"export": {"wav": [False]}}, False),
        ({"master": []}, True),
    ],
)
@pytest.mark.parametrize(
    "request_workspace",
    [
        "sample_wav",
        pytest.param(
            "gentle_wav",
            marks=pytest.mark.skipif(
                os.environ.get("PODCAST_RUN_VARIANT_REAL_ENGINE") != "1",
                reason="opt-in real FFmpeg",
            ),
        ),
    ],
    indirect=True,
)
def test_delivery_request_rejects_container_fallback(
    request_workspace, monkeypatch, tmp_path, patch, after_encode, request
):
    import yaml

    from podcast_mcp.config.defaults import load_defaults

    ws = request_workspace
    real = request.node.callspec.params["request_workspace"] == "gentle_wav"
    engine = pipeline.pipeline_steps.ffmpeg() if real else _FakeEngine(premix_path(ws.project))
    calls = []
    master = engine.master_loudness

    def counted_master(*args, **kwargs):
        calls.append(kwargs)
        return master(*args, **kwargs)

    monkeypatch.setattr(engine, "master_loudness", counted_master)
    if not real:
        engine.qc = {"integrated_lufs": -16.0, "true_peak_db": -10.0, "lra": 7.0}
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    defaults = load_defaults()
    defaults["master"]["true_peak_db"] = -4
    defaults["export"].update(wav=False, formats=[{"ext": "mp3"}])
    override = tmp_path / "request-defaults.yaml"
    override.write_text(yaml.safe_dump(defaults))
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(override))
    client = TestClient(create_app())
    control = done(client, ws.path, start(client, ws.path, target="podcast"))
    assert control["status"] == "ok", control
    assert control["result"]["master"]["target"]["true_peak_db"] == -4
    assert [name.rsplit(".", 1)[1] for name in control["result"]["file_ids"]] == ["mp3"]
    before = _canonical_snapshot(ws)
    root = ws.project.export_dir() / "variants"
    bundles = {path.name for path in root.iterdir()}
    params = {"path": str(ws.path)}
    rows = client.get(FILES, params=params).json()["files"]
    saved = {
        row["id"]: client.get(
            f"{FILES}/{row['id']}", params={**params, "ticket": row["ticket"]}
        ).content
        for row in rows
    }
    original = engine.export_audio

    def encode_then_change(*args, **kwargs):
        original(*args, **kwargs)
        defaults.update(patch)
        override.write_text(yaml.safe_dump(defaults))

    if after_encode:
        defaults["master"]["true_peak_db"] = -1.5
        override.write_text(yaml.safe_dump(defaults))
        monkeypatch.setattr(engine, "export_audio", encode_then_change)
    else:
        defaults.update(patch)
        override.write_text(yaml.safe_dump(defaults))
    if not real:
        engine.qc = {"integrated_lufs": -23.0, "true_peak_db": -17.0, "lra": 7.0}
    job = done(client, ws.path, start(client, ws.path, target="broadcast"))
    assert _canonical_snapshot(ws) == before
    for row in rows:
        response = client.get(f"{FILES}/{row['id']}", params={**params, "ticket": row["ticket"]})
        assert response.status_code == 200
        assert response.content == saved[row["id"]]
    print(
        json.dumps(
            {
                "patch": patch,
                "after_encode": after_encode,
                "job": job,
                "canonical_preserved": True,
                "tickets_preserved": True,
                "new_bundles": sorted({path.name for path in root.iterdir()} - bundles),
            }
        )
    )
    assert job["status"] == "error", job
    assert job["error_code"] == "pipeline_config_value_invalid"
    assert job["result"] is None
    assert {path.name for path in root.iterdir()} == bundles
    assert len(calls) == (2 if after_encode else 1)


@pytest.fixture
def request_defaults(tmp_path, monkeypatch):
    import yaml

    path = tmp_path / "request-defaults.yaml"

    def replace(config):
        path.write_text(yaml.safe_dump(config))
        monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(path))

    return replace


@pytest.mark.parametrize("section", ["master", "export"])
@pytest.mark.parametrize("value", ["absent", None, {}, False, 0, "", b""])
def test_request_empty_section_preserves_default_identity(
    request_workspace, monkeypatch, section, value, request_defaults
):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline.export_variant import variant_identity

    ws = request_workspace
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    config = load_defaults()
    config.pop(section)
    expected = variant_identity(ws.project, config, ExportTarget.PODCAST, None)
    if value != "absent":
        config[section] = value
    request_defaults(config)
    result = PipelineService(ws).export_variant(ExportTarget.PODCAST)
    assert result.master.target.integrated_lufs == -16
    assert result.master.target.true_peak_db == -1.5
    assert result.master.target.lra == 11
    assert [name.rsplit(".", 1)[1] for name in result.file_ids] == ["wav", "mp3"]
    assert variant_identity(ws.project, config, ExportTarget.PODCAST, None) == expected
    assert result.file_ids[0].split("/")[1] == expected[1]


@pytest.mark.parametrize(
    "patch",
    [
        {"master": [False]},
        {"master": set()},
        {"master": "invalid"},
        {"export": [("wav", False)]},
        {"export": set()},
        {"export": 1},
        *({"export": {"wav": value}} for value in ({}, {"on": True}, [], [False], set(), {False})),
        {"master": {"true_peak_db": None}},
        {"master": {"lra": "invalid"}},
        {"master": {"qc_lufs_tolerance_lu": []}},
    ],
)
def test_request_invalid_consumed_value_refuses_before_mastering(
    request_workspace, monkeypatch, patch, request_defaults
):
    from podcast_mcp.config.defaults import load_defaults

    ws = request_workspace
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    config = load_defaults()
    config.update(patch)
    request_defaults(config)
    before = _canonical_snapshot(ws)
    client = TestClient(create_app())
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "wav"}]))
    assert job["status"] == "error"
    assert job["error_code"] == "pipeline_config_value_invalid"
    assert job["result"] is None
    assert str(ws.path.parent) not in job["error"]
    assert engine.master_calls == 0
    assert not (ws.project.export_dir() / "variants").exists()
    assert _canonical_snapshot(ws) == before


@pytest.mark.parametrize(
    "wav,extensions",
    [
        (None, ["mp3"]),
        (False, ["mp3"]),
        (0, ["mp3"]),
        ("", ["mp3"]),
        (1, ["wav", "mp3"]),
        ("false", ["wav", "mp3"]),
    ],
)
def test_request_scalar_conversions_keep_target_formats_and_identity(
    request_workspace, monkeypatch, wav, extensions, request_defaults
):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline.export_variant import variant_identity

    ws = request_workspace
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    config = load_defaults()
    config["master"] = {
        "integrated_lufs": "-19",
        "true_peak_db": "-1.5",
        "lra": True,
        "qc_lufs_tolerance_lu": "0.5",
        "qc_true_peak_tolerance_db": False,
    }
    config["export"] = {"wav": wav, "mp3_bitrate_kbps": "128"}
    request_defaults(config)
    result = PipelineService(ws).export_variant(ExportTarget.PODCAST)
    assert result.master.target.integrated_lufs == -16
    assert result.master.target.true_peak_db == -1.5
    assert result.master.target.lra == 1
    assert result.master.limits.lufs_tolerance_lu == 0.5
    assert result.master.limits.true_peak_tolerance_db == 0
    assert [name.rsplit(".", 1)[1] for name in result.file_ids] == extensions
    identity = variant_identity(ws.project, config, ExportTarget.PODCAST, None)
    config["master"] = {
        "integrated_lufs": -19,
        "true_peak_db": -1.5,
        "lra": 1,
        "qc_lufs_tolerance_lu": 0.5,
        "qc_true_peak_tolerance_db": 0,
    }
    config["export"] = {"wav": bool(wav), "mp3_bitrate_kbps": 128}
    assert variant_identity(ws.project, config, ExportTarget.PODCAST, None) == identity
    assert result.file_ids[0].split("/")[1] == identity[1]


@pytest.mark.parametrize(
    "export,formats,extensions",
    [
        ({}, None, ["wav", "mp3"]),
        ({"formats": None}, None, ["wav"]),
        ({"formats": []}, None, ["wav"]),
        ({"formats": "invalid", "mp3_bitrate_kbps": []}, [], ["wav"]),
        ({"wav": False, "formats": "invalid", "mp3_bitrate_kbps": []}, [{"ext": "wav"}], ["wav"]),
        ({"wav": False, "formats": "invalid", "mp3_bitrate_kbps": []}, [{"ext": "flac"}], ["flac"]),
        ({"wav": False}, [], None),
        ({"wav": False, "formats": None}, None, None),
        ({"wav": False, "formats": []}, None, None),
    ],
)
def test_request_format_precedence(
    request_workspace, monkeypatch, export, formats, extensions, request_defaults
):
    from podcast_mcp.config.defaults import load_defaults

    ws = request_workspace
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    config = load_defaults()
    config["export"] = export
    request_defaults(config)
    client = TestClient(create_app())
    job = done(client, ws.path, start(client, ws.path, target="podcast", formats=formats))
    if extensions is None:
        assert job["status"] == "error"
        assert job["error_code"] == "export_variant_format_invalid"
        assert job["result"] is None
        assert engine.master_calls == 0
    else:
        assert job["status"] == "ok", job
        assert [name.rsplit(".", 1)[1] for name in job["result"]["file_ids"]] == extensions


@pytest.mark.parametrize(
    "raw",
    [
        {},
        "mp3",
        [False],
        [{}],
        [{"ext": "wav"}, {"ext": "wav"}],
        [{"ext": "zip"}],
        [{"ext": "wav", "extra_args": ["-y"]}],
        [{"ext": "mp3", "bitrate_kbps": 7}],
    ],
)
@pytest.mark.parametrize("recheck", [False, True])
def test_request_raw_format_errors_keep_code(
    request_workspace, monkeypatch, raw, recheck, request_defaults
):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline.export_variant import variant_identity
    from podcast_mcp.util.coded_error import CodedValueError

    ws = request_workspace
    config = load_defaults()
    config["export"]["formats"] = raw
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    request_defaults(config)
    with pytest.raises(CodedValueError) as caught:
        if recheck:
            variant_identity(ws.project, config, ExportTarget.PODCAST, None)
        else:
            PipelineService(ws).export_variant(ExportTarget.PODCAST)
    assert caught.value.code == "export_variant_format_invalid"
    assert engine.master_calls == 0


@pytest.mark.parametrize("patch", [{"master": []}, {"export": []}, {"export": {"wav": [False]}}])
@pytest.mark.parametrize("at_guard", [False, True])
def test_invalid_request_cannot_reuse_cache_and_saved_source_stays_current(
    request_workspace, monkeypatch, patch, at_guard
):
    from contextlib import contextmanager

    from podcast_mcp.services.document import ExportFilesService

    ws = request_workspace
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    client = TestClient(create_app())
    body = {"target": "podcast", "formats": [{"ext": "wav"}]}
    first = done(client, ws.path, start(client, ws.path, **body))
    assert first["status"] == "ok", first
    file_id = first["result"]["file_ids"][0]
    bundle = (ws.project.export_dir() / file_id).parent
    immutable = {p.name: p.read_bytes() for p in bundle.iterdir()}
    version = ExportFilesService(ws).open(file_id).version
    params = {"path": str(ws.path)}
    row = next(
        row for row in client.get(FILES, params=params).json()["files"] if row["id"] == file_id
    )
    before = _canonical_snapshot(ws)
    original_guard = pipeline.project_commit_guard

    @contextmanager
    def changed_guard(*args, **kwargs):
        config_store().put(ws.path, config=patch)
        with original_guard(*args, **kwargs):
            yield

    if at_guard:
        monkeypatch.setattr(pipeline, "project_commit_guard", changed_guard)
    else:
        config_store().put(ws.path, config=patch)
    refused = done(client, ws.path, start(client, ws.path, **body))
    assert refused["status"] == "error", refused
    assert refused["error_code"] == "pipeline_config_value_invalid"
    assert refused["result"] is None
    current = next(
        row for row in client.get(FILES, params=params).json()["files"] if row["id"] == file_id
    )
    assert current["current"] is True
    assert ExportFilesService(ws).open(file_id).version == version
    response = client.get(f"{FILES}/{file_id}", params={**params, "ticket": row["ticket"]})
    assert response.status_code == 200
    assert response.content == immutable["audio.wav"]
    assert {p.name: p.read_bytes() for p in bundle.iterdir()} == immutable
    assert _canonical_snapshot(ws) == before
    assert engine.master_calls == 1
    monkeypatch.setattr(pipeline, "project_commit_guard", original_guard)
    config_store().put(ws.path, config={}, reset=True)
    recovered = done(client, ws.path, start(client, ws.path, **body))
    assert recovered["status"] == "ok", recovered
    assert recovered["result"] == first["result"]
    assert engine.master_calls == 1
    print(
        json.dumps(
            {
                "cache_guard": at_guard,
                "patch": patch,
                "error_code": refused["error_code"],
                "current": current["current"],
                "version": version,
                "recovered": recovered["result"],
                "immutable_preserved": True,
                "canonical_preserved": True,
            }
        )
    )


@pytest.mark.parametrize(
    "patch,code",
    [
        ({"master": []}, "pipeline_config_value_invalid"),
        ({"export": []}, "pipeline_config_value_invalid"),
        ({"export": {"wav": [False]}}, "pipeline_config_value_invalid"),
        ({"master": {"true_peak_db": None}}, "pipeline_config_value_invalid"),
        ({"master": {"lra": 12}}, "stale_mix"),
        ({"export": {"formats": "invalid", "mp3_bitrate_kbps": []}}, None),
    ],
)
def test_request_recheck_after_encode_uses_consumed_settings(
    request_workspace, monkeypatch, patch, code
):
    ws = request_workspace
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    original = engine.export_audio
    encoded = threading.Event()
    resume = threading.Event()

    def encode(*args, **kwargs):
        original(*args, **kwargs)
        encoded.set()
        assert resume.wait(5)

    monkeypatch.setattr(engine, "export_audio", encode)
    before = _canonical_snapshot(ws)
    client = TestClient(create_app())
    job_id = start(client, ws.path, target="broadcast", formats=[{"ext": "mp3"}])
    try:
        assert encoded.wait(5)
        config_store().put(ws.path, config=patch)
    finally:
        resume.set()
    job = done(client, ws.path, job_id)
    assert engine.encode_calls == 1
    assert _canonical_snapshot(ws) == before
    assert job["error_code"] == code
    root = ws.project.export_dir() / "variants"
    if code:
        assert job["status"] == "error"
        assert job["result"] is None
        assert list(root.iterdir()) == []
    else:
        assert job["status"] == "ok", job
        assert len(list(root.iterdir())) == 1


@pytest.mark.parametrize("constructor", ["master_target_for", "MasterQcLimits", "_resolve_formats"])
@pytest.mark.parametrize("recheck", [False, True])
def test_request_programming_runtime_error_propagates(
    request_workspace, monkeypatch, constructor, recheck
):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService, export_variant

    def broken(*args, **kwargs):
        raise RuntimeError("request constructor defect")

    if constructor == "MasterQcLimits":
        monkeypatch.setattr(export_variant.MasterQcLimits, "from_defaults", broken)
    else:
        monkeypatch.setattr(export_variant, constructor, broken)
    ws = request_workspace
    engine = _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    with pytest.raises(RuntimeError, match="request constructor defect"):
        if recheck:
            export_variant.variant_identity(
                ws.project, ws.effective_config(), ExportTarget.PODCAST, None
            )
        else:
            PipelineService(ws).export_variant(ExportTarget.PODCAST)
    assert engine.master_calls == 0


@pytest.fixture
def boundary_stages(monkeypatch):
    import errno

    from podcast_mcp.util.owned_stage import OwnedStage

    closed = []
    original = OwnedStage.close

    def close(stage):
        descriptors = (stage.root_fd, stage.stage_fd)
        original(stage)
        for descriptor in descriptors:
            try:
                os.fstat(descriptor)
            except OSError as error:
                assert error.errno == errno.EBADF
            else:
                os.close(descriptor)
                pytest.fail("owned stage descriptor remained open")
        closed.append({"committed": stage.committed, "closed": list(descriptors)})

    monkeypatch.setattr(OwnedStage, "close", close)
    return closed


@pytest.fixture
def boundary_export(request_workspace, request, monkeypatch):
    from podcast_mcp.services.document import ExportFilesService

    ws = request_workspace
    real = (
        getattr(request.node, "callspec", None) is not None
        and request.node.callspec.params.get("request_workspace") == "gentle_wav"
    )
    engine = pipeline.pipeline_steps.ffmpeg() if real else _FakeEngine(premix_path(ws.project))
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    client = TestClient(create_app())
    first = done(
        client, ws.path, start(client, ws.path, target="podcast", formats=[{"ext": "mp3"}])
    )
    assert first["status"] == "ok", first
    params = {"path": str(ws.path)}
    rows = client.get(FILES, params=params).json()["files"]
    root = ws.project.export_dir() / "variants"
    saved = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    versions = {row["id"]: ExportFilesService(ws).open(row["id"]).version for row in rows}
    downloads = {
        row["id"]: client.get(
            f"{FILES}/{row['id']}", params={**params, "ticket": row["ticket"]}
        ).content
        for row in rows
    }
    canonical = _canonical_snapshot(ws)

    def unchanged(*, allow_new=False):
        assert _canonical_snapshot(ws) == canonical
        actual = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        assert all(actual.get(path) == data for path, data in saved.items())
        assert all(not path.name.startswith(".") for path in root.iterdir())
        if not allow_new:
            assert actual == saved
            assert {p.name for p in root.iterdir()} == {path.parts[0] for path in saved}
        listed = client.get(FILES, params=params)
        assert listed.status_code == 200
        current = {row["id"]: row for row in listed.json()["files"]}
        assert current.keys() >= versions.keys()
        if not allow_new:
            assert current.keys() == versions.keys()
        for row in rows:
            file_id = row["id"]
            assert current[file_id]["current"] is True
            assert ExportFilesService(ws).open(file_id).version == versions[file_id]
            download = client.get(f"{FILES}/{file_id}", params={**params, "ticket": row["ticket"]})
            assert download.status_code == 200
            assert download.content == downloads[file_id]
        return {
            "versions": versions,
            "download_sha256": {
                name: hashlib.sha256(data).hexdigest() for name, data in downloads.items()
            },
            "bundle_sha256": {
                str(path): hashlib.sha256(data).hexdigest() for path, data in saved.items()
            },
        }

    return ws, engine, client, unchanged


@pytest.mark.parametrize("owner", ["master_target_for", "_source_certificate"])
@pytest.mark.parametrize(
    "phase,request_workspace",
    [
        ("initial", "sample_wav"),
        ("cache", "sample_wav"),
        ("fresh", "sample_wav"),
        pytest.param(
            "fresh",
            "gentle_wav",
            marks=pytest.mark.skipif(
                os.environ.get("PODCAST_RUN_VARIANT_REAL_ENGINE") != "1",
                reason="opt-in real FFmpeg",
            ),
        ),
    ],
    indirect=["request_workspace"],
)
def test_transaction_fault_keeps_same_exception(
    boundary_export, boundary_stages, monkeypatch, owner, phase
):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService, export_variant

    ws, engine, _, unchanged = boundary_export
    defect = RuntimeError("request boundary defect")
    original = getattr(export_variant, owner)
    encode = engine.export_audio
    encoded = []
    transaction_depths = []
    calls = []

    def completed_encode(*args, **kwargs):
        result = encode(*args, **kwargs)
        encoded.append(args[1].read_bytes())
        return result

    def fail(*args, **kwargs):
        calls.append(1)
        if phase == "initial" or len(calls) == 2:
            transaction_depths.append(ws._transaction_depth)
            raise defect
        return original(*args, **kwargs)

    with monkeypatch.context() as scope:
        scope.setattr(engine, "export_audio", completed_encode)
        scope.setattr(export_variant, owner, fail)
        with pytest.raises((RuntimeError, ValueError)) as caught:
            PipelineService(ws).export_variant(
                ExportTarget.PODCAST if phase == "cache" else ExportTarget.BROADCAST,
                formats=[{"ext": "mp3"}],
            )
    saved_state = unchanged()
    assert len(encoded) == (1 if phase == "fresh" else 0)
    assert transaction_depths == ([0] if phase == "initial" else [1])
    assert ws._transaction_depth == 0
    assert len(boundary_stages) == (1 if phase == "fresh" else 0)
    assert all(not stage["committed"] for stage in boundary_stages)
    print(
        json.dumps(
            {
                "owner": owner,
                "phase": phase,
                "same_exception": caught.value is defect,
                "type": type(caught.value).__name__,
                "code": getattr(caught.value, "code", None),
                "cause_is_sentinel": caught.value.__cause__ is defect,
                "producer": type(engine).__name__,
                "encoded_sha256": [hashlib.sha256(data).hexdigest() for data in encoded],
                "saved_state": saved_state,
                "encoded": len(encoded),
                "transaction_depths": transaction_depths,
                "closed_stages": boundary_stages,
                "saved_and_canonical_preserved": True,
            }
        )
    )
    assert caught.value is defect


@pytest.mark.parametrize("owner", ["master_target_for", "_source_certificate"])
@pytest.mark.parametrize(
    "request_workspace",
    [
        "sample_wav",
        pytest.param(
            "gentle_wav",
            marks=pytest.mark.skipif(
                os.environ.get("PODCAST_RUN_VARIANT_REAL_ENGINE") != "1",
                reason="opt-in real FFmpeg",
            ),
        ),
    ],
    indirect=True,
)
def test_public_transaction_fault_is_unexpected(
    boundary_export, boundary_stages, monkeypatch, owner
):
    from podcast_mcp.services.pipeline import export_variant

    ws, engine, client, unchanged = boundary_export
    original = getattr(export_variant, owner)
    encode = engine.export_audio
    encoded = []
    calls = []

    def completed_encode(*args, **kwargs):
        result = encode(*args, **kwargs)
        encoded.append(args[1].read_bytes())
        return result

    def fail(*args, **kwargs):
        if encoded:
            calls.append(1)
            raise RuntimeError("request boundary defect")
        return original(*args, **kwargs)

    with monkeypatch.context() as scope:
        scope.setattr(engine, "export_audio", completed_encode)
        scope.setattr(export_variant, owner, fail)
        job = done(
            client, ws.path, start(client, ws.path, target="broadcast", formats=[{"ext": "mp3"}])
        )
    saved_state = unchanged()
    assert len(encoded) == len(calls) == 1
    assert job["status"] == "error"
    assert job["result"] is None
    assert len(boundary_stages) == 1
    assert boundary_stages[0]["committed"] is False
    assert "Traceback" not in job["error"]
    assert str(ws.path) not in job["error"]
    print(
        json.dumps(
            {
                "owner": owner,
                "public_status": job["status"],
                "producer": type(engine).__name__,
                "encoded_sha256": [hashlib.sha256(data).hexdigest() for data in encoded],
                "saved_state": saved_state,
                "error_code": job["error_code"],
                "error": job["error"],
                "result": job["result"],
                "closed_stages": boundary_stages,
                "saved_and_canonical_preserved": True,
            }
        )
    )
    assert job["error_code"] is None


@pytest.mark.parametrize("origin", ["guard_exit", "result"])
@pytest.mark.parametrize("public", [False, True])
def test_post_publication_fault_keeps_committed_bundle(
    boundary_export, boundary_stages, monkeypatch, origin, public
):
    from contextlib import contextmanager

    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService, export_variant

    ws, _, client, unchanged = boundary_export
    defect = RuntimeError("post publication boundary defect")
    root = ws.project.export_dir() / "variants"
    before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    canonical = _canonical_snapshot(ws)
    guard = pipeline.project_commit_guard
    reached = []

    @contextmanager
    def fail_exit(*args, **kwargs):
        with guard(*args, **kwargs):
            yield
        reached.append("guard_exit")
        raise defect

    def fail_result(*args, **kwargs):
        reached.append("result")
        raise defect

    with monkeypatch.context() as scope:
        if origin == "guard_exit":
            scope.setattr(pipeline, "project_commit_guard", fail_exit)
        else:
            scope.setattr(export_variant, "_result", fail_result)
        if public:
            job = done(
                client,
                ws.path,
                start(client, ws.path, target="broadcast", formats=[{"ext": "mp3"}]),
            )
            observed = {key: job[key] for key in ("status", "error", "error_code", "result")}
        else:
            with pytest.raises((RuntimeError, ValueError)) as caught:
                PipelineService(ws).export_variant(ExportTarget.BROADCAST, formats=[{"ext": "mp3"}])
            observed = {
                "same_exception": caught.value is defect,
                "code": getattr(caught.value, "code", None),
            }
    saved_state = unchanged(allow_new=True)
    assert reached == [origin]
    assert len(boundary_stages) == 1 and boundary_stages[0]["committed"] is True
    assert _canonical_snapshot(ws) == canonical
    assert all((root / path).read_bytes() == data for path, data in before.items())
    assert len(list(root.iterdir())) == 2
    files = ExportFilesService(ws)
    rows = files.list()
    broadcast = [row for row in rows if row.id.startswith("variants/") and "Broadcast" in row.label]
    assert len(broadcast) == 2
    assert all(row.current for row in broadcast)
    assert all(files.open(row.id).path.read_bytes() for row in broadcast)
    assert ws._transaction_depth == 0
    print(
        json.dumps(
            {
                "origin": origin,
                "public": public,
                "observed": observed,
                "saved_state": saved_state,
                "closed_stages": boundary_stages,
                "committed_ids": [row.id for row in broadcast],
                "prior_and_canonical_preserved": True,
            }
        )
    )
    if public:
        assert job["status"] == "error" and job["result"] is None
        assert job["error_code"] is None
        assert "No variant was published" not in job["error"]
    else:
        assert caught.value is defect


@pytest.mark.parametrize("origin", ["master_loudness", "measure_loudness_full", "export_audio"])
@pytest.mark.parametrize("kind", ["runtime", "os", "value", "subprocess"])
def test_producer_fault_retains_output_translation(
    boundary_export, boundary_stages, monkeypatch, origin, kind
):
    import subprocess

    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.util.coded_error import CodedValueError

    ws, engine, _, unchanged = boundary_export
    exception_type = {
        "runtime": RuntimeError,
        "os": OSError,
        "value": ValueError,
        "subprocess": subprocess.SubprocessError,
    }[kind]
    defect = exception_type(f"producer detail {ws.path}")

    def fail(*args, **kwargs):
        raise defect

    with monkeypatch.context() as scope:
        scope.setattr(engine, origin, fail)
        with pytest.raises(CodedValueError) as caught:
            PipelineService(ws).export_variant(ExportTarget.BROADCAST, formats=[{"ext": "mp3"}])
    saved_state = unchanged()
    expected = (
        "The mastered or encoded variant output is incomplete or invalid. No variant was published."
        if origin == "export_audio"
        else "The mastered or encoded output is incomplete or unsafe. No variant was published."
    )
    assert caught.value.code == "export_variant_unmeasured"
    assert str(caught.value) == expected
    assert caught.value.__cause__ is defect
    assert len(boundary_stages) == 1 and boundary_stages[0]["committed"] is False
    print(
        json.dumps(
            {
                "origin": origin,
                "kind": kind,
                "code": caught.value.code,
                "message": str(caught.value),
                "same_cause": caught.value.__cause__ is defect,
                "saved_state": saved_state,
                "closed_stages": boundary_stages,
                "saved_and_canonical_preserved": True,
            }
        )
    )


def test_success_closes_stage_descriptors(boundary_export, boundary_stages):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService

    ws, _, _, _ = boundary_export
    result = PipelineService(ws).export_variant(ExportTarget.BROADCAST, formats=[{"ext": "mp3"}])
    assert result.master.target.integrated_lufs == -23
    assert len(result.file_ids) == 2
    assert all((ws.project.export_dir() / file_id).is_file() for file_id in result.file_ids)
    assert len(boundary_stages) == 1 and boundary_stages[0]["committed"] is True
    print(json.dumps({"success_ids": result.file_ids, "closed_stages": boundary_stages}))
