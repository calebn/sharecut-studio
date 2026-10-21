from __future__ import annotations

import os
import wave
from unittest.mock import MagicMock

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import proxy_render_hash
from podcast_mcp.engines.source_proxy_audio import SourceProxyInputs
from podcast_mcp.models import (
    Clip,
    ClipBleedRestore,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
)
from podcast_mcp.models.episode import SourceRecording, SourceSpan
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media import proxy_media as pm
from podcast_mcp.services.media import proxy_variants as pv
from podcast_mcp.util.coded_error import CodedKeyError, CodedValueError
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.object_store import ObjectStoreConfig


@pytest.fixture
def workspace(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.tracks = [Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav"))]
    ws.save()
    return ws


@pytest.fixture
def fast_encode(monkeypatch):
    def encode(_engine, wav, output, start, duration, **_kwargs):
        output.write_bytes(f"{sha256_file(wav)}:{start}:{duration}".encode())

    monkeypatch.setattr(pm, "_encode_chunk", encode)
    return encode


def _chunk(ws, artifact, index=0):
    return (
        pv.artifact_directory(ws.project, artifact.context_track_id, artifact.hash)
        / f"{index:05d}.mp3"
    )


def _choice(ws, *, clip_id="selected", source_id=None, track_id="host", valid=True):
    source = ws.project.workspace_path() / (
        ws.project.source_by_id(source_id).path if source_id else "raw/host.wav"
    )
    clip = Clip(
        id=clip_id,
        track_id=track_id,
        source_id=source_id,
        source_start=0.2,
        source_end=1.4,
        timeline_start=3,
        bleed_restore=ClipBleedRestore(
            source_sha256=sha256_file(source) if valid else "f" * 64,
            regions=[SourceSpan(start_s=0.4, end_s=0.8)],
        ),
    )
    ws.project.clips.append(clip)
    ws.save()
    return clip


def _bootstrap(ws, monkeypatch):
    original = pm.ensure_track_proxy(ws, "host")
    old = pm.proxy_dir(ws, "host", original.hash)
    hash_ = proxy_render_hash(ws.project, "host", defaults=load_defaults())
    imported = original.model_copy(update={"hash": hash_})
    old.rename(pm.proxy_dir(ws, "host", hash_))
    ws.project.tracks[0].proxy = imported
    ws.save()
    monkeypatch.setattr(
        pv, "render_source_proxy_inputs", lambda *_a, **_k: pytest.fail("Unexpected render")
    )
    return imported


def test_history_free_complete_manifest_and_noop(workspace, monkeypatch, fast_encode):
    ws = workspace
    ws.record_snapshot("before proxy", force=True)
    history = ws.project.history.model_dump()
    old_file = ws.path.read_bytes()
    generation = pv.ensure_proxy_manifest(ws)
    assert ws.project.history.model_dump() == history
    assert ws.path.read_bytes() != old_file
    assert generation.project_basis.history_head_id == ws.project.history.head_id()
    assert generation.project_basis.clips == {}
    assert len(generation.tracks["host"].hash) == 64
    assert _chunk(ws, generation.tracks["host"]).read_bytes()
    assert len(ws.project.render.proxy_manifests) == 1
    saved = ws.path.read_bytes()
    monkeypatch.setattr(ws, "save", lambda: pytest.fail("Unchanged manifest saved"))
    monkeypatch.setattr(
        pv, "render_source_proxy_inputs", lambda *_a, **_k: pytest.fail("Cached proxy rendered")
    )
    assert pv.ensure_proxy_manifest(ws) == generation
    assert ws.path.read_bytes() == saved


def _assert_prepared_read_unchanged(ws, monkeypatch):
    reopened = ProjectWorkspace.open(ws.path)
    assert len(reopened.project.render.proxy_manifests) == 1
    generation = reopened.project.render.proxy_manifests[0]
    assert generation.project_basis == pv.project_basis(reopened.project, defaults=load_defaults())
    saved = reopened.path.read_bytes()
    history = reopened.project.history.model_dump()
    root = reopened.project.workspace_path()

    def files():
        return {
            path.relative_to(root): path.read_bytes()
            for directory in (root / "raw", root / "history", root / "artifacts/proxy")
            for path in directory.rglob("*")
            if path.is_file()
        }

    before = files()
    monkeypatch.setattr(reopened, "save", lambda: pytest.fail("Prepared manifest saved"))
    monkeypatch.setattr(
        pv, "render_source_proxy_inputs", lambda *_a, **_k: pytest.fail("Prepared proxy rendered")
    )
    for artifact in [*generation.tracks.values(), *generation.artifacts.values()]:
        for index in range(artifact.chunk_count):
            chunk = pv.accepted_proxy_chunk_path(
                reopened, artifact.context_track_id, index, expected_hash=artifact.hash
            )
            assert chunk.read_bytes() == before[chunk.relative_to(root)]
    assert pv.ensure_proxy_manifest(reopened) == generation
    assert reopened.path.read_bytes() == saved
    assert reopened.project.history.model_dump() == history
    assert files() == before
    return generation


@pytest.mark.parametrize("mode", ["empty", "legacy", "occurrence"])
def test_host_preparation_persists_complete_generation_before_guest_read(
    workspace, monkeypatch, fast_encode, mode
):
    ws = workspace
    if mode == "empty":
        ws.project.tracks = []
        ws.save()
    elif mode == "occurrence":
        _choice(ws)
    ws.record_snapshot("before host proxy preparation", force=True)
    history = ws.project.history.model_dump()
    monkeypatch.setattr(pm, "load_object_store_config", lambda: None)

    pm.ensure_and_upload_all_proxies(ws)

    assert ws.project.history.model_dump() == history
    generation = _assert_prepared_read_unchanged(ws, monkeypatch)
    assert set(generation.tracks) == (set() if mode == "empty" else {"host"})
    assert set(generation.occurrences) == ({"selected"} if mode == "occurrence" else set())
    assert len(generation.artifacts) == (1 if mode == "occurrence" else 0)


@pytest.mark.parametrize("failed_track", [None, "host"])
def test_host_preparation_accepts_final_upload_history_and_isolates_failure(
    workspace, monkeypatch, fast_encode, failed_track
):
    ws = workspace
    ws.project.tracks.append(
        Track(id="guest", label="Guest", media=MediaAsset(path="raw/host.wav"))
    )
    ws.save()
    ws.record_snapshot("before host proxy upload", force=True)
    initial_head = ws.project.history.head_id()
    attempts = []
    uploaded = {}

    def upload(source, key):
        attempts.append(key.split("/")[1])
        if key.split("/")[1] == failed_track:
            raise OSError("injected upload failure")
        uploaded[key] = source.read()

    client = MagicMock()
    client.upload_fileobj.side_effect = upload
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(pm, "load_object_store_config", lambda: cfg)
    monkeypatch.setattr(pm, "ObjectStoreClient", lambda _cfg: client)

    pm.ensure_and_upload_all_proxies(ws)

    assert attempts == ["host", "guest"]
    assert ws.project.history.head_id() != initial_head
    generation = _assert_prepared_read_unchanged(ws, monkeypatch)
    assert set(generation.tracks) == {"host", "guest"}
    assert generation.project_basis.history_head_id == ws.project.history.head_id()
    for track in ProjectWorkspace.open(ws.path).project.tracks:
        artifact = generation.tracks[track.id]
        assert track.proxy.hash == artifact.hash
        if track.id == failed_track:
            assert track.proxy.object_store_prefix is None
            assert track.proxy.object_store_uploaded_at is None
        else:
            assert track.proxy.object_store_prefix == pm.proxy_object_prefix(
                track.id, artifact.hash
            )
            assert track.proxy.object_store_uploaded_at
            assert (
                uploaded[pm.proxy_chunk_key(track.id, artifact.hash, 0)]
                == _chunk(ws, artifact).read_bytes()
            )


def test_host_manifest_failure_retains_authority_and_retry_recovers(
    workspace, monkeypatch, fast_encode, caplog
):
    ws = workspace
    previous = pv.ensure_proxy_manifest(ws)
    previous_bytes = _chunk(ws, previous.tracks["host"]).read_bytes()
    _choice(ws)
    render = pv.render_source_proxy_inputs

    def fail_occurrence(project, inputs, *args, **kwargs):
        if inputs.selector == "occurrence":
            raise OSError("injected occurrence render failure")
        return render(project, inputs, *args, **kwargs)

    monkeypatch.setattr(pm, "load_object_store_config", lambda: None)
    monkeypatch.setattr(pv, "render_source_proxy_inputs", fail_occurrence)
    pm.ensure_and_upload_all_proxies(ws)

    reopened = ProjectWorkspace.open(ws.path)
    assert reopened.project.render.proxy_manifests == [previous]
    assert (
        pv.accepted_proxy_chunk_path(
            reopened, "host", 0, expected_hash=previous.tracks["host"].hash
        ).read_bytes()
        == previous_bytes
    )
    assert "Proxy manifest preparation failed" in caplog.text
    monkeypatch.setattr(pv, "render_source_proxy_inputs", render)
    pm.ensure_and_upload_all_proxies(reopened)
    recovered = ProjectWorkspace.open(ws.path).project.render.proxy_manifests
    assert len(recovered) == 2
    assert recovered[0].project_basis == pv.project_basis(
        reopened.project, defaults=load_defaults()
    )
    assert set(recovered[0].occurrences) == {"selected"}
    assert recovered[1] == previous


def test_standalone_64_self_verifies_but_does_not_authorize(workspace, monkeypatch, fast_encode):
    ws = workspace
    descriptor = pm.ensure_track_proxy(ws, "host")
    assert len(descriptor.hash) == 64
    assert ws.project.render.proxy_manifests == []
    with pytest.raises(CodedKeyError) as error:
        pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash=descriptor.hash)
    assert error.value.code == "proxy_not_found"
    monkeypatch.setattr(
        pv,
        "render_source_proxy_inputs",
        lambda *_a, **_k: pytest.fail("Standalone content was not reused"),
    )
    generation = pv.ensure_proxy_manifest(ws)
    assert generation.tracks["host"].hash == descriptor.hash
    assert pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash=descriptor.hash).is_file()


