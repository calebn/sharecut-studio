from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.models import Clip, EpisodeProject, load_project, save_project
from podcast_mcp.models.episode import ClipBleedRestore, ClipOffSpeakerMuteRegion, SourceSpan
from podcast_mcp.models.project_format import apply_editable_snapshot, snapshot_editable_state
from podcast_mcp.project.history import HistoryManager
from podcast_mcp.services.app import ProjectWorkspace


@pytest.mark.parametrize(
    "automatic_fields",
    [
        {},
        {"off_speaker_mute_regions": []},
        {"bleed_restore": None},
        {"off_speaker_mute_regions": [], "bleed_restore": None},
        {
            "off_speaker_mute_regions": [
                {"start_s": 1.0, "end_s": 2.0, "fade_out_ms": 5, "fade_in_ms": 5}
            ],
            "bleed_restore": {
                "source_sha256": "a" * 64,
                "regions": [{"start_s": 1.0, "end_s": 2.0}],
            },
        },
    ],
)
def test_unrelated_save_and_history_keep_clip_field_presence(tmp_path: Path, automatic_fields):
    clip = Clip(id="clip", track_id="host", source_start=0, source_end=4, timeline_start=0)
    original = (
        clip.model_dump(mode="json", exclude={"off_speaker_mute_regions", "bleed_restore"})
        | automatic_fields
    )
    project = EpisodeProject.create("before", str(tmp_path))
    project.clips = [Clip.model_validate(original)]

    snapshot = snapshot_editable_state(project)
    assert snapshot["timeline"]["clips"] == [original]
    project.meta.name = "unrelated change"
    path = save_project(project)
    assert json.loads(path.read_text())["timeline"]["clips"] == [original]

    loaded = load_project(path)
    apply_editable_snapshot(loaded, snapshot)
    save_project(loaded)
    assert json.loads(path.read_text())["timeline"]["clips"] == [original]


def test_in_place_automatic_mask_and_restore_survive_save_and_history(tmp_path: Path):
    project = EpisodeProject.create("automatic choices", str(tmp_path))
    clip = Clip(id="clip", track_id="host", source_start=0, source_end=4, timeline_start=0)
    project.clips = [clip]
    clip.off_speaker_mute_regions.append(
        ClipOffSpeakerMuteRegion(start_s=1, end_s=2, fade_out_ms=5, fade_in_ms=5)
    )
    clip.bleed_restore = ClipBleedRestore(
        source_sha256="a" * 64, regions=[SourceSpan(start_s=1, end_s=2)]
    )
    path = save_project(project)
    saved = json.loads(path.read_text())["timeline"]["clips"][0]
    assert saved["off_speaker_mute_regions"] == [
        {"start_s": 1.0, "end_s": 2.0, "fade_out_ms": 5, "fade_in_ms": 5}
    ]
    assert saved["bleed_restore"]["source_sha256"] == "a" * 64
    snapshot = snapshot_editable_state(project)
    loaded = load_project(path)
    apply_editable_snapshot(loaded, snapshot)
    assert loaded.clips[0].off_speaker_mute_regions == clip.off_speaker_mute_regions
    assert loaded.clips[0].bleed_restore == clip.bleed_restore


def test_workspace_undo_and_redo_preserve_absence_and_automatic_choices(tmp_path: Path):
    project = EpisodeProject.create("history presence", str(tmp_path))
    project.clips = [
        Clip(id="clip", track_id="host", source_start=0, source_end=4, timeline_start=0)
    ]
    path = save_project(project)
    original = json.loads(path.read_text())["timeline"]["clips"]
    assert "off_speaker_mute_regions" not in original[0]
    assert "bleed_restore" not in original[0]
    workspace = ProjectWorkspace.open(path)

    def change_choice(current: EpisodeProject) -> None:
        current.clips[0].off_speaker_mute_regions.append(
            ClipOffSpeakerMuteRegion(start_s=1, end_s=2, fade_out_ms=5, fade_in_ms=5)
        )
        current.clips[0].bleed_restore = ClipBleedRestore(
            source_sha256="a" * 64, regions=[SourceSpan(start_s=1, end_s=2)]
        )

    workspace.mutate("before automatic choice", "after automatic choice", change_choice)
    changed = json.loads(path.read_text())["timeline"]["clips"]
    initial = workspace.project.history.entries[0]
    assert (
        json.loads((tmp_path / initial.snapshot_file).read_text())["timeline"]["clips"] == original
    )

    history = HistoryManager(path)
    history.undo(workspace.project, expected_head_id=workspace.project.history.head_id())
    assert json.loads(path.read_text())["timeline"]["clips"] == original
    history.redo(workspace.project, expected_head_id=workspace.project.history.head_id())
    assert json.loads(path.read_text())["timeline"]["clips"] == changed
