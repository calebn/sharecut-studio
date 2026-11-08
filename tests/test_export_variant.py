from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest


def _current_mix(project_path: Path, sample_wav: Path):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import (
        mix_gains,
        premix_path,
        write_premix_hash,
        write_stem_hash,
    )
    from podcast_mcp.models import MediaAsset, Track, TrackRole, save_project
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.util.tracks import stem_path

    workspace = ProjectWorkspace.open(project_path)
    source_copy = workspace.project.raw_dir() / "host.wav"
    source_copy.parent.mkdir(parents=True, exist_ok=True)
    source_copy.write_bytes(sample_wav.read_bytes())
    workspace.project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(workspace.project, project_path)
    workspace = ProjectWorkspace.open(project_path)
    defaults = load_defaults()
    stem = stem_path(workspace.project, "host")
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    os.utime(stem, ns=(1_000_000_000, 1_000_000_000))
    write_stem_hash(workspace.project, "host", defaults=defaults)
    premix = premix_path(workspace.project)
    premix.write_bytes(sample_wav.read_bytes())
    write_premix_hash(
        workspace.project, mix_gains(workspace.project), trim_db=None, defaults=defaults
    )
    return workspace


class _FakeEngine:
    def __init__(self, source: Path, *, qc: dict[str, float] | None = None) -> None:
        from podcast_mcp.engines.mastering import LoudnormPlan

        self.source = source
        self.qc = qc
        self.target = -16.0
        self.master_targets: list[float] = []
        self.master_calls = 0
        self.measure_calls = 0
        self.encode_calls = 0
        self.cancelled = False
        self.mutate_source_on_encode = False
        self.plan = LoudnormPlan(two_pass=True)

    def master_loudness(self, source: Path, output: Path, *, integrated_lufs: float, **_kwargs):
        from podcast_mcp.engines.mastering import MasterResult

        self.master_calls += 1
        self.target = integrated_lufs
        self.master_targets.append(integrated_lufs)
        output.write_bytes(source.read_bytes())
        return MasterResult(output, self.plan, None, None, None)

    def measure_loudness_full(self, _path: Path):
        self.measure_calls += 1
        return self.qc or {"integrated_lufs": self.target, "true_peak_db": -2.0, "lra": 7.0}

    def supports_encode(self, _codec: str, _muxer: str) -> bool:
        return True

    def export_audio(self, _source: Path, output: Path, **_kwargs) -> None:
        self.encode_calls += 1
        output.write_bytes(b"encoded variant")
        if self.mutate_source_on_encode:
            content = bytearray(self.source.read_bytes())
            content[44] ^= 1
            stamp = self.source.stat()
            self.source.write_bytes(content)
            os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.cancelled = True


def _canonical_snapshot(workspace) -> dict[Path, bytes | None]:
    from podcast_mcp.engines.play_audit import premix_path
    from podcast_mcp.export.names import sanitize_export_stem
    from podcast_mcp.feed.inputs import feed_path
    from podcast_mcp.util.tracks import stem_path

    project = workspace.project
    export_stem = sanitize_export_stem(project.name)
    paths = [
        workspace.path,
        project.artifacts_dir() / "mastered.wav",
        project.artifacts_dir() / "mastered.hash",
        project.artifacts_dir() / "master_qc.json",
        project.artifacts_dir() / "export_qc.json",
        premix_path(project),
        stem_path(project, "host"),
        project.export_dir() / f"{export_stem}.wav",
        project.export_dir() / f"{export_stem}.mp3",
        feed_path(project),
        project.history_dir() / "index.json",
    ]
    paths.extend(
        project.history_dir() / "snapshots" / entry.snapshot_file
        for entry in project.history.entries
    )
    paths.extend(
        project.workspace_path() / version.audio_relpath for version in project.review.versions
    )
    return {path: path.read_bytes() if path.is_file() else None for path in paths}


