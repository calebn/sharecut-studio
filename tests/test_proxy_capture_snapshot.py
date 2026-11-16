from __future__ import annotations

import cProfile
from pathlib import Path

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media.proxy_variants import ManifestInputs, capture_manifest_inputs
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.project_state import snapshot_project
from test_guest_audio_freshness import _template
from test_proxy_key_state_sweep import CONFIGURATIONS, _configuration


@pytest.fixture(scope="module")
def gated_template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _template(tmp_path_factory.mktemp("capture-gated"))


@pytest.fixture(scope="module")
def ungated_template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _template(tmp_path_factory.mktemp("capture-ungated"), gated=False)


@pytest.fixture(params=CONFIGURATIONS)
def workspace(
    request: pytest.FixtureRequest,
    gated_template: Path,
    ungated_template: Path,
    tmp_path: Path,
) -> tuple[str, ProjectWorkspace]:
    name = request.param
    ws, _ = _configuration(name, gated_template, ungated_template, tmp_path)
    return name, ws


def _capture(ws: ProjectWorkspace, track_id: str | None = None) -> tuple[ManifestInputs, int]:
    engine = FFmpegEngine()
    defaults = ws.effective_config()
    profile = cProfile.Profile()
    with batch_scope():
        inputs = profile.runcall(capture_manifest_inputs, ws.project, engine, defaults, track_id)
        for sealed in inputs.all():
            sealed.validate(ws.project, engine, defaults=defaults)
            assert sealed.source.is_file()
            assert len(sealed.identity_payload["recording"]["sha256"]) == 64
            assert all(len(digest) == 64 for digest in sealed.identity_payload["binaries"])
        artifacts = inputs.artifacts(ws.project, defaults)
    assert len(artifacts) == len(inputs.all())
    assert {context for context, _ in artifacts} == {
        sealed.context_track_id for sealed in inputs.all()
    }
    assert all(len(hash_) == 64 for _, hash_ in artifacts)
    snapshots = sum(
        entry.callcount for entry in profile.getstats() if entry.code is snapshot_project.__code__
    )
    return inputs, snapshots


def test_a_full_manifest_owns_one_project_snapshot(
    workspace: tuple[str, ProjectWorkspace],
) -> None:
    configuration, ws = workspace
    inputs, snapshots = _capture(ws)
    recordings = {(role, f"{role}-src") for role in ("music", "sfx", "intro", "outro")}
    if configuration == "ungated":
        recordings.add(("guest", "guest-src"))
    assert set(inputs.legacy) == {"host", "guest"}
    assert set(inputs.occurrences) == (set() if configuration == "ungated" else {"g1"})
    assert set(inputs.recordings) == recordings
    assert inputs.clip_keys == {
        **{
            f"{role}{index}": (role, f"{role}-src")
            for role in ("music", "sfx", "intro", "outro")
            for index in (1, 2)
        },
        **({"g1": ("guest", "guest-src")} if configuration == "ungated" else {}),
    }
    assert all(sealed.selector == "legacy" for sealed in inputs.legacy.values())
    assert all(sealed.selector == "occurrence" for sealed in inputs.occurrences.values())
    assert all(sealed.selector == "recording" for sealed in inputs.recordings.values())
    assert snapshots == 1, f"one manifest made {snapshots} whole-project snapshots"


def test_a_legacy_track_capture_owns_one_project_snapshot(
    workspace: tuple[str, ProjectWorkspace],
) -> None:
    _, ws = workspace
    inputs, snapshots = _capture(ws, "host")
    assert set(inputs.legacy) == {"host"}
    assert not inputs.occurrences
    assert not inputs.recordings
    assert not inputs.clip_keys
    (sealed,) = inputs.all()
    assert sealed.selector == "legacy"
    assert sealed.context_track_id == "host"
    assert sealed.source.name == "host.wav"
    assert snapshots == 1


def test_an_empty_manifest_needs_no_project_snapshot(minimal_project: Path) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    assert not ws.project.tracks
    assert not ws.project.clips
    inputs, snapshots = _capture(ws)
    assert not inputs.all()
    assert not inputs.clip_keys
    assert snapshots == 0
