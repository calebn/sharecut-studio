from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.export.episode import export_episode_deliverables
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    MediaAsset,
    Track,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline import PipelineService
from podcast_mcp.services.pipeline.config import config_store
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import render_lock_held


@pytest.fixture
def export_workspace(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[ProjectWorkspace, Path]:
    project = load_project(minimal_project)
    project.name = "edited-episode"
    project.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=6))
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Hello.", start=0, end=1),
                TranscriptWord(text="Removed.", start=2, end=2.5),
                TranscriptWord(text="Later.", start=4, end=5),
            ],
        )
    ]
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=2, end=2.5, text="Removed.")
        ]
    )
    project.clips = [
        Clip(id="first", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="last", track_id="host", source_start=3, source_end=6, timeline_start=1),
    ]
    project.ensure_dirs()
    (project.workspace_path() / "raw/host.wav").write_bytes(b"source audio")
    master = project.artifacts_dir() / "mastered.wav"
    master.write_bytes(b"mastered audio")
    project.export_dir().mkdir(exist_ok=True)
    for extension in ("wav", "mp3", "srt", "md"):
        (project.export_dir() / f"edited-episode.{extension}").write_text("Old Removed. at 4s")
    save_project(project, minimal_project)
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.service.pipeline_steps.ensure_current_master",
        lambda *_args: master,
    )
    return ProjectWorkspace.open(minimal_project), master


def test_episode_export_refreshes_edited_transcripts_and_reports_their_paths(
    export_workspace: tuple[ProjectWorkspace, Path],
) -> None:
    workspace, _master = export_workspace
    project = workspace.project

    result = PipelineService(workspace).export_audio(formats=[])

    assert {path.name for path in result.paths} == {
        "edited-episode.wav",
        "edited-episode.srt",
        "edited-episode.md",
    }
    assert (project.export_dir() / "edited-episode.wav").read_bytes() == b"mastered audio"
    subtitles = (project.export_dir() / "edited-episode.srt").read_text()
    markdown = (project.export_dir() / "edited-episode.md").read_text()
    assert "Removed" not in subtitles
    assert "Removed" not in markdown
    assert "00:00:02,000 --> 00:00:03,000\nLater." in subtitles
    assert "[2.0s]: Later." in markdown


@pytest.mark.parametrize(
    "fault",
    [
        "captions",
        "md_serialization",
        "srt_serialization",
        "md_write",
        "srt_write",
        "encode",
        "cancel_encode",
        "cancel_publish",
    ],
)
@pytest.mark.parametrize("previous_export", [False, True])
def test_failed_episode_export_preserves_all_previous_files(
    export_workspace: tuple[ProjectWorkspace, Path],
    monkeypatch: pytest.MonkeyPatch,
    fault: str,
    previous_export: bool,
) -> None:
    workspace, master = export_workspace
    project = workspace.project
    if not previous_export:
        for path in project.export_dir().iterdir():
            path.unlink()
    before = {path.name: path.read_bytes() for path in project.export_dir().iterdir()}
    defaults = load_defaults()
    engine = MagicMock()

    def encode(_source, output, **kwargs):
        output.write_bytes(b"new encoded audio")
        if fault == "encode":
            raise OSError("Encode failed")
        if fault == "cancel_encode" and kwargs["cancel_check"]():
            raise CancelledProgress("Encoding cancelled")

    engine.export_audio.side_effect = encode
    if fault == "captions":
        defaults["export"]["captions"] = {"min_duration_sec": 9, "max_duration_sec": 7}
    if fault.endswith("_serialization"):

        def fail_serialization(*_args, **_kwargs):
            raise OSError("Transcript serialization failed")

        serializer = (
            "combined_transcript_markdown" if fault.startswith("md_") else "utterances_to_srt"
        )
        monkeypatch.setattr(f"podcast_mcp.export.episode.{serializer}", fail_serialization)
    if fault.endswith("_write"):
        original_write = Path.write_text

        def fail_text_write(path, *args, **kwargs):
            if path.name.endswith(f".partial.{fault.split('_')[0]}"):
                raise OSError("Transcript write failed")
            return original_write(path, *args, **kwargs)

        monkeypatch.setattr(Path, "write_text", fail_text_write)

    def cancelled() -> bool:
        suffix = ".partial.mp3" if fault == "cancel_encode" else ".partial.srt"
        return fault.startswith("cancel_") and any(project.export_dir().glob(f"*{suffix}"))

    error = (
        CancelledProgress
        if fault.startswith("cancel_")
        else ValueError
        if fault == "captions"
        else OSError
    )
    with pytest.raises(error):
        export_episode_deliverables(project, engine, master, defaults, cancel_check=cancelled)

    assert {path.name: path.read_bytes() for path in project.export_dir().iterdir()} == before


def test_episode_export_uses_configured_caption_limits(
    export_workspace: tuple[ProjectWorkspace, Path],
) -> None:
    workspace, master = export_workspace
    defaults = load_defaults()
    defaults["export"] = {
        "formats": [],
        "captions": {"min_duration_sec": 0.25, "merge_max_gap_sec": 0.5},
    }
    workspace.project.transcripts[0].words[-1].end = 4.1

    export_episode_deliverables(workspace.project, MagicMock(), master, defaults)

    subtitles = (workspace.project.export_dir() / "edited-episode.srt").read_text()
    assert "00:00:02,000 --> 00:00:02,250" in subtitles


def test_pipeline_and_service_export_the_same_configured_transcripts(
    export_workspace: tuple[ProjectWorkspace, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.pipeline import steps

    workspace, _master = export_workspace
    store = config_store()
    store.put(
        workspace.path,
        config={"export": {"formats": [], "captions": {"max_chars_per_line": 5}}},
    )
    try:
        paths = PipelineService(workspace).export_audio(formats=[]).paths
        expected = {path.name: path.read_bytes() for path in paths}
        for path in paths:
            path.write_bytes(b"older export")
        monkeypatch.setattr(steps, "write_export_qc", lambda *_args, **_kwargs: {"ok": True})

        summary = steps.export_deliverables(workspace.project, workspace.effective_config())

        assert "1 audio files, SRT+MD" in summary
        assert {path.name: path.read_bytes() for path in paths} == expected
    finally:
        store.put(workspace.path, reset=True)


@pytest.mark.parametrize("format", ["markdown", "srt", "vtt"])
def test_explicit_transcript_export_takes_render_lock_before_project_transaction(
    export_workspace: tuple[ProjectWorkspace, Path], monkeypatch: pytest.MonkeyPatch, format: str
) -> None:
    from podcast_mcp.services.document import TranscriptService

    workspace, _master = export_workspace
    transaction = workspace.transaction

    @contextmanager
    def locked_transaction():
        assert render_lock_held(workspace.project)
        with transaction() as project:
            yield project

    monkeypatch.setattr(workspace, "transaction", locked_transaction)
    service = TranscriptService(workspace)

    path = service.export_markdown() if format == "markdown" else service.export_subtitles(format)

    assert path.is_file()
    assert "Later." in path.read_text()