def _seed_canonical_outputs(workspace) -> None:
    from podcast_mcp.export.names import sanitize_export_stem
    from podcast_mcp.feed.inputs import feed_path
    from podcast_mcp.models import ReviewMixVersion, save_project
    from podcast_mcp.models.history import HistoryEntry, ProjectHistory
    from podcast_mcp.project.store import (
        history_index_path,
        history_snapshot_path,
        snapshot_from_project,
    )
    from podcast_mcp.util.atomic_json import write_json_atomic

    project = workspace.project
    export_stem = sanitize_export_stem(project.name)
    paths = (
        workspace.path,
        project.artifacts_dir() / "mastered.wav",
        project.artifacts_dir() / "mastered.hash",
        project.artifacts_dir() / "master_qc.json",
        project.artifacts_dir() / "export_qc.json",
        project.export_dir() / f"{export_stem}.wav",
        project.export_dir() / f"{export_stem}.mp3",
        feed_path(project),
    )
    for index, path in enumerate(paths):
        if path == workspace.path:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"canonical artifact {index}".encode())
    version_path = project.workspace_path() / "artifacts" / "review" / "version-1" / "audio.wav"
    version_path.parent.mkdir(parents=True, exist_ok=True)
    version_path.write_bytes(b"saved shared review version")
    history_entry = HistoryEntry(
        id="preserve01",
        label="Saved edit",
        snapshot_file="preserve01.json",
    )
    project.history = ProjectHistory(cursor=0, entries=[history_entry])
    index_path = history_index_path(project)
    snapshot_path = history_snapshot_path(index_path, history_entry.id)
    project.review.versions.append(
        ReviewMixVersion(
            id="version-1",
            label="Saved review",
            created_at="2026-11-08T00:00:00Z",
            audio_relpath="artifacts/review/version-1/audio.wav",
            sha256=hashlib.sha256(b"saved shared review version").hexdigest(),
            source="test fixture",
        )
    )
    write_json_atomic(snapshot_path, snapshot_from_project(project).model_dump(mode="json"))
    write_json_atomic(index_path, project.history.model_dump(mode="json"))
    save_project(project, workspace.path)


def test_service_exports_isolated_bundle_and_reuses_a_b_a(minimal_project, sample_wav, monkeypatch):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)
    _seed_canonical_outputs(workspace)
    before = _canonical_snapshot(workspace)
    service = PipelineService(workspace)

    first = service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "flac"}])
    second = service.export_variant(ExportTarget.STREAMING, formats=[{"ext": "flac"}])
    third = service.export_variant(ExportTarget.BROADCAST, formats=[{"ext": "flac"}])
    first_again = service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "flac"}])

    assert first.file_ids == first_again.file_ids
    assert first.file_ids != second.file_ids
    assert first.target is ExportTarget.PODCAST
    assert second.target is ExportTarget.STREAMING
    assert third.target is ExportTarget.BROADCAST
    assert [
        first.master.target.integrated_lufs,
        second.master.target.integrated_lufs,
        third.master.target.integrated_lufs,
    ] == [-16.0, -14.0, -23.0]
    assert engine.master_targets == [-16.0, -14.0, -23.0]
    assert engine.master_calls == 3
    assert engine.encode_calls == 3
    assert _canonical_snapshot(workspace) == before
    listed = ExportFilesService(workspace).list()
    variants = [entry for entry in listed if entry.id.startswith("variants/")]
    assert {entry.id for entry in variants} == set(
        first.file_ids + second.file_ids + third.file_ids
    )
    assert all(entry.current for entry in variants)
    assert all(ExportFilesService(workspace).open(entry.id).path.is_file() for entry in variants)


def test_default_wav_and_explicit_wav_produce_one_file(minimal_project, sample_wav, monkeypatch):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)
    defaults = PipelineService(workspace)._run_defaults()
    assert defaults["export"]["wav"] is True

    result = PipelineService(workspace).export_variant(
        ExportTarget.PODCAST, formats=[{"ext": "wav"}]
    )

    assert result.file_ids == (f"variants/{result.file_ids[0].split('/')[1]}/audio.wav",)
    assert engine.encode_calls == 0
    assert ExportFilesService(workspace).open(result.file_ids[0]).path.is_file()