def test_bootstrap_preserves_imported_16_reference_and_bytes(workspace, monkeypatch, fast_encode):
    imported = _bootstrap(workspace, monkeypatch)
    before = pm.proxy_dir(workspace, "host", imported.hash).joinpath("00000.mp3").read_bytes()
    generation = pv.ensure_proxy_manifest(workspace)
    assert generation.tracks["host"].hash == imported.hash
    assert workspace.project.tracks[0].proxy == imported
    assert _chunk(workspace, generation.tracks["host"]).read_bytes() == before
    assert generation.tracks["host"].chunk_sha256 == [
        sha256_file(_chunk(workspace, generation.tracks["host"]))
    ]


@pytest.mark.parametrize("damage", ["missing", "empty", "corrupt", "extra"])
def test_accepted_damage_refuses_without_repair(workspace, monkeypatch, fast_encode, damage):
    imported = _bootstrap(workspace, monkeypatch)
    generation = pv.ensure_proxy_manifest(workspace)
    chunk = _chunk(workspace, generation.tracks["host"])
    if damage == "missing":
        chunk.unlink()
    elif damage == "empty":
        chunk.write_bytes(b"")
    elif damage == "corrupt":
        chunk.write_bytes(b"changed nonempty bytes")
    else:
        chunk.with_name("unexpected.mp3").write_bytes(b"extra")
    saved = workspace.path.read_bytes()
    with pytest.raises(CodedValueError) as error:
        pv.ensure_proxy_manifest(workspace)
    assert error.value.code == "proxy_artifact_damaged"
    assert workspace.path.read_bytes() == saved
    assert workspace.project.render.proxy_manifests == [generation]
    assert workspace.project.tracks[0].proxy.hash == imported.hash
    with pytest.raises(CodedKeyError) as read:
        pv.accepted_proxy_chunk_path(workspace, "host", 0, expected_hash=imported.hash)
    assert read.value.code == "proxy_not_found"


