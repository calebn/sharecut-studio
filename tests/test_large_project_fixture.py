from __future__ import annotations

import importlib.util
import json
import wave
from itertools import pairwise
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_large_project_fixture.py"


def _load_fixture_builder() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_large_project_fixture", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_large_project_fixture_has_distributed_unique_data(tmp_path):
    project_path = _load_fixture_builder().build_project(
        tmp_path / "large-project",
        duration=7_200,
        clip_count=1_200,
        utterance_count=10_000,
    )
    project = json.loads(project_path.read_text(encoding="utf-8"))

    clips = project["timeline"]["clips"]
    words = [word for track in project["transcripts"]["per_track"] for word in track["words"]]
    assert len(clips) == 1_200
    assert len(words) == 10_000
    assert len(project["transcripts"]["combined"]["utterances"]) == 10_000
    utterances = project["transcripts"]["combined"]["utterances"]
    assert {row["speaker"] for row in utterances} == {"reference", "guest"}
    assert all(
        utterances[index]["speaker"] != utterances[index + 1]["speaker"]
        for index in range(len(utterances) - 1)
    )
    assert len({clip["id"] for clip in clips}) == len(clips)
    assert len({word["text"] for word in words}) == len(words)
    assert {clip["track_id"] for clip in clips} == {"reference", "guest"}
    assert {track["track_id"] for track in project["transcripts"]["per_track"]} == {
        "reference",
        "guest",
    }
    assert all(track["media"]["duration_sec"] == 7_200 for track in project["timeline"]["tracks"])
    assert all(0 <= clip["source_start"] < clip["source_end"] <= 7_200 for clip in clips)
    for track_id in {clip["track_id"] for clip in clips}:
        track_clips = [clip for clip in clips if clip["track_id"] == track_id]
        assert track_clips[0]["source_start"] == 0
        assert track_clips[-1]["source_end"] == 7_200
        assert all(
            left["source_end"] == right["source_start"] for left, right in pairwise(track_clips)
        )
    assert max(word["end"] for word in words) <= 7_200
    assert all(word["start"] < word["end"] for word in words)
    for track_id in ("reference", "guest"):
        for folder in ("raw", "sources"):
            with wave.open(str(project_path.parent / folder / f"{track_id}.wav")) as audio:
                assert audio.getnframes() / audio.getframerate() == 7_200


def test_large_project_fixture_rejects_unbalanced_track_counts(tmp_path):
    with pytest.raises(ValueError, match="divisible"):
        _load_fixture_builder().build_project(tmp_path / "invalid", clip_count=3)
    assert not (tmp_path / "invalid").exists()
