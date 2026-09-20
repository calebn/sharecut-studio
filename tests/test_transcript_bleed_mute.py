from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.edits.transcript_bleed_mute import _track_duration, apply_transcript_bleed_mute
from podcast_mcp.engines.play_audit import write_stem_hash
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _project_with_stem(tmp_path: Path, sample_wav: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(exist_ok=True)
    raw.write_bytes(sample_wav.read_bytes())
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    )
    project.timeline.clips.append(
        Clip(
            id="c-host",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    )
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(
                    text="bleed",
                    start=0.6,
                    end=1.0,
                    confidence=0.9,
                    suppressed=True,
                ),
            ],
        )
    ]
    write_stem_hash(project, "host")
    return project


def test_track_duration_from_media_when_no_words(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    project.transcripts = []
    assert _track_duration(project, "host") == 2.0


def test_track_duration_zero_without_words_or_media(tmp_path: Path) -> None:
    project = EpisodeProject.create("ep", str(tmp_path))
    assert _track_duration(project, "missing") == 0.0


def test_apply_transcript_bleed_mute_skips_non_dialogue(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    music_stem = project.artifacts_dir() / "tracks" / "music.wav"
    music_stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks.append(
        Track(
            id="music",
            label="Music",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/music.wav", duration_sec=2.0),
        )
    )
    result = apply_transcript_bleed_mute(project, dry_run=True)
    assert result["candidate_count"] == 1
    assert result["candidates"][0]["track_id"] == "host"


def test_apply_transcript_bleed_mute_cleans_temp_on_failure(
    tmp_path: Path, sample_wav: Path
) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    with (
        patch(
            "podcast_mcp.edits.transcript_bleed_mute.gate_stem_window",
            side_effect=RuntimeError("gate failed"),
        ),
        pytest.raises(RuntimeError, match="gate failed"),
    ):
        apply_transcript_bleed_mute(project, dry_run=False)


def test_apply_transcript_bleed_mute_scoped_track(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    result = apply_transcript_bleed_mute(project, track_id="host", dry_run=True)
    assert result["candidate_count"] == 1
    assert result["candidates"][0]["track_id"] == "host"


def test_apply_transcript_bleed_mute_dry_run(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    result = apply_transcript_bleed_mute(project, dry_run=True)
    assert result["dry_run"] is True
    assert result["candidate_count"] == 1
    assert result["candidates"][0]["interval_count"] == 1


def test_apply_transcript_bleed_mute_invalid_window(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    result = apply_transcript_bleed_mute(project, dry_run=True, start_sec=5.0, end_sec=1.0)
    assert result["candidate_count"] == 0


def test_apply_transcript_bleed_mute_skips_missing_stem(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    (project.artifacts_dir() / "tracks" / "host.wav").unlink()
    result = apply_transcript_bleed_mute(project, dry_run=True)
    assert result["candidate_count"] == 0
    assert any(s["reason"] == "missing_stem" for s in result["skipped"])


def test_apply_transcript_bleed_mute_skips_stale_stem(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    # Source-length stem with matching hash still fails duration check.
    long = tmp_path / "long.wav"
    long.write_bytes(sample_wav.read_bytes())
    # Stretch expectation: clip ends at 1.0s timeline while stem stays ~2s.
    project.timeline.clips[0].source_end = 1.0
    write_stem_hash(project, "host")
    result = apply_transcript_bleed_mute(project, dry_run=True)
    assert result["candidate_count"] == 0
    assert any(s["reason"] == "stem_not_fresh" for s in result["skipped"])


def test_apply_transcript_bleed_mute_writes_stem(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)

    def _copy_gate(
        src: Path,
        intervals,
        dest: Path,
        *,
        duration_sec=None,
        win_start=0.0,
        win_end=None,
    ) -> None:
        Path(dest).write_bytes(Path(src).read_bytes())

    with (
        patch(
            "podcast_mcp.edits.transcript_bleed_mute.gate_stem_window",
            side_effect=_copy_gate,
        ) as gate,
        patch("podcast_mcp.edits.transcript_bleed_mute.write_stem_hash") as wh,
    ):
        result = apply_transcript_bleed_mute(project, dry_run=False)
    gate.assert_called_once()
    kwargs = gate.call_args.kwargs
    assert kwargs.get("duration_sec") == 2.0
    assert kwargs.get("win_start") == 0.0
    assert kwargs.get("win_end") == 2.0
    wh.assert_called_once_with(project, "host")
    assert result["applied_count"] == 1
    assert project.track_by_id("host").transcript_gate is True


def test_apply_transcript_bleed_mute_skips_grown_stem(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)

    def _copy_gate(src, intervals, dest, **_kwargs) -> None:
        Path(dest).write_bytes(Path(src).read_bytes())

    with (
        patch(
            "podcast_mcp.edits.transcript_bleed_mute.gate_stem_window",
            side_effect=_copy_gate,
        ),
        patch(
            "podcast_mcp.edits.transcript_bleed_mute.probe_stem_duration_sec",
            side_effect=[2.0, 9.0],
        ),
        patch("podcast_mcp.edits.transcript_bleed_mute.stem_is_fresh", return_value=True),
    ):
        result = apply_transcript_bleed_mute(project, dry_run=False)
    assert result["applied_count"] == 0
    assert any(s["reason"] == "duration_mismatch_after_gate" for s in result["skipped"])


def test_apply_transcript_bleed_mute_window_scoped_intervals(
    tmp_path: Path, sample_wav: Path
) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    result = apply_transcript_bleed_mute(project, dry_run=True, start_sec=0.0, end_sec=0.4)
    assert result["candidates"][0]["interval_count"] == 1
    assert result["candidates"][0]["window_end"] == 0.4
    empty = apply_transcript_bleed_mute(project, dry_run=True, start_sec=1.2, end_sec=1.8)
    assert empty["candidates"][0]["interval_count"] == 0


def test_bleed_mute_history_records_gate_flag(tmp_path: Path, sample_wav: Path) -> None:
    from podcast_mcp.services import EditService, ProjectWorkspace
    from podcast_mcp.services.history import HistoryService

    project = _project_with_stem(tmp_path, sample_wav)
    path = tmp_path / "episode.project.json"
    from podcast_mcp.project_store import ProjectStore

    ProjectStore(path).commit(project)
    ws = ProjectWorkspace.open(path)

    def _copy_gate(src, intervals, dest, **kwargs) -> Path:
        Path(dest).write_bytes(Path(src).read_bytes())
        return Path(dest)

    with patch(
        "podcast_mcp.edits.transcript_bleed_mute.gate_stem_window",
        side_effect=_copy_gate,
    ):
        EditService(ws).apply_bleed_mute(track_id="host", apply=True)

    hist = HistoryService(ws)
    entries = hist.list_entries()["entries"]
    labels = [e["label"] for e in entries]
    assert "before apply bleed mute" in labels
    assert "after apply bleed mute" in labels
    assert ws.project.track_by_id("host").transcript_gate is True
    before_idx = labels.index("before apply bleed mute")
    hist.goto(before_idx)
    assert ws.project.track_by_id("host").transcript_gate is False


def test_bleed_mute_uses_speaker_gap_extension(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={"host": object()},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.extend_intervals_with_speaker_gaps",
            return_value=[(0.0, 2.0)],
        ) as extend,
    ):
        result = apply_transcript_bleed_mute(project, dry_run=True)
    extend.assert_called_once()
    assert result["candidates"][0]["interval_count"] == 1


def test_bleed_mute_swallows_speaker_extension_errors(tmp_path: Path, sample_wav: Path) -> None:
    project = _project_with_stem(tmp_path, sample_wav)
    with patch(
        "podcast_mcp.engines.speaker_id.load_all_profiles",
        side_effect=RuntimeError("profiles"),
    ):
        result = apply_transcript_bleed_mute(project, dry_run=True)
    assert result["candidate_count"] == 1