def test_all_nonempty_choices_bind_inactive_and_unity_occurrences(workspace, fast_encode):
    ws = workspace
    source = ws.project.workspace_path() / "raw/host.wav"
    ws.project.sources = [SourceRecording(id="same", path="raw/host.wav")]
    _choice(ws)
    _choice(ws, clip_id="repeat", source_id="same", valid=False)
    ws.project.clips += [
        Clip(id="plain", track_id="host", source_start=0, source_end=1, timeline_start=8),
        Clip(
            id="empty",
            track_id="host",
            source_start=0,
            source_end=1,
            timeline_start=9,
            bleed_restore=ClipBleedRestore(source_sha256=sha256_file(source), regions=[]),
        ),
    ]
    ws.save()
    generation = pv.ensure_proxy_manifest(ws)
    assert set(generation.occurrences) == {"selected", "repeat"}
    assert set(generation.artifacts) == {b.artifact_id for b in generation.occurrences.values()}
    assert all(binding.output_track_id == "host" for binding in generation.occurrences.values())
    assert len(generation.artifacts) == 2
    payload = pv.proxy_manifest_payload(generation, "test-token")
    assert set(payload) == {"revision", "project_basis", "tracks", "artifacts", "occurrences"}
    assert set(payload["tracks"]["host"]) == {
        "hash",
        "chunk_sec",
        "overlap_ms",
        "chunk_count",
        "duration_sec",
        "urls",
    }
    assert "input_hash" not in str(payload)
    assert payload["occurrences"]["selected"]["outputTrackId"] == "host"


def test_selected_move_uses_origin_context_and_preserves_plain_refs(workspace, fast_encode):
    ws = workspace
    ws.project.sources = [SourceRecording(id="origin-source", path="raw/host.wav")]
    ws.project.tracks.append(
        Track(id="destination", label="Destination", media=MediaAsset(path="raw/host.wav"))
    )
    ws.project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="highpass", params={"frequency": 160})],
        )
    ]
    ws.save()
    first = pv.ensure_proxy_manifest(ws)
    legacy_bytes = {
        tid: _chunk(ws, artifact).read_bytes() for tid, artifact in first.tracks.items()
    }
    _choice(ws, source_id="origin-source", track_id="destination")
    second = pv.ensure_proxy_manifest(ws)
    assert second.occurrences["selected"].output_track_id == "host"
    assert second.tracks == first.tracks
    assert {
        tid: _chunk(ws, artifact).read_bytes() for tid, artifact in second.tracks.items()
    } == legacy_bytes
    expected = SourceProxyInputs.capture_occurrence(
        ws.project, "selected", FFmpegEngine(), defaults=load_defaults()
    )
    actual = second.artifacts[second.occurrences["selected"].artifact_id]
    assert actual.context_track_id == expected.context_track_id == "host"
    assert actual.input_hash == pv._input_hash(ws.project, expected, defaults=load_defaults())