def test_explicit_wav_is_admitted_when_default_wav_is_disabled(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module

    workspace = _current_mix(minimal_project, sample_wav)
    service = PipelineService(workspace)
    defaults = load_defaults()
    service._run_defaults = lambda: {
        **defaults,
        "export": {**defaults["export"], "wav": False},
    }
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)

    result = service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "wav"}])

    assert len(result.file_ids) == 1
    assert result.file_ids[0].endswith("/audio.wav")
    assert engine.encode_calls == 0
    assert ExportFilesService(workspace).open(result.file_ids[0]).path.is_file()


def test_ambient_bundle_file_does_not_invalidate_registered_audio(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedFileNotFoundError

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)
    service = PipelineService(workspace)
    result = service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "flac"}])
    bundle = workspace.project.export_dir() / result.file_ids[0]
    (bundle.parent / ".DS_Store").write_bytes(b"ambient metadata")
    (bundle.parent / "unregistered.wav").write_bytes(b"unregistered payload")
    files = ExportFilesService(workspace)

    flac_id = next(file_id for file_id in result.file_ids if file_id.endswith("/audio.flac"))
    assert files.open(flac_id).path.read_bytes() == b"encoded variant"
    with pytest.raises(CodedFileNotFoundError):
        files.open(f"variants/{bundle.parent.name}/unregistered.wav")
    repeated = service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "flac"}])

    assert repeated.file_ids == result.file_ids
    assert engine.master_calls == 1
    assert engine.encode_calls == 1


def test_empty_encoder_output_is_not_committed_and_healthy_retry_succeeds(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    unhealthy = _FakeEngine(sample_wav)
    unhealthy.export_audio = lambda _source, output, **_kwargs: output.write_bytes(b"")
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: unhealthy)
    service = PipelineService(workspace)

    with pytest.raises(CodedValueError) as caught:
        service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "flac"}])

    assert caught.value.code == "export_variant_unmeasured"
    variants = workspace.project.export_dir() / "variants"
    assert not variants.exists() or not any(path.name[0].isalnum() for path in variants.iterdir())
    healthy = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: healthy)
    result = service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "flac"}])

    assert any(file_id.endswith("/audio.flac") for file_id in result.file_ids)
    assert healthy.master_calls == 1
    assert healthy.encode_calls == 1


def test_identity_tracks_target_source_formats_metadata_and_qc_settings(
    minimal_project, sample_wav
):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import premix_path
    from podcast_mcp.services.pipeline import ExportTarget
    from podcast_mcp.services.pipeline.export_variant import variant_identity

    workspace = _current_mix(minimal_project, sample_wav)
    defaults = load_defaults()
    base = variant_identity(workspace.project, defaults, ExportTarget.PODCAST, [{"ext": "mp3"}])
    assert (
        variant_identity(workspace.project, defaults, ExportTarget.STREAMING, [{"ext": "mp3"}])
        != base
    )
    assert (
        variant_identity(
            workspace.project, defaults, ExportTarget.PODCAST, [{"ext": "mp3", "bitrate_kbps": 192}]
        )
        != base
    )
    changed_master = {**defaults, "master": {**defaults["master"], "true_peak_db": -1.0}}
    assert (
        variant_identity(workspace.project, changed_master, ExportTarget.PODCAST, [{"ext": "mp3"}])
        != base
    )
    changed_limits = {
        **defaults,
        "master": {**defaults["master"], "qc_lufs_tolerance_lu": 0.25},
    }
    assert (
        variant_identity(workspace.project, changed_limits, ExportTarget.PODCAST, [{"ext": "mp3"}])
        != base
    )
    workspace.project.meta.name = "renamed episode"
    assert (
        variant_identity(workspace.project, defaults, ExportTarget.PODCAST, [{"ext": "mp3"}])
        != base
    )
    workspace.project.meta.name = "test_episode"
    premix = premix_path(workspace.project)
    content = bytearray(premix.read_bytes())
    stamp = premix.stat()
    content[44] ^= 1
    premix.write_bytes(content)
    os.utime(premix, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    changed_source = variant_identity(
        workspace.project, defaults, ExportTarget.PODCAST, [{"ext": "mp3"}]
    )
    assert changed_source[0] != base[0]
    assert changed_source[1] != base[1]


def test_service_refuses_stale_mix_before_mastering(minimal_project, sample_wav, monkeypatch):
    from podcast_mcp.engines.play_audit import premix_hash_path
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    premix_hash_path(workspace.project).write_text("unknown\n", encoding="utf-8")
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)

    with pytest.raises(CodedValueError) as caught:
        PipelineService(workspace).export_variant(ExportTarget.PODCAST)

    assert caught.value.code == "stale_mix"
    assert engine.master_calls == 0


