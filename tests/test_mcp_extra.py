from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import history as mcp_history
from podcast_mcp.mcp.tools import pipeline as mcp_pipeline
from podcast_mcp.mcp.tools import speaker as mcp_speaker
from podcast_mcp.mcp.tools import transcript as mcp_transcript
from podcast_mcp.models import CombinedTranscript, CombinedUtterance, load_project, save_project


def test_mcp_history_tools(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    recorded = json.loads(mcp_history.history_record(path, "checkpoint"))
    assert "checkpoint" in recorded["id_label"]
    listing = json.loads(mcp_history.history_list(path))
    assert "entries" in listing
    assert "groups" in listing
    status = json.loads(mcp_history.history_status_tool(path))
    assert "cursor" in status
    diff = json.loads(mcp_history.history_diff_tool(path, from_index=0, to_index=0))
    assert "diff" in diff


def test_mcp_speaker_doctor():
    out = json.loads(mcp_speaker.speaker_doctor_tool())
    assert "available_backends" in out


def test_mcp_speaker_profiles(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    profiles = json.loads(mcp_speaker.speaker_profiles_tool(path))
    assert isinstance(profiles, list)


def test_mcp_speaker_compare_label_and_count(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    with patch("podcast_mcp.mcp.tools.speaker.SpeakerService") as Svc:
        inst = Svc.return_value
        inst.compare_window.return_value = {"tracks": []}
        inst.label.return_value = {"labeled": 0}
        inst.set_expected_speaker_count.return_value = {"expected_speaker_count": 2}
        assert json.loads(mcp_speaker.speaker_compare_window_tool(path, 0.0, 1.0))
        assert json.loads(mcp_speaker.speaker_label_tool(path, "host", 0.0, 1.0, dry_run=True))
        assert json.loads(mcp_speaker.speaker_set_count_tool(path, 2))


def test_mcp_transcript_get_combined(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    proj = load_project(Path(path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="Hi",
            )
        ]
    )
    save_project(proj, Path(path))
    out = json.loads(mcp_transcript.get_transcript(path, combined=True))
    assert out["utterances"][0]["text"] == "Hi"


def test_mcp_transcript_export_markdown(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    proj = load_project(Path(path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="Exported line",
            )
        ]
    )
    save_project(proj, Path(path))
    out_path = mcp_transcript.export_transcript(path)
    assert Path(out_path).is_file()


def test_mcp_pipeline_run_only_step(tmp_path, sample_wav):
    ws = tmp_path / "ws"
    path = mcp_server.episode_create(str(ws))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")
    with patch("podcast_mcp.services.pipeline.PipelineRunner") as mock_runner:
        instance = mock_runner.return_value
        instance.run.return_value = MagicMock()
        proj = load_project(Path(path))
        proj.last_completed_step = "ingest_tracks"
        save_project(proj, Path(path))
        result = mcp_pipeline.pipeline_run(path, only_step="ingest_tracks")
    assert "ingest_tracks" in result


def test_mcp_pipeline_config_tools(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")
    got = json.loads(mcp_pipeline.pipeline_get_config_tool(path))
    assert "config" in got and "enabled_steps" in got and "params" in got
    assert got["unattended"] is True

    mcp_pipeline.pipeline_set_config_tool(path, enabled_steps_json="[]")
    updated = json.loads(
        mcp_pipeline.pipeline_set_config_tool(
            path,
            config_json='{"balance": {"dialogue_lufs": -18.0}}',
            enabled_steps_json='["export_deliverables"]',
            unattended=False,
        )
    )
    assert updated["unattended"] is False
    assert updated["config"]["balance"]["dialogue_lufs"] == -18.0
    assert "export_deliverables" in updated["enabled_steps"]
    assert "master_loudness" in updated["enabled_steps"]


def test_mcp_pipeline_analyze_tool(tmp_path, sample_wav, monkeypatch):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")

    def fake_suggest(project, *, base_config=None):
        return {
            "proposed_config": {"balance": {"dialogue_lufs": -19.0}},
            "patches": {"balance": {"dialogue_lufs": -19.0}},
            "reasons": [{"code": "test", "message": "ok", "track_id": "host"}],
            "report_summary": {"track_count": 1, "reason_count": 1},
        }

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline_config.suggest_pipeline_tuning",
        fake_suggest,
    )
    preview = json.loads(mcp_pipeline.pipeline_analyze_tool(path, apply=False))
    assert preview["applied"] is False
    assert preview["reasons"]

    applied = json.loads(mcp_pipeline.pipeline_analyze_tool(path, apply=True))
    assert applied["applied"] is True
    assert "config" in applied
    assert applied["config"]["config"]["balance"]["dialogue_lufs"] == -19.0


def test_mcp_pipeline_run_working_set_and_overrides(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")
    from podcast_mcp.services.pipeline_config import config_store

    store = config_store()
    store.put(Path(path), reset=True, unattended=True)
    store.put(Path(path), enabled_steps=["ingest_tracks"])

    with patch("podcast_mcp.services.pipeline.PipelineRunner") as mock_runner:
        instance = mock_runner.return_value
        instance.run.return_value = MagicMock()
        proj = load_project(Path(path))
        proj.last_completed_step = "ingest_tracks"
        save_project(proj, Path(path))

        mcp_pipeline.pipeline_run(path, only_step="ingest_tracks", unattended=None)
        run_kwargs = instance.run.call_args.kwargs
        assert run_kwargs.get("unattended") is True

        mcp_pipeline.pipeline_run(
            path,
            only_step="ingest_tracks",
            config_json='{"balance": {"dialogue_lufs": -17.0}}',
            skip_steps_json='["merge_transcript"]',
        )
        defaults = mock_runner.call_args.kwargs.get("defaults")
        assert defaults is not None
        assert defaults["balance"]["dialogue_lufs"] == -17.0
        run_kwargs = instance.run.call_args.kwargs
        assert "merge_transcript" in (run_kwargs.get("skip_steps") or [])

        mcp_pipeline.pipeline_run(
            path,
            only_step="ingest_tracks",
            use_working_set=False,
            unattended=False,
        )
        run_kwargs = instance.run.call_args.kwargs
        assert run_kwargs.get("unattended") is False

    try:
        mcp_pipeline.pipeline_run(path, config_json="[]")
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "JSON object" in str(exc)

    try:
        mcp_pipeline.pipeline_run(path, skip_steps_json="{}")
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "JSON array" in str(exc)

    try:
        mcp_pipeline.pipeline_set_config_tool(path, config_json="[]")
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "JSON object" in str(exc)

    try:
        mcp_pipeline.pipeline_set_config_tool(path, enabled_steps_json="{}")
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "JSON array" in str(exc)


def test_mcp_pipeline_export_audio(tmp_path, sample_wav):
    ws = tmp_path / "ws"
    path = mcp_server.episode_create(str(ws))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")
    with (
        patch("podcast_mcp.services.pipeline.pipeline_steps.master_loudness"),
        patch(
            "podcast_mcp.export.audio.export_episode_audio",
            return_value=[ws / "export" / "demo.mp3"],
        ),
        patch("podcast_mcp.services.pipeline.artifact") as mock_artifact,
    ):
        mock_artifact.return_value = ws / "artifacts" / "mastered.wav"
        (ws / "artifacts").mkdir(parents=True, exist_ok=True)
        (ws / "artifacts" / "mastered.wav").write_bytes(b"wav")
        out = json.loads(mcp_pipeline.export_audio_tool(path, formats_json='[{"ext":"mp3"}]'))
    assert out


def test_mcp_bounce_audio_tool(tmp_path, sample_wav, monkeypatch):
    ws = tmp_path / "ws"
    path = mcp_server.episode_create(str(ws))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")
    monkeypatch.setattr(
        "podcast_mcp.services.bounce.BounceService.bounce",
        lambda self, req=None, **_k: [self.ws.project.export_dir() / "bounces" / "b.wav"],
    )
    out = json.loads(
        mcp_pipeline.bounce_audio_tool(path, formats_json='["wav"]', start_s=0.0, end_s=1.0)
    )
    assert out[0].endswith("b.wav")