def test_unmatched_secondary_uses_destination_and_secondary_bytes(
    workspace, monkeypatch, fast_encode
):
    ws = workspace
    source = ws.project.workspace_path() / "raw/secondary.wav"
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(np.full(96000, 12000, dtype="<i2").tobytes())
    ws.project.sources = [SourceRecording(id="secondary", path="raw/secondary.wav")]
    _choice(ws, source_id="secondary", valid=False)
    selected = []
    render = pv.render_source_proxy_inputs

    def observe(project, inputs, out, **kwargs):
        if inputs.selector == "occurrence":
            selected.append(inputs.source)
        return render(project, inputs, out, **kwargs)

    monkeypatch.setattr(pv, "render_source_proxy_inputs", observe)
    generation = pv.ensure_proxy_manifest(ws)
    assert selected == [source]
    assert generation.occurrences["selected"].output_track_id == "host"
    variant = generation.artifacts[generation.occurrences["selected"].artifact_id]
    assert _chunk(ws, variant).read_bytes() != _chunk(ws, generation.tracks["host"]).read_bytes()


def test_retention_read_authority_without_current_track_and_unknown_hash(workspace, fast_encode):
    ws = workspace
    first = pv.ensure_proxy_manifest(ws)
    for placement in (1, 2):
        with ws.transaction():
            ws.project.clips = [
                Clip(
                    id="plain",
                    track_id="host",
                    source_start=0,
                    source_end=1,
                    timeline_start=placement,
                )
            ]
            ws.save()
        current = pv.ensure_proxy_manifest(ws)
    assert len(ws.project.render.proxy_manifests) == 2
    assert first.revision not in [g.revision for g in ws.project.render.proxy_manifests]
    hash_ = current.tracks["host"].hash
    with ws.transaction():
        ws.project.tracks = []
        ws.save()
    assert pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash=hash_).is_file()
    with pytest.raises(CodedKeyError) as unknown:
        pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash="a" * 64)
    assert unknown.value.code == "proxy_generation_unavailable"
    for bad_hash, index in [(hash_, -1), (hash_, 999), ("../bad", 0), (None, 0)]:
        with pytest.raises(CodedKeyError) as error:
            pv.accepted_proxy_chunk_path(ws, "host", index, expected_hash=bad_hash)
        assert error.value.code == "proxy_not_found"


def test_generation_eviction_rejects_old_and_disk_only_bytes(workspace, fast_encode):
    ws = workspace
    generations = []
    for frequency in (100, 200, 300):
        with ws.transaction():
            ws.project.processing_chains = [
                ProcessingChain(
                    track_id="host",
                    effects=[ProcessingEffect(effect="highpass", params={"frequency": frequency})],
                )
            ]
            ws.save()
        generations.append(pv.ensure_proxy_manifest(ws))
    for generation in generations[1:]:
        assert pv.accepted_proxy_chunk_path(
            ws, "host", 0, expected_hash=generation.tracks["host"].hash
        ).is_file()
    old = generations[0].tracks["host"]
    assert _chunk(ws, old).is_file()
    with pytest.raises(CodedKeyError) as error:
        pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash=old.hash)
    assert error.value.code == "proxy_generation_unavailable"


def test_evicted_16_undo_reference_cannot_bootstrap_again(workspace, monkeypatch, fast_encode):
    ws = workspace
    render = pv.render_source_proxy_inputs
    imported = _bootstrap(ws, monkeypatch)
    from podcast_mcp.services.document import HistoryService

    ws.record_snapshot("Imported legacy", force=True)
    initial = pv.ensure_proxy_manifest(ws)
    monkeypatch.setattr(pv, "render_source_proxy_inputs", render)
    for frequency in (100, 200):

        def change(project, frequency=frequency):
            project.processing_chains = [
                ProcessingChain(
                    track_id="host",
                    effects=[ProcessingEffect(effect="highpass", params={"frequency": frequency})],
                )
            ]

        ws.mutate("before chain", "after chain", change)
        pv.ensure_proxy_manifest(ws)
    retained = ws.project.render.proxy_manifests.copy()
    for _ in range(4):
        if not ws.project.processing_chains:
            break
        HistoryService(ws).undo()
    assert ws.project.processing_chains == []
    assert ws.project.render.proxy_manifests == retained
    assert ws.project.tracks[0].proxy.hash == imported.hash
    assert initial.revision not in [g.revision for g in ws.project.render.proxy_manifests]
    restored = pv.ensure_proxy_manifest(ws)
    assert len(restored.tracks["host"].hash) == 64
    assert restored.tracks["host"].hash != imported.hash
    assert pm.proxy_dir(ws, "host", imported.hash).is_dir()


@pytest.mark.parametrize("landed", [False, True])
def test_save_exception_reports_durable_outcome(workspace, monkeypatch, fast_encode, landed):
    ws = workspace
    before = ws.path.read_bytes()
    history = ws.project.history.model_dump()
    save = ws.save

    def failing_save():
        if landed:
            save()
        raise OSError("injected save failure")

    monkeypatch.setattr(ws, "save", failing_save)
    if landed:
        generation = pv.ensure_proxy_manifest(ws)
        assert ProjectWorkspace.open(ws.path).project.render.proxy_manifests == [generation]
    else:
        with pytest.raises(OSError, match="injected save failure"):
            pv.ensure_proxy_manifest(ws)
        assert ws.path.read_bytes() == before
        assert ws.project.tracks[0].proxy is None
        assert ws.project.render.proxy_manifests == []
        orphan = next((ws.project.artifacts_dir() / "proxy/host").glob("[0-9a-f]*/00000.mp3"))
        with pytest.raises(CodedKeyError):
            pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash=orphan.parent.name)
    assert ws.project.history.model_dump() == history