@pytest.mark.parametrize(
    ("measured", "expected_code"),
    [
        ({"integrated_lufs": -17.0, "true_peak_db": -2.0}, "export_variant_qc_failed"),
        ({"integrated_lufs": float("nan"), "true_peak_db": -2.0}, "export_variant_unmeasured"),
    ],
)
def test_bad_measurement_publishes_no_variant(
    minimal_project, sample_wav, monkeypatch, measured, expected_code
):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav, qc=measured)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)
    before = _canonical_snapshot(workspace)

    with pytest.raises(CodedValueError) as caught:
        PipelineService(workspace).export_variant(ExportTarget.PODCAST)

    assert caught.value.code == expected_code
    if expected_code == "export_variant_qc_failed":
        assert "loudness" in str(caught.value).lower() or "target" in str(caught.value).lower()
        assert "-16 LUFS" in str(caught.value)
        assert "-17.0 LUFS" in str(caught.value)
    variants = workspace.project.export_dir() / "variants"
    assert not variants.exists() or not list(variants.iterdir())
    assert _canonical_snapshot(workspace) == before


def test_same_stat_premix_change_blocks_bundle_publication(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.engines.play_audit import premix_path
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    premix = premix_path(workspace.project)
    engine = _FakeEngine(premix)
    engine.mutate_source_on_encode = True
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)

    with pytest.raises(CodedValueError) as caught:
        PipelineService(workspace).export_variant(ExportTarget.PODCAST)

    assert caught.value.code == "stale_mix"
    assert not any((workspace.project.export_dir() / "variants").glob("[0-9a-f]*"))


def test_cancel_after_encode_discards_private_stage(minimal_project, sample_wav, monkeypatch):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.progress import CancelledProgress

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)
    calls = 0

    def cancelled() -> bool:
        nonlocal calls
        calls += 1
        return engine.cancelled

    with pytest.raises(CancelledProgress):
        PipelineService(workspace).export_variant(ExportTarget.PODCAST, cancel_check=cancelled)
    variants = workspace.project.export_dir() / "variants"
    assert not variants.exists() or not list(variants.iterdir())


def test_variant_format_rejects_ffmpeg_arguments_before_mastering(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)

    with pytest.raises(CodedValueError, match="extra FFmpeg arguments") as caught:
        PipelineService(workspace).export_variant(
            ExportTarget.PODCAST,
            formats=[{"ext": "mp3", "extra_args": ["-f", "wav"]}],
        )

    assert engine.master_calls == 0
    assert caught.value.code == "export_variant_format_invalid"


def test_unparseable_variant_format_returns_a_coded_refusal(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)

    with pytest.raises(CodedValueError, match="supported audio format") as caught:
        PipelineService(workspace).export_variant(ExportTarget.PODCAST, formats=[{}])

    assert caught.value.code == "export_variant_format_invalid"
    assert engine.master_calls == 0


def test_duplicate_explicit_variant_formats_are_rejected_before_mastering(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)

    with pytest.raises(CodedValueError, match="unique audio extensions") as caught:
        PipelineService(workspace).export_variant(
            ExportTarget.PODCAST, formats=[{"ext": "flac"}, {"ext": "flac"}]
        )

    assert caught.value.code == "export_variant_format_invalid"
    assert engine.master_calls == 0


