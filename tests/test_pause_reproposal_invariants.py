"""Applied pause trims never double-cut a span and never touch only one track (#1212)."""

from __future__ import annotations

from pathlib import Path

import pytest

from pause_policy_public_helpers import configure, defaults, room, voice, write_wav
from podcast_mcp.edits.decisions import apply_auto_edits
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.tracks import dialogue_track_ids

DURATION = 40.0
TOLERANCE = 0.005


def _scene(tmp_path: Path, speech: dict[str, list[tuple[float, float]]], *, db: dict[str, float]):
    project = EpisodeProject.create("reproposal", str(tmp_path))
    for index, (tid, spans) in enumerate(speech.items()):
        audio = room(DURATION, seed=1212 + index, db=db[tid])
        for start, end in spans:
            voice(audio, start, end)
        write_wav(tmp_path / "raw" / f"{tid}.wav", audio)
        project.tracks.append(
            Track(
                id=tid,
                label=tid.title(),
                role=TrackRole.DIALOGUE,
                speaker=tid.title(),
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=DURATION, sample_rate=16000),
            )
        )
        project.clips.append(
            Clip(
                id=f"full-{tid}",
                track_id=tid,
                source_start=0,
                source_end=DURATION,
                timeline_start=0,
            )
        )
        project.transcripts.append(
            Transcript(
                track_id=tid,
                words=[
                    TranscriptWord(text=f"w{i}", start=start, end=end)
                    for i, (start, end) in enumerate(spans)
                ],
            )
        )
    project.timeline.duration_sec = DURATION
    mark_refine_done(project, notes="synthetic scene")
    return project


def _applied_problems(project: EpisodeProject) -> dict[str, list]:
    dialogue = set(dialogue_track_ids(project))
    spans: dict[str, list[tuple[str, float, float]]] = {}
    overlaps, one_track, claimed_more = [], [], []
    for record in project.editorial.edit_log:
        params = record.params
        per_track = params.get("per_track_source") or {}
        if not params.get("mute") and set(per_track) != dialogue:
            one_track.append((record.id, record.reason, sorted(per_track)))
        for tid, (start, end) in per_track.items():
            for other_id, other_start, other_end in spans.get(tid, []):
                if min(end, other_end) - max(start, other_start) > TOLERANCE:
                    overlaps.append((tid, record.id, other_id))
            spans.setdefault(tid, []).append((record.id, start, end))
        loss = params.get("loss_sec")
        claimed = record.source_end - record.source_start - (params.get("replace_gap_sec") or 0.0)
        if loss is not None and abs(claimed - loss) > TOLERANCE:
            claimed_more.append((record.id, claimed, loss))
    return {"overlaps": overlaps, "one_track": one_track, "claimed_more": claimed_more}


def _timeline_ends(project: EpisodeProject) -> dict[str, float]:
    return {
        tid: round(max(c.timeline_end for c in project.clips if c.track_id == tid), 6)
        for tid in dialogue_track_ids(project)
    }


SCENES = {
    "two-speakers-same-pitch": (
        {
            "host": [(0.5, 1.0), (3.6, 4.1), (7.5, 8.0), (11.2, 11.7), (14.5, 15.0)],
            "guest": [(36.0, 36.5)],
        },
        {"host": -70.0, "guest": -70.0},
    ),
    "three-tracks-different-rooms": (
        {
            "host": [(0.5, 1.0), (3.2, 3.7), (6.9, 7.4), (10.0, 10.5)],
            "guest": [(20.0, 20.5), (23.4, 23.9), (27.0, 27.5)],
            "third": [(38.0, 38.4)],
        },
        {"host": -72.0, "guest": -64.0, "third": -76.0},
    ),
    "one-quiet-track": (
        {"host": [(0.5, 1.0), (4.4, 4.9), (8.1, 8.6), (12.3, 12.8)], "guest": [(38.0, 38.5)]},
        {"host": -70.0, "guest": -70.0},
    ),
}


@pytest.mark.parametrize("scene", sorted(SCENES))
@pytest.mark.parametrize(
    "first,second", [("light", "aggressive"), ("aggressive", "aggressive"), ("medium", "light")]
)
def test_reproposing_after_applying_never_double_cuts_or_splits_the_tracks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scene: str, first: str, second: str
) -> None:
    speech, db = SCENES[scene]
    cfg = defaults()
    configure(monkeypatch, cfg)
    project = _scene(tmp_path, speech, db=db)
    ends_before = _timeline_ends(project)

    applied = 0
    for intensity in (first, second):
        propose_tighten_edits(project, cfg, intensity=intensity)
        applied += apply_auto_edits(project)

    assert applied > 0
    assert _applied_problems(project) == {"overlaps": [], "one_track": [], "claimed_more": []}
    ends_after = _timeline_ends(project)
    assert len(set(ends_after.values())) == 1
    assert next(iter(ends_after.values())) < next(iter(ends_before.values()))