def test_middle_chunk_failure_cleans_private_outputs(workspace, monkeypatch, fast_encode):
    ws = workspace
    monkeypatch.setattr(pm, "CHUNK_SEC", 0.5)
    calls = []

    def failing(*args, **kwargs):
        calls.append(args[2].name)
        if len(calls) == 2:
            raise OSError("middle chunk")
        fast_encode(*args, **kwargs)

    monkeypatch.setattr(pm, "_encode_chunk", failing)
    before = ws.path.read_bytes()
    with pytest.raises(OSError, match="middle chunk"):
        pv.ensure_proxy_manifest(ws)
    assert calls == ["00000.mp3", "00001.mp3"]
    assert ws.path.read_bytes() == before
    assert not list(ws.project.artifacts_dir().glob("proxy/*/*"))
    monkeypatch.setattr(pm, "_encode_chunk", fast_encode)
    assert pv.ensure_proxy_manifest(ws).tracks["host"].chunk_count == 4


@pytest.mark.parametrize("race", ["saved_edit", "source_bytes", "source_alias"])
def test_final_revalidation_preserves_external_edits_and_refs(
    workspace, monkeypatch, fast_encode, race
):
    ws = workspace
    original = pv.ensure_proxy_manifest(ws)
    original_bytes = _chunk(ws, original.tracks["host"]).read_bytes()
    _choice(ws)
    source = ws.project.workspace_path() / "raw/host.wav"
    changed = False

    def racing(*args, **kwargs):
        nonlocal changed
        fast_encode(*args, **kwargs)
        if changed:
            return
        changed = True
        if race == "saved_edit":
            external = ProjectWorkspace.open(ws.path)
            with external.transaction():
                external.project.tracks[0].label = "External edit"
                external.save()
        elif race == "source_bytes":
            stat = source.stat()
            data = bytearray(source.read_bytes())
            data[-1] ^= 1
            source.write_bytes(data)
            os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        else:
            alternate = source.with_name("alternate.wav")
            alternate.write_bytes(source.read_bytes())
            source.unlink()
            source.symlink_to(alternate)

    monkeypatch.setattr(pm, "_encode_chunk", racing)
    with pytest.raises(CodedValueError):
        pv.ensure_proxy_manifest(ws)
    saved = ProjectWorkspace.open(ws.path).project
    assert saved.render.proxy_manifests == [original]
    assert _chunk(ws, original.tracks["host"]).read_bytes() == original_bytes
    assert not list(ws.project.artifacts_dir().glob("proxy/*/.proxy-*"))
    if race == "saved_edit":
        assert saved.tracks[0].label == "External edit"
        assert ws.project.tracks[0].label == "External edit"


def test_existing_conflicting_content_destination_refuses_without_overwrite(
    workspace, monkeypatch, fast_encode
):
    ws = workspace
    original = pm.ensure_track_proxy(ws, "host")
    directory = pm.proxy_dir(ws, "host", original.hash)
    chunk = directory / "00000.mp3"
    chunk.write_bytes(b"wrong digest")
    with ws.transaction():
        ws.project.tracks[0].proxy = None
        ws.save()
    with pytest.raises(CodedValueError) as error:
        pv.ensure_proxy_manifest(ws)
    assert error.value.code == "proxy_artifact_damaged"
    assert chunk.read_bytes() == b"wrong digest"
    assert ws.project.render.proxy_manifests == []


def test_different_byte_rerender_gets_new_url_after_eviction(workspace, monkeypatch, fast_encode):
    ws = workspace
    first = pv.ensure_proxy_manifest(ws)
    old = first.tracks["host"]
    old_bytes = _chunk(ws, old).read_bytes()
    for frequency in (100, 200):
        with ws.transaction():
            ws.project.processing_chains = [
                ProcessingChain(
                    track_id="host",
                    effects=[ProcessingEffect(effect="highpass", params={"frequency": frequency})],
                )
            ]
            ws.save()
        pv.ensure_proxy_manifest(ws)
    with ws.transaction():
        ws.project.processing_chains = []
        ws.project.tracks[0].proxy = None
        ws.save()

    def different(*args, **kwargs):
        fast_encode(*args, **kwargs)
        args[2].write_bytes(args[2].read_bytes() + b"different nonlinear encoded result")

    monkeypatch.setattr(pm, "_encode_chunk", different)
    current = pv.ensure_proxy_manifest(ws)
    assert current.tracks["host"].input_hash == old.input_hash
    assert current.tracks["host"].hash != old.hash
    assert _chunk(ws, old).read_bytes() == old_bytes
    with pytest.raises(CodedKeyError) as error:
        pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash=old.hash)
    assert error.value.code == "proxy_generation_unavailable"


@pytest.mark.parametrize("bad_id", ["../escape", "a/b", ".", "..", "a\\b"])
def test_paths_refuse_unsafe_known_track_ids(workspace, bad_id):
    workspace.project.tracks[0].id = bad_id
    workspace.save()
    with pytest.raises(CodedKeyError):
        pv.ensure_proxy_manifest(workspace)


def test_symlink_escape_refuses(workspace, tmp_path):
    root = workspace.project.artifacts_dir() / "proxy"
    root.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(CodedKeyError):
        pv.ensure_proxy_manifest(workspace)


