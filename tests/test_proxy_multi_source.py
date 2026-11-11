from __future__ import annotations

import dataclasses
import json
import wave

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.source_proxy_audio import SourceProxyInputs
from podcast_mcp.models import Clip, MediaAsset, Track, load_project, save_project
from podcast_mcp.models.episode import ClipBleedRestore, SourceRecording, SourceSpan
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media import proxy_media as pm
from podcast_mcp.services.media import proxy_variants as pv
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import sha256_file


@pytest.fixture(autouse=True)
def _granted_writes():
    with write_grant(WriteGrantKind.LEGACY_CLI):
        yield


def _write_wav(path, value):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(np.full(96000, value, dtype="<i2").tobytes())


@pytest.fixture
def two_recording_track(minimal_project, monkeypatch):
    ws = ProjectWorkspace.open(minimal_project)
    second = ws.project.workspace_path() / "raw/host_src1.wav"
    _write_wav(second, 12000)
    ws.project.tracks = [Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav"))]
    ws.project.sources = [
        SourceRecording(id="host_src0", path="raw/host.wav"),
        SourceRecording(id="host_src1", path="raw/host_src1.wav"),
    ]
    ws.project.clips = [
        Clip(
            id="first",
            track_id="host",
            source_id="host_src0",
            source_start=0,
            source_end=1,
            timeline_start=0,
        ),
        Clip(
            id="second",
            track_id="host",
            source_id="host_src1",
            source_start=0.5,
            source_end=1.5,
            timeline_start=1,
        ),
    ]
    ws.save()

    def encode(_engine, wav, output, start, duration, **_kwargs):
        output.write_bytes(f"{sha256_file(wav)}:{_peak(wav)}:{start}:{duration}".encode())

    monkeypatch.setattr(pm, "_encode_chunk", encode)
    return ws


def _peak(wav):
    with wave.open(str(wav), "rb") as handle:
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")
    return int(np.abs(samples).max())


def _bytes(ws, artifact):
    directory = pv.artifact_directory(ws.project, artifact.context_track_id, artifact.hash)
    return (directory / "00000.mp3").read_bytes()


def test_clip_from_second_recording_plays_its_own_recording(two_recording_track):
    ws = two_recording_track
    generation = pv.ensure_proxy_manifest(ws)
    assert "second" in generation.occurrences
    assert "first" not in generation.occurrences
    second = generation.artifacts[generation.occurrences["second"].artifact_id]
    assert second.context_track_id == "host"
    assert _bytes(ws, second) != _bytes(ws, generation.tracks["host"])
    assert generation.occurrences["second"].bakes_mutes is False
    assert abs(int(_bytes(ws, second).split(b":")[1]) - 12000) < 200


def test_clips_on_one_recording_share_one_artifact(two_recording_track):
    ws = two_recording_track
    ws.project.clips.append(
        Clip(
            id="third",
            track_id="host",
            source_id="host_src1",
            source_start=2,
            source_end=3,
            timeline_start=2,
        )
    )
    ws.save()
    generation = pv.ensure_proxy_manifest(ws)
    assert (
        generation.occurrences["third"].artifact_id == generation.occurrences["second"].artifact_id
    )
    assert len(generation.artifacts) == 1


def test_recording_content_is_part_of_the_artifact_hash(two_recording_track):
    ws = two_recording_track
    before = pv.ensure_proxy_manifest(ws)
    _write_wav(ws.project.workspace_path() / "raw/host_src1.wav", -9000)
    after = pv.ensure_proxy_manifest(ProjectWorkspace.open(ws.path))
    assert after.occurrences["second"].artifact_id != before.occurrences["second"].artifact_id
    assert after.revision != before.revision
    assert after.tracks["host"].hash == before.tracks["host"].hash


def test_bleed_restore_occurrence_wins_over_recording_binding(two_recording_track):
    ws = two_recording_track
    source = ws.project.workspace_path() / "raw/host_src1.wav"
    clip = next(c for c in ws.project.clips if c.id == "second")
    clip.bleed_restore = ClipBleedRestore(
        source_sha256=sha256_file(source), regions=[SourceSpan(start_s=0.6, end_s=0.9)]
    )
    ws.save()
    generation = pv.ensure_proxy_manifest(ws)
    assert generation.occurrences["second"].bakes_mutes is False
    assert list(generation.occurrences) == ["second"]


def _restore_second(ws):
    source = ws.project.workspace_path() / "raw/host_src1.wav"
    clip = next(c for c in ws.project.clips if c.id == "second")
    clip.bleed_restore = ClipBleedRestore(
        source_sha256=sha256_file(source), regions=[SourceSpan(start_s=0.6, end_s=0.9)]
    )
    return clip


def test_clip_with_unknown_source_id_fails_with_clip_source_missing(two_recording_track):
    ws = two_recording_track
    next(c for c in ws.project.clips if c.id == "second").source_id = "nope"
    ws.save()
    with pytest.raises(CodedValueError) as raised:
        pv.ensure_proxy_manifest(ws)
    assert raised.value.code == "clip_source_missing"


def test_restored_clip_with_unknown_source_id_fails_with_clip_source_missing(two_recording_track):
    ws = two_recording_track
    _restore_second(ws).source_id = "nope"
    ws.save()
    with pytest.raises(CodedValueError) as raised:
        pv.ensure_proxy_manifest(ws)
    assert raised.value.code == "clip_source_missing"


def test_inputs_bake_mutes_only_when_the_gate_attenuates(two_recording_track):
    ws = two_recording_track
    _restore_second(ws)
    ws.save()
    captured = SourceProxyInputs.capture_occurrence(
        ws.project, "second", FFmpegEngine(), defaults=load_defaults()
    )
    assert captured.regions
    assert captured.bakes_mutes is False
    gate = BleedGatePlan(attenuation_spans=((0.6, 0.9),), reduction="mute")
    assert dataclasses.replace(captured, gate=gate).bakes_mutes is True
    unity = BleedGatePlan(attenuation_spans=((0.6, 0.9),), reduction="attenuate", attenuation_db=0)
    assert unity.floor_gain == 1
    assert dataclasses.replace(captured, gate=unity).bakes_mutes is False
    assert dataclasses.replace(captured, gate=gate, regions=()).bakes_mutes is False


def test_missing_recording_file_fails_instead_of_playing_the_primary(two_recording_track):
    ws = two_recording_track
    (ws.project.workspace_path() / "raw/host_src1.wav").unlink()
    with pytest.raises(Exception) as raised:
        pv.ensure_proxy_manifest(ws)
    assert getattr(raised.value, "code", None) != "proxy_not_found"
    assert not ws.project.render.proxy_manifests


def test_generation_without_bakes_mutes_is_dropped_on_load(two_recording_track):
    ws = two_recording_track
    pv.ensure_proxy_manifest(ws)
    document = json.loads(ws.path.read_text())
    for generation in document["render"]["proxy_manifests"]:
        for binding in generation["occurrences"].values():
            del binding["bakes_mutes"]
    ws.path.write_text(json.dumps(document))
    reloaded = load_project(ws.path)
    assert reloaded.render.proxy_manifests == []
    save_project(reloaded, ws.path)
    rebuilt = pv.ensure_proxy_manifest(ProjectWorkspace.open(ws.path))
    assert rebuilt.occurrences["second"].bakes_mutes is False


def test_mixed_valid_and_invalid_generations_keep_the_valid_one(two_recording_track):
    ws = two_recording_track
    older = pv.ensure_proxy_manifest(ws)
    _write_wav(ws.project.workspace_path() / "raw/host_src1.wav", -9000)
    newer = pv.ensure_proxy_manifest(ProjectWorkspace.open(ws.path))
    assert newer.revision != older.revision
    document = json.loads(ws.path.read_text())
    generations = document["render"]["proxy_manifests"]
    assert [g["revision"] for g in generations] == [newer.revision, older.revision]
    for binding in generations[1]["occurrences"].values():
        del binding["bakes_mutes"]
    ws.path.write_text(json.dumps(document))
    reloaded = load_project(ws.path)
    assert [g.revision for g in reloaded.render.proxy_manifests] == [newer.revision]
    assert reloaded.render.proxy_manifests[0].occurrences["second"].bakes_mutes is False


def test_tracks_only_generation_is_kept_on_load(two_recording_track):
    ws = two_recording_track
    for clip in ws.project.clips:
        clip.source_id = "host_src0"
    ws.save()
    generation = pv.ensure_proxy_manifest(ws)
    assert generation.occurrences == {}
    reloaded = load_project(ws.path)
    assert [g.revision for g in reloaded.render.proxy_manifests] == [generation.revision]
    assert list(reloaded.render.proxy_manifests[0].tracks) == ["host"]
