from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, Transcript, TranscriptWord
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService


def stereo_project(tmp_path: Path) -> ProjectWorkspace:
    project = EpisodeProject.create("review", str(tmp_path))
    project.ensure_dirs()
    rng = np.random.default_rng(945)
    peer = rng.normal(0, 0.08, (144_000, 2))
    owner = 0.12 * peer + 0.025 * np.roll(peer, 768, axis=0)
    owner[:19_200] += rng.normal(0, 0.04, (19_200, 2))
    owner[96_000:115_200] += rng.normal(0, 0.002, (19_200, 2))
    owner[81_600:81_648] += 0.2
    for tid, samples in (("host", owner), ("guest", peer)):
        path = tmp_path / "raw" / f"{tid}.wav"
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(2)
            audio.setsampwidth(2)
            audio.setframerate(48_000)
            audio.writeframes(np.rint(samples * 32768).astype("<i2").tobytes())
        project.tracks.append(
            Track(id=tid, label=tid, media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=3))
        )
        project.clips.append(
            Clip(id=tid, track_id=tid, source_start=0, source_end=3, timeline_start=0)
        )
    project.timeline.duration_sec = 3
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="owner", start=0, end=0.4),
                TranscriptWord(
                    text="foreign",
                    start=0.5,
                    end=0.9,
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
                TranscriptWord(text="retained", start=0.9, end=1.1),
                TranscriptWord(
                    text="possible mixture",
                    start=2,
                    end=2.4,
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
            ],
        ),
        Transcript(track_id="guest", words=[TranscriptWord(text="foreign", start=0.5, end=2.4)]),
    ]
    ws = ProjectWorkspace(tmp_path / "episode.project.json", project)
    ws.save()
    return ws


def test_stereo_refusal_offers_exact_review_without_stem(tmp_path: Path) -> None:
    ws = stereo_project(tmp_path)
    result = EditService(ws).apply_bleed_mute(
        track_id="host", apply=False, align_retained_bleed=False
    )
    assert result["applied_count"] == 0
    assert result["review_candidate_count"] == 2
    row = result["review_candidates"][0]
    assert row["requires_review"] is True
    assert row["peer_track_id"] == "guest"
    assert row["timeline_start"] == 0.5
    assert row["timeline_end"] == 0.9
    target = ExactRangeTarget.model_validate(row["target"])
    assert [(i.start, i.end) for i in target.intervals] == [(0.5, 0.9)]
    assert target.track_ids == ["host"]
    assert "missing_stem" in row["automatic_refusal_reasons"]
    assert result["review_truncated"] is False
    assert not ws.project.edit_decisions
    assert not ws.project.clips[0].mute_regions