def test_missing_premix_fails_without_canonical_master_fallback(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.engines.play_audit import premix_path
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    premix_path(workspace.project).unlink()
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)

    with pytest.raises(CodedValueError) as caught:
        PipelineService(workspace).export_variant(ExportTarget.PODCAST)

    assert caught.value.code == "no_mix"
    assert engine.master_calls == 0


def test_corrupt_completed_bundle_is_not_repaired_or_served(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedFileNotFoundError, CodedValueError

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)
    service = PipelineService(workspace)
    result = service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "flac"}])
    served = ExportFilesService(workspace).open(result.file_ids[0])
    served.path.write_bytes(b"corrupt")

    with pytest.raises(CodedValueError) as caught:
        service.export_variant(ExportTarget.PODCAST, formats=[{"ext": "flac"}])
    with pytest.raises(CodedFileNotFoundError):
        ExportFilesService(workspace).open(result.file_ids[0])

    assert caught.value.code == "export_variant_cache_corrupt"
    assert served.path.read_bytes() == b"corrupt"
    assert engine.master_calls == 1


def test_old_bundle_stays_listed_but_not_current_after_source_changes(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.engines.play_audit import premix_path
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(sample_wav)
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)
    result = PipelineService(workspace).export_variant(
        ExportTarget.PODCAST, formats=[{"ext": "flac"}]
    )
    premix = premix_path(workspace.project)
    content = bytearray(premix.read_bytes())
    stamp = premix.stat()
    content[44] ^= 1
    premix.write_bytes(content)
    os.utime(premix, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))

    variants = [
        entry for entry in ExportFilesService(workspace).list() if entry.id in result.file_ids
    ]

    assert len(variants) == len(result.file_ids)
    assert all(not entry.current for entry in variants)
    assert all(ExportFilesService(workspace).open(entry.id).path.is_file() for entry in variants)


@pytest.mark.skipif(
    os.environ.get("PODCAST_RUN_VARIANT_REAL_ENGINE") != "1",
    reason="run explicitly with the admitted FFmpeg pair for local synthetic audio proof",
)
@pytest.mark.parametrize(
    ("fixture_name", "target_name"),
    [
        (fixture_name, target_name)
        for fixture_name in ("gentle_wav", "peaky_wav", "dense_clicks_wav")
        for target_name in ("broadcast", "podcast", "streaming")
    ],
)
def test_real_engine_variant_targets(
    fixture_name, target_name, request, minimal_project, monkeypatch
):
    from podcast_mcp.engines.play_audit import premix_path
    from podcast_mcp.services.document import ExportFilesService
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError

    fixture = request.getfixturevalue(fixture_name)
    workspace = _current_mix(minimal_project, fixture)
    _seed_canonical_outputs(workspace)
    before = _canonical_snapshot(workspace)
    target = ExportTarget(target_name)
    engine = service_module.pipeline_steps.ffmpeg()
    should_reject = fixture_name == "dense_clicks_wav" and target_name in {
        "podcast",
        "streaming",
    }

    if should_reject:
        with pytest.raises(CodedValueError) as caught:
            PipelineService(workspace).export_variant(target, formats=[])
        assert caught.value.code == "export_variant_qc_failed"
        variants = workspace.project.export_dir() / "variants"
        assert not variants.exists() or not list(variants.iterdir())
    else:
        result = PipelineService(workspace).export_variant(target, formats=[])
        assert result.target is target
        assert result.master.within_tolerance
        assert (
            result.master.target.integrated_lufs
            == {
                "broadcast": -23.0,
                "podcast": -16.0,
                "streaming": -14.0,
            }[target_name]
        )
        assert len(result.file_ids) == 1
        served = ExportFilesService(workspace).open(result.file_ids[0])
        assert served.path.is_file()
        assert engine.measure_loudness_full(served.path) is not None
    assert premix_path(workspace.project).is_file()
    assert _canonical_snapshot(workspace) == before