def test_basis_explicit_geometry_and_registry_free(workspace, monkeypatch):
    ws = workspace
    monkeypatch.setattr(
        "podcast_mcp.services.collaboration.share_registry.get_share_registry",
        lambda: pytest.fail("Registry was opened"),
    )
    assert pv.project_basis(ws.project, defaults=load_defaults()).clips == {}
    ws.project.clips = [
        Clip(id="a", track_id="host", source_start=0, source_end=1, timeline_start=1),
        Clip(id="b", track_id="host", source_start=0, source_end=1, timeline_start=1),
    ]
    basis = pv.project_basis(ws.project, defaults=load_defaults())
    assert set(basis.clips) == {"a", "b"}
    assert basis.history_head_id == "root"
    ws.project.clips[0].timeline_start = 2
    moved = pv.project_basis(ws.project, defaults=load_defaults())
    assert moved != basis
    assert moved.clips["a"].timeline_end == 3
    ws.project.tracks[0].gain_db = 3
    assert (
        pv.project_basis(ws.project, defaults=load_defaults()).render_hashes != moved.render_hashes
    )


def test_actual_ffmpeg_long_source_complete_chunks_and_boundary(workspace, monkeypatch):
    ws = workspace
    path = ws.project.workspace_path() / "raw/long.wav"
    rate = 8000
    t = np.arange(61 * rate) / rate
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(np.round(10000 * np.sin(t * 2 * np.pi * 440)).astype("<i2").tobytes())
    with ws.transaction():
        ws.project.tracks[0].media = MediaAsset(path="raw/long.wav")
        ws.save()
    from podcast_mcp.engines.timeline_render import render_source_with_chain
    from podcast_mcp.util.wav import open_wav

    render = pv.render_source_proxy_inputs
    pcm_checked = []

    def verify_pcm(project, inputs, out, **kwargs):
        result = render(project, inputs, out, **kwargs)
        baseline = out.with_name("long-baseline.wav")
        render_source_with_chain(
            project, project.tracks[0], baseline, engine=kwargs["engine"], defaults=load_defaults()
        )
        with open_wav(out) as actual, open_wav(baseline) as expected:
            assert actual.getparams() == expected.getparams()
            assert actual.readframes(actual.getnframes()) == expected.readframes(
                expected.getnframes()
            )
        pcm_checked.append(True)
        return result

    monkeypatch.setattr(pv, "render_source_proxy_inputs", verify_pcm)
    generation = pv.ensure_proxy_manifest(ws)
    assert pcm_checked == [True]
    artifact = generation.tracks["host"]
    assert artifact.chunk_count == 2
    assert artifact.duration_sec == pytest.approx(61, abs=0.01)
    assert artifact.chunk_sha256 == [sha256_file(_chunk(ws, artifact, index)) for index in range(2)]
    engine = FFmpegEngine()
    for index in range(2):
        start, duration = pm.chunk_window(index, artifact.duration_sec)
        assert engine.probe(_chunk(ws, artifact, index)).duration_sec == pytest.approx(
            duration, abs=0.2
        )
        assert start <= 60 <= start + duration
    assert pv.accepted_proxy_chunk_path(ws, "host", 1, expected_hash=artifact.hash).is_file()


def test_same_content_relocation_reuses_occurrence_before_render(
    workspace, monkeypatch, fast_encode
):
    ws = workspace
    _choice(ws)
    first = pv.ensure_proxy_manifest(ws)
    source = ws.project.workspace_path() / "raw/host.wav"
    relocated = source.with_name("relocated.wav")
    relocated.write_bytes(source.read_bytes())
    with ws.transaction():
        ws.project.tracks[0].media.path = "raw/relocated.wav"
        ws.save()
    render = pv.render_source_proxy_inputs

    def only_legacy(project, inputs, out, **kwargs):
        assert inputs.selector == "legacy", "Same occurrence content was rendered again"
        return render(project, inputs, out, **kwargs)

    monkeypatch.setattr(pv, "render_source_proxy_inputs", only_legacy)
    second = pv.ensure_proxy_manifest(ws)
    assert second.occurrences == first.occurrences
    assert second.artifacts == first.artifacts


def test_atomic_rename_race_preserves_existing_empty_directory(workspace, monkeypatch, fast_encode):
    original = pv.rename_noreplace
    raced = []

    def appearing(src, dst, descriptor):
        os.mkdir(dst, dir_fd=descriptor)
        raced.append(dst)
        return original(src, dst, descriptor)

    monkeypatch.setattr(pv, "rename_noreplace", appearing)
    with pytest.raises(CodedValueError) as error:
        pv.ensure_proxy_manifest(workspace)
    assert error.value.code == "proxy_artifact_damaged"
    assert len(raced) == 1
    directory = pm.proxy_dir(workspace, "host", raced[0])
    assert directory.is_dir() and list(directory.iterdir()) == []
    assert workspace.project.tracks[0].proxy is None
    assert workspace.project.render.proxy_manifests == []
    assert not list(directory.parent.glob(".proxy-*"))


