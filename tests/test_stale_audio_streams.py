from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

import multistream_media as media
from podcast_mcp.cli.main import app
from podcast_mcp.cli.pipeline import _echo_run_report
from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine
from podcast_mcp.engines.stale_audio_streams import stale_stream_files, stale_stream_lines
from podcast_mcp.mcp.tools.pipeline import _run_message
from podcast_mcp.models import EpisodeProject, MediaAsset, ProjectMeta, Track, TrackRole
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline import PipelineRunResult

runner = CliRunner()


def _workspace(tmp_path: Path, media_path: Path, *, stamped: bool = False) -> ProjectWorkspace:
    ws = ProjectWorkspace.create(tmp_path / "ep")
    raw = ws.path.parent / "raw"
    raw.mkdir(exist_ok=True)
    stored = raw / media_path.name
    shutil.copy(media_path, stored)
    with ws.transaction() as project:
        project.meta.analysis_reads_first_audio_stream = stamped
        project.tracks.append(
            Track(
                id="host",
                label="host",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{stored.name}", duration_sec=2.0),
            )
        )
        ws.save()
    return ws


def _boom(path: Path) -> AudioProbe:
    raise AssertionError("probed")


@pytest.mark.parametrize(
    ("name", "expected"),
    [("st.mkv", 1), ("two_b.mkv", 1), ("none.mkv", 1), ("first_default.mkv", 0)],
)
def test_legacy_pick_follows_ffmpeg_auto_select(tmp_path, name, expected):
    path = media.multistream(tmp_path, name)
    assert FFmpegEngine().probe(path).legacy_default_audio_index == expected


def test_legacy_pick_of_single_stream_is_first(sample_wav):
    assert FFmpegEngine().probe(sample_wav).legacy_default_audio_index == 0


def test_legacy_pick_unknown_without_disposition(monkeypatch, sample_wav):
    engine = FFmpegEngine()
    stdout = json.dumps(
        {"format": {}, "streams": [{"codec_type": "audio"}, {"codec_type": "audio"}]}
    )

    class Done:
        pass

    done = Done()
    done.stdout = stdout
    done.stderr = ""
    monkeypatch.setattr("podcast_mcp.engines.ffmpeg.run", lambda *a, **k: done)
    assert engine.probe(sample_wav).legacy_default_audio_index is None


def test_finder_flags_unstamped_project_with_old_pick(tmp_path):
    ws = _workspace(tmp_path, media.multistream(tmp_path, "st.mkv"))
    found = stale_stream_files(ws.project)
    assert [(f.track_ids, f.audio_streams, f.old_pick) for f in found] == [(("host",), 2, 1)]
    assert found[0].path == ws.project.tracks[0].media.path


def test_finder_flags_when_prediction_is_unknown(tmp_path):
    ws = _workspace(tmp_path, media.multistream(tmp_path, "st.mkv"))
    probe = FFmpegEngine().probe
    unknown = probe(tmp_path / "st.mkv")
    unknown.legacy_default_audio_index = None
    found = stale_stream_files(ws.project, probe=lambda path: unknown)
    assert [f.old_pick for f in found] == [None]


def test_finder_ignores_first_default_file(tmp_path):
    ws = _workspace(tmp_path, media.multistream(tmp_path, "first_default.mkv"))
    assert stale_stream_files(ws.project) == []


def test_finder_ignores_single_stream_media(tmp_path, sample_wav):
    ws = _workspace(tmp_path, sample_wav)
    assert stale_stream_files(ws.project) == []


def test_finder_is_silent_and_probe_free_when_stamped(tmp_path):
    ws = _workspace(tmp_path, media.multistream(tmp_path, "st.mkv"), stamped=True)
    assert stale_stream_files(ws.project, probe=_boom) == []


def test_finder_ignores_unstamped_consolidated_project(tmp_path, sample_wav):
    project = EpisodeProject(meta=ProjectMeta(name="c", workspace_dir=str(tmp_path)))
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks.append(
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    )
    assert stale_stream_files(project) == []


def test_lines_name_files_and_steps(tmp_path):
    ws = _workspace(tmp_path, media.multistream(tmp_path, "st.mkv"))
    lines = stale_stream_lines(ws.project, stale_stream_files(ws.project))
    text = "\n".join(lines)
    assert ws.project.tracks[0].media.path in text
    assert "align_tracks" in text
    assert "--retime-words" in text
    assert "mark-streams-current" in text
    assert stale_stream_lines(ws.project, []) == []


def test_marker_defaults_false_on_old_json_and_true_on_create(tmp_path):
    old = ProjectMeta.model_validate(
        {"name": "n", "workspace_dir": ".", "created_at": "2026-01-01T00:00:00+00:00"}
    )
    assert old.analysis_reads_first_audio_stream is False
    assert EpisodeProject.create("n", str(tmp_path)).meta.analysis_reads_first_audio_stream is True


def test_info_shows_notice_until_marked_current(tmp_path):
    ws = _workspace(tmp_path, media.multistream(tmp_path, "st.mkv"))
    project_file = str(ws.path)
    info = runner.invoke(app, ["info", "--project", project_file])
    payload = json.loads(info.stdout)
    stale = payload["stale_audio_streams"]
    assert stale["files"][0]["tracks"] == ["host"]
    assert stale["files"][0]["audio_streams"] == 2
    assert stale["files"][0]["old_pick"] == 1
    assert "mark-streams-current" in stale["rerun"]

    entries = len(ProjectWorkspace.open(project_file).project.history.entries)
    done = runner.invoke(app, ["episode", "mark-streams-current", "--project", project_file])
    assert done.exit_code == 0
    reopened = ProjectWorkspace.open(project_file)
    assert len(reopened.project.history.entries) == entries
    assert reopened.project.meta.analysis_reads_first_audio_stream is True
    after = runner.invoke(app, ["info", "--project", project_file])
    assert "stale_audio_streams" not in json.loads(after.stdout)


def test_cli_run_report_prints_notices_before_completion(capsys):
    result = PipelineRunResult(last_step="export_deliverables", steps=[])
    _echo_run_report(result, ["Stale audio streams: x"])
    out = capsys.readouterr().out.splitlines()
    assert out[-2:] == [
        "Stale audio streams: x",
        "Pipeline complete. Last step: export_deliverables",
    ]


def test_mcp_run_message_appends_notices():
    assert _run_message("a", None) == "Completed through a"
    assert _run_message("a", None, notices=["n1", "n2"]).splitlines() == [
        "Completed through a",
        "n1",
        "n2",
    ]
