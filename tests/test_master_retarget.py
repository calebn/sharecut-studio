"""Changing ``master.*`` re-masters on export (#1007); unchanged settings reuse the master."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.mastering import LoudnormPlan, MasterResult
from podcast_mcp.engines.play_audit import mastered_path, premix_path
from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.pipeline import steps
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EpisodeService
from podcast_mcp.services.pipeline import PipelineService
from podcast_mcp.services.pipeline.config import config_store


@pytest.fixture
def eng() -> FFmpegEngine:
    engine = FFmpegEngine()
    if not engine.check_available()[0]:
        pytest.skip("ffmpeg not available")
    return engine


def _integrated_lufs(eng: FFmpegEngine, path: Path) -> float:
    measured = eng.measure_loudness_full(path)
    assert measured is not None
    return measured["integrated_lufs"]


def _real_project(tmp_path: Path, sample_wav: Path) -> ProjectWorkspace:
    project = EpisodeProject.create("retarget", str(tmp_path / "episode"))
    project.ensure_dirs()
    ws = ProjectWorkspace.open(save_project(project))
    EpisodeService(ws).add_track("voice", str(sample_wav), role="dialogue")
    return ws


def _stage_master(ws: ProjectWorkspace, **master: float) -> None:
    """Stage ``master.*`` the way the Pipeline tab does: into the project's working set."""
    config_store().apply_patches(ws.path, {"master": master})


def _delivered_wav(ws: ProjectWorkspace) -> Path:
    return ws.project.export_dir() / "retarget.wav"


def test_a_changed_loudness_target_re_masters_the_next_export(
    eng: FFmpegEngine, tmp_path: Path, sample_wav: Path
) -> None:
    ws = _real_project(tmp_path, sample_wav)
    service = PipelineService(ws)

    default_export = service.export_audio([{"ext": "wav"}])
    assert _integrated_lufs(eng, _delivered_wav(ws)) == pytest.approx(-16.0, abs=0.5)
    assert default_export.master["target_integrated_lufs"] == -16.0
    assert default_export.master["target_true_peak_db"] == -1.5

    _stage_master(ws, integrated_lufs=-19.0)
    quieter = service.export_audio([{"ext": "wav"}])
    assert _integrated_lufs(eng, _delivered_wav(ws)) == pytest.approx(-19.0, abs=0.5)
    assert quieter.master["target_integrated_lufs"] == -19.0
    assert quieter.master_summary().startswith(
        "Mastered to target -19.0 LUFS / -1.5 dBTP; measured"
    )
    qc = json.loads((ws.project.artifacts_dir() / "master_qc.json").read_text())
    assert qc["target_integrated_lufs"] == -19.0
    assert qc["within_tolerance"] is True

    master_stamp = mastered_path(ws.project).stat().st_mtime_ns
    service.export_audio([{"ext": "wav"}])
    assert mastered_path(ws.project).stat().st_mtime_ns == master_stamp

    _stage_master(ws, integrated_lufs=-16.0)
    service.export_audio([{"ext": "wav"}])
    assert mastered_path(ws.project).stat().st_mtime_ns != master_stamp
    assert _integrated_lufs(eng, _delivered_wav(ws)) == pytest.approx(-16.0, abs=0.5)


def test_a_changed_true_peak_ceiling_re_masters(tmp_path: Path, sample_wav: Path) -> None:
    ws = _real_project(tmp_path, sample_wav)
    service = PipelineService(ws)
    service.export_audio([{"ext": "wav"}])
    stamp = mastered_path(ws.project).stat().st_mtime_ns

    _stage_master(ws, true_peak_db=-3.0)
    service.export_audio([{"ext": "wav"}])

    assert mastered_path(ws.project).stat().st_mtime_ns != stamp
    qc = json.loads((ws.project.artifacts_dir() / "master_qc.json").read_text())
    assert qc["target_true_peak_db"] == -3.0


def _mock_master_engine(measured: dict[str, float]) -> MagicMock:
    eng = MagicMock()

    def fake_master(src, dst, **_kw):
        shutil.copyfile(src, dst)
        return MasterResult(Path(dst), LoudnormPlan(two_pass=True), None, "linear", None)

    eng.master_loudness.side_effect = fake_master
    eng.measure_loudness_full.return_value = measured
    return eng


def test_a_changed_qc_tolerance_re_judges_the_cached_master(minimal_project: Path) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    premix_path(ws.project).parent.mkdir(parents=True, exist_ok=True)
    premix_path(ws.project).write_bytes(b"RIFF")
    eng = _mock_master_engine({"integrated_lufs": -17.0, "true_peak_db": -3.0})
    defaults = load_defaults()
    qc_path = ws.project.artifacts_dir() / "master_qc.json"
    with patch.object(steps, "ffmpeg", return_value=eng):
        steps.master_loudness(ws.project, defaults)
        assert json.loads(qc_path.read_text())["within_tolerance"] is False
        stamp = mastered_path(ws.project).stat().st_mtime_ns

        lenient = {**defaults, "master": {**defaults["master"], "qc_lufs_tolerance_lu": 2.0}}
        steps.ensure_current_master(ws.project, lenient)

    qc = json.loads(qc_path.read_text())
    assert (qc["within_tolerance"], qc["issues"]) == (True, [])
    assert eng.master_loudness.call_count == 1
    assert mastered_path(ws.project).stat().st_mtime_ns == stamp


@pytest.mark.parametrize(
    ("key", "value"),
    [("integrated_lufs", -19.0), ("true_peak_db", -3.0), ("lra", 7.0)],
)
def test_each_audio_setting_of_the_master_re_masters_a_cached_master(
    minimal_project: Path, key: str, value: float
) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    premix_path(ws.project).parent.mkdir(parents=True, exist_ok=True)
    premix_path(ws.project).write_bytes(b"RIFF")
    eng = _mock_master_engine({"integrated_lufs": -16.0, "true_peak_db": -3.0})
    defaults = load_defaults()
    with patch.object(steps, "ffmpeg", return_value=eng):
        steps.master_loudness(ws.project, defaults)
        steps.ensure_current_master(ws.project, defaults)
        assert eng.master_loudness.call_count == 1

        changed = {**defaults, "master": {**defaults["master"], key: value}}
        steps.ensure_current_master(ws.project, changed)

    assert eng.master_loudness.call_count == 2
    assert eng.master_loudness.call_args.kwargs[key] == value