def test_standalone_changed_inputs_get_new_content_hash(workspace, fast_encode):
    ws = workspace
    first = pm.ensure_track_proxy(ws, "host")
    old = pm.proxy_dir(ws, "host", first.hash) / "00000.mp3"
    before = old.read_bytes()
    with ws.transaction():
        ws.project.processing_chains = [
            ProcessingChain(
                track_id="host",
                effects=[ProcessingEffect(effect="highpass", params={"frequency": 100})],
            )
        ]
        ws.save()
    current = pm.ensure_track_proxy(ws, "host")
    assert current.hash != first.hash
    assert len(current.hash) == 64
    assert old.read_bytes() == before
    assert ws.project.render.proxy_manifests == []


def test_same_hash_preserves_object_store_metadata(workspace, fast_encode):
    ws = workspace
    first = pv.ensure_proxy_manifest(ws)
    with ws.transaction():
        ws.project.tracks[0].proxy.object_store_prefix = "proxy/host/uploaded/"
        ws.project.tracks[0].proxy.object_store_uploaded_at = "2026-10-18T00:00:00Z"
        ws.save()
    descriptor = pm.ensure_track_proxy(ws, "host")
    assert descriptor.hash == first.tracks["host"].hash
    assert descriptor.object_store_prefix == "proxy/host/uploaded/"
    assert descriptor.object_store_uploaded_at == "2026-10-18T00:00:00Z"
    assert pv.ensure_proxy_manifest(ws) == first
    assert ws.project.tracks[0].proxy.object_store_prefix == "proxy/host/uploaded/"


def test_guest_document_certificate_recovery_after_derived_save(
    workspace, monkeypatch, fast_encode
):
    from podcast_mcp.services.collaboration import sanitize_guest_document_event
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand
    from podcast_mcp.util.registry_privacy_error import RegistryPrivacyError

    ws = workspace
    service = DocumentSyncService.open(ws.path)
    try:
        before = sanitize_guest_document_event({"snapshot": service.document_snapshot()})[
            "snapshot"
        ]
    except RegistryPrivacyError as error:
        pytest.skip(f"Actual guest snapshot blocked by registry privacy guard: {error}")
    history = ws.project.history.model_dump()
    generation = pv.ensure_proxy_manifest(ws)
    assert ws.project.history.model_dump() == history
    after = sanitize_guest_document_event({"snapshot": service.document_snapshot()})["snapshot"]
    assert after["server_seq"] == before["server_seq"]
    assert after["state_token"] != before["state_token"]
    assert after["history"] == before["history"]
    assert (
        pv.project_basis(service.ws.project, defaults=load_defaults()) == generation.project_basis
    )
    saved = ws.path.read_bytes()
    monkeypatch.setattr(ws, "save", lambda: pytest.fail("Noop manifest saved again"))
    assert pv.ensure_proxy_manifest(ws) == generation
    assert ws.path.read_bytes() == saved
    reply = service.submit(
        DocumentCommand(
            type="AddComment",
            payload={"body": "After derived save", "author": "viewer", "timeline_start": 0.5},
            client_id="proxy-proof",
            client_seq=1,
            role="viewer",
        ),
        audience="guest",
    )
    assert reply["ok"]
    recovery = sanitize_guest_document_event({"snapshot": service.document_snapshot()})["snapshot"]
    assert recovery["server_seq"] > before["server_seq"]
    assert any(comment["body"] == "After derived save" for comment in recovery["comments"])


def test_retry_syncs_complete_orphan_before_acceptance(workspace, monkeypatch, fast_encode):
    ws = workspace
    sync = pv._sync_directory
    parent_syncs = []

    def fail_first_parent(directory):
        if directory.name == "host":
            parent_syncs.append(directory)
            if len(parent_syncs) == 1:
                raise OSError("parent sync failed after rename")
        return sync(directory)

    monkeypatch.setattr(pv, "_sync_directory", fail_first_parent)
    before = ws.path.read_bytes()
    with pytest.raises(OSError, match="parent sync failed"):
        pv.ensure_proxy_manifest(ws)
    assert ws.path.read_bytes() == before
    assert ws.project.render.proxy_manifests == []
    orphan = next((ws.project.artifacts_dir() / "proxy/host").glob("[0-9a-f]*/00000.mp3"))
    with pytest.raises(CodedKeyError):
        pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash=orphan.parent.name)
    accepted = pv.ensure_proxy_manifest(ws)
    assert accepted.tracks["host"].hash == orphan.parent.name
    assert len(parent_syncs) == 2


@pytest.mark.parametrize("mode", ["new", "imported16", "standalone64"])
def test_authority_save_follows_complete_durable_namespace(
    workspace, monkeypatch, fast_encode, mode
):
    ws = workspace
    if mode == "imported16":
        _bootstrap(ws, monkeypatch)
    elif mode == "standalone64":
        pm.ensure_track_proxy(ws, "host")
    fsync = os.fsync
    events = []
    saves = []

    def record_fsync(descriptor):
        observed = os.fstat(descriptor)
        events.append((observed.st_dev, observed.st_ino))
        return fsync(descriptor)

    save = ws.save

    def record_save():
        saves.append(events.copy())
        return save()

    monkeypatch.setattr(pv.os, "fsync", record_fsync)
    monkeypatch.setattr(ws, "save", record_save)
    generation = pv.ensure_proxy_manifest(ws)
    leaf = _chunk(ws, generation.tracks["host"]).parent
    namespace = []
    for directory in (leaf, *leaf.parents):
        observed = directory.stat()
        namespace.append((observed.st_dev, observed.st_ino))
        if directory == ws.project.workspace_path().resolve():
            break
    assert len(saves) == 1
    assert saves[0][-len(namespace) :] == namespace
    chunk = _chunk(ws, generation.tracks["host"]).stat()
    assert (chunk.st_dev, chunk.st_ino) in saves[0][: -len(namespace)]


