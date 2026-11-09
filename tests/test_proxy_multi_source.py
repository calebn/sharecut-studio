from __future__ import annotations

import wave

import numpy as np
import pytest

from podcast_mcp.models import Clip, MediaAsset, Track
from podcast_mcp.models.episode import SourceRecording
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media import proxy_media as pm
from podcast_mcp.services.media import proxy_variants as pv
from podcast_mcp.util.hashing import sha256_file


@pytest.fixture(autouse=True)
def _granted_writes():
    with write_grant(WriteGrantKind.LEGACY_CLI):
        yield


@pytest.fixture
def two_recording_track(minimal_project, monkeypatch):
    ws = ProjectWorkspace.open(minimal_project)
    second = ws.project.workspace_path() / "raw/host_src1.wav"
    with wave.open(str(second), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(np.full(96000, 12000, dtype="<i2").tobytes())
    ws.project.tracks = [Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav"))]
    ws.project.sources = [
        SourceRecording(id="host_src0", path="raw/host.wav"),
        SourceRecording(id="host_src1", path="raw/host_src1.wav"),
    ]
    ws.project.clips = [
        Clip(id="first", track_id="host", source_id="host_src0",
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
        output.write_bytes(f"{sha256_file(wav)}:{start}:{duration}".encode())

    monkeypatch.setattr(pm, "_encode_chunk", encode)
    return ws


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
