from __future__ import annotations

import cProfile
from dataclasses import fields, is_dataclass
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.source_proxy_audio import (
    SourceProxyInputs,
    SourceProxySelection,
    capture_source_proxy_inputs,
)
from podcast_mcp.models import EpisodeProject, ProcessingChain, ProcessingEffect
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media.proxy_variants import ManifestInputs, capture_manifest_inputs
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import sha256_file
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


@pytest.fixture
def mixed_workspace(
    gated_template: Path, ungated_template: Path, tmp_path: Path
) -> ProjectWorkspace:
    ws, _ = _configuration("restored", gated_template, ungated_template, tmp_path)
    return ws


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


def _assert_no_project(value: Any) -> None:
    assert not isinstance(value, EpisodeProject)
    if is_dataclass(value) and not isinstance(value, type):
        for field in fields(value):
            _assert_no_project(getattr(value, field.name))
    elif isinstance(value, dict):
        for item in value.values():
            _assert_no_project(item)
    elif isinstance(value, (tuple, list)):
        for item in value:
            _assert_no_project(item)


def test_batch_preparation_and_returned_identity_do_not_mutate_siblings_or_project(
    mixed_workspace: ProjectWorkspace, tmp_path: Path
) -> None:
    ws = mixed_workspace
    model = tmp_path / "shared.rnnn"
    model.write_bytes(b"capture identity model")
    ws.project.processing_chains = [
        ProcessingChain(
            track_id=tid,
            effects=[ProcessingEffect(effect="arnndn", params={"model": str(model)})],
        )
        for tid in ("host", "guest")
    ]
    before = ws.project.model_dump_json()
    inputs, _ = _capture(ws)
    assert ws.project.model_dump_json() == before
    _assert_no_project(inputs)
    identities = [sealed.identity_json for sealed in inputs.all()]
    for sealed in (*inputs.legacy.values(), *inputs.occurrences.values()):
        assert model.name in sealed.recipe
        assert "sha256_" + sha256_file(model) in sealed.identity_payload["recipe"]
        assert str(model) not in sealed.identity_json
        payload = sealed.identity_payload
        payload["recording"]["source_id"] = "changed"
        payload["gate"]["floor_gain"] = -1
    assert [sealed.identity_json for sealed in inputs.all()] == identities
    for sealed in inputs.all():
        sealed.validate(ws.project, FFmpegEngine(), defaults=ws.effective_config())
    assert ws.project.model_dump_json() == before


def test_a_later_operation_observes_project_changes_and_rejects_old_inputs(
    mixed_workspace: ProjectWorkspace,
) -> None:
    ws = mixed_workspace
    first, _ = _capture(ws)
    ws.project.tracks[0].label += " renamed"
    second, snapshots = _capture(ws)
    assert snapshots == 1
    assert [sealed.identity_json for sealed in first.all()] == [
        sealed.identity_json for sealed in second.all()
    ]
    for old, new in zip(first.all(), second.all(), strict=True):
        assert old.dependencies.project_json != new.dependencies.project_json
        with pytest.raises(CodedValueError) as error:
            old.validate(ws.project, FFmpegEngine(), defaults=ws.effective_config())
        assert error.value.code == "bleed_restore_inputs_changed"


def test_a_project_change_between_seals_is_refused_by_immediate_validation(
    mixed_workspace: ProjectWorkspace, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = mixed_workspace
    validate = SourceProxyInputs.validate
    validated = []

    def mutate_after_first_validation(self, project, engine, *, defaults):
        validated.append(self.context_track_id)
        validate(self, project, engine, defaults=defaults)
        if len(validated) == 1:
            project.tracks[0].label += " changed between seals"

    monkeypatch.setattr(SourceProxyInputs, "validate", mutate_after_first_validation)
    with pytest.raises(CodedValueError) as error:
        capture_manifest_inputs(ws.project, FFmpegEngine(), ws.effective_config())
    assert error.value.code == "bleed_restore_inputs_changed"
    assert validated == ["host", "guest"]


def test_scalar_occurrence_uses_the_single_snapshot_batch_path(
    mixed_workspace: ProjectWorkspace,
) -> None:
    ws = mixed_workspace
    engine, defaults = FFmpegEngine(), ws.effective_config()
    profile = cProfile.Profile()
    scalar = profile.runcall(
        SourceProxyInputs.capture_occurrence, ws.project, "g1", engine, defaults=defaults
    )
    calls = {entry.code: entry.callcount for entry in profile.getstats()}
    assert calls[snapshot_project.__code__] == 1
    assert calls[capture_source_proxy_inputs.__code__] == 1
    batch = capture_source_proxy_inputs(
        ws.project, SourceProxySelection(occurrences=("g1",)), engine, defaults=defaults
    )
    assert not batch.legacy
    assert not batch.recordings
    assert list(batch.occurrences) == ["g1"]
    assert scalar == batch.occurrences["g1"]