@pytest.mark.parametrize("ancestor", ["host", "proxy", "artifacts", "workspace"])
def test_namespace_sync_failure_preserves_saved_authority_and_retries(
    workspace, monkeypatch, fast_encode, ancestor
):
    ws = workspace
    sync = pv._sync_directory
    root = ws.project.workspace_path().resolve()
    target = {
        "host": ws.project.artifacts_dir() / "proxy/host",
        "proxy": ws.project.artifacts_dir() / "proxy",
        "artifacts": ws.project.artifacts_dir(),
        "workspace": root,
    }[ancestor]
    failed = False

    def fail_once(directory):
        nonlocal failed
        if directory == target and not failed:
            failed = True
            raise OSError("namespace fsync failed")
        return sync(directory)

    monkeypatch.setattr(pv, "_sync_directory", fail_once)
    saved = ws.path.read_bytes()
    with pytest.raises(OSError, match="namespace fsync failed"):
        pv.ensure_proxy_manifest(ws)
    assert ws.path.read_bytes() == saved
    assert ws.project.render.proxy_manifests == []
    assert ws.project.tracks[0].proxy is None
    orphan = next((ws.project.artifacts_dir() / "proxy/host").glob("[0-9a-f]*/00000.mp3"))
    original = orphan.read_bytes()
    with pytest.raises(CodedKeyError):
        pv.accepted_proxy_chunk_path(ws, "host", 0, expected_hash=orphan.parent.name)
    accepted = pv.ensure_proxy_manifest(ws)
    assert accepted.tracks["host"].hash == orphan.parent.name
    assert orphan.read_bytes() == original


@pytest.mark.parametrize("probe_status", ["ok", "blocked", "unknown"])
def test_share_cors_fallback_preserves_current_complete_restore_generation(
    workspace, monkeypatch, fast_encode, probe_status
):
    from podcast_mcp.services.collaboration import share
    from podcast_mcp.services.media import object_store_cors as cors

    ws = workspace
    _choice(ws)
    generation = pv.ensure_proxy_manifest(ws)
    ws.project.tracks[0].proxy = generation.tracks["host"].model_copy()
    ws.save()
    saved = ws.path.read_bytes()
    probes = []
    monkeypatch.setattr(
        share, "require_share_cap", lambda *_: ({"capabilities": ["play", "view"]}, ws)
    )
    monkeypatch.setattr(
        "podcast_mcp.services.media.presigned_proxy_urls",
        lambda *_a, **_k: ["https://store.example.test/chunk"],
    )
    monkeypatch.setattr(
        "podcast_mcp.services.collaboration.share_page.share_public_origin",
        lambda: "https://share.example.test",
    )

    def probe(url, origin):
        probes.append((url, origin))
        return cors.probe_guest_cors(
            url,
            origin,
            fetch=lambda *_: (
                None
                if probe_status == "unknown"
                else ({} if probe_status == "blocked" else {"access-control-allow-origin": origin})
            ),
        )

    monkeypatch.setattr("podcast_mcp.services.media.cached_guest_cors", probe)
    monkeypatch.setattr(ws, "save", lambda: pytest.fail("Guest CORS probe wrote the project"))
    body = share.share_proxy_manifest("token")
    assert body["project_basis"] == generation.project_basis.model_dump(mode="json")
    assert body["revision"] == generation.revision
    assert body["artifacts"] == pv.proxy_manifest_payload(generation, "token")["artifacts"]
    assert body["tracks"]["host"]["hash"] == generation.tracks["host"].hash
    assert body["occurrences"] == {
        "selected": {
            "artifactId": generation.occurrences["selected"].artifact_id,
            "outputTrackId": "host",
        }
    }
    for descriptor in body["artifacts"].values():
        assert descriptor["urls"][0].startswith("/api/review/token/daw/proxy/host/")
        assert pv.accepted_proxy_chunk_path(
            ws, "host", 0, expected_hash=descriptor["hash"]
        ).is_file()
    assert probes == [("https://store.example.test/chunk", "https://share.example.test")]
    if probe_status == "blocked":
        hash_ = generation.tracks["host"].hash
        assert body["tracks"]["host"]["urls"] == [f"/api/review/token/daw/proxy/host/{hash_}/0"]
        assert share.share_proxy_chunk_path("token", "host", 0, proxy_hash=hash_) == _chunk(
            ws, generation.tracks["host"]
        )
        assert body["object_store_cors"] == {
            "status": "blocked",
            "origin": "https://share.example.test",
        }
    else:
        assert body["tracks"]["host"]["urls"] == ["https://store.example.test/chunk"]
        assert "object_store_cors" not in body
    assert ws.path.read_bytes() == saved
