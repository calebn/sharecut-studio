"""Re-proposing over audio an earlier round already trimmed never double-cuts (#1212).

Round one cuts a filler and lays a room-tone pad, so the filler's word gap now holds a
join and a pad that replays source. Round two then looks for pauses in the same
transcript at a tighter setting.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pause_policy_public_helpers import configure, defaults, room, voice, write_wav
from podcast_mcp.edits.cut_application import apply_auto_edits
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.timebase import SourceSec
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
    REFINE_GATE.mark_done(project, notes="synthetic scene")
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


FILLER_INDEX = 1

SCENES = {
    "two-speakers-same-pitch": (
        {
            "host": [(0.5, 1.0), (2.0, 2.4), (3.6, 4.1), (7.5, 8.0), (11.2, 11.7), (14.5, 15.0)],
            "guest": [(36.0, 36.5)],
        },
        {"host": -70.0, "guest": -70.0},
    ),
    "three-tracks-different-rooms": (
        {
            "host": [(0.5, 1.0), (3.0, 3.4), (5.2, 5.7), (8.9, 9.4), (12.0, 12.5)],
            "guest": [(20.0, 20.5), (23.4, 23.9), (27.0, 27.5)],
            "third": [(38.0, 38.4)],
        },
        {"host": -72.0, "guest": -64.0, "third": -76.0},
    ),
    "one-quiet-track": (
        {
            "host": [(0.5, 1.0), (2.4, 2.8), (4.2, 4.7), (8.1, 8.6), (12.3, 12.8)],
            "guest": [(38.0, 38.5)],
        },
        {"host": -70.0, "guest": -70.0},
    ),
}


def _round_config(*, fillers: list[str], max_pause_sec: float, retained_sec: float) -> dict:
    cfg = defaults()
    cfg["tighten"].update(
        filler_words=fillers,
        filler_room_tone_replace=True,
        min_filler_cluster=1,
        max_pause_sec=max_pause_sec,
        min_retained_solo_pause_sec=retained_sec,
    )
    return cfg


def _live_words(project: EpisodeProject, track_id: str) -> list[TranscriptWord]:
    transcript = project.transcript_for_track(track_id)
    assert transcript is not None
    return [w for w in transcript.words if not w.suppressed]


def _pauses_across_a_join(project: EpisodeProject, pauses: list) -> list[tuple[str, float, float]]:
    """Pending pause trims whose word gap does not play as one piece of source."""
    timeline = SessionTimeline(project)
    crossing = []
    for edit in pauses:
        words = _live_words(project, edit.track_id)
        before = max((w for w in words if w.end <= edit.start + 1e-6), key=lambda w: w.end)
        after = min((w for w in words if w.start >= edit.end - 1e-6), key=lambda w: w.start)
        pieces = timeline.map_source_span(
            edit.track_id, SourceSec(before.end), SourceSec(after.start)
        )
        played = sum(float(end) - float(start) for start, end in pieces)
        if len(pieces) != 1 or abs(played - (after.start - before.end)) > TOLERANCE:
            crossing.append((edit.track_id, before.end, after.start))
    return crossing


@pytest.mark.parametrize("scene", sorted(SCENES))
def test_reproposing_over_a_padded_cut_never_double_cuts_or_splits_the_tracks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scene: str
) -> None:
    speech, db = SCENES[scene]
    project = _scene(tmp_path, speech, db=db)
    filler = project.transcript_for_track("host").words[FILLER_INDEX]
    filler.text = "um"
    ends_before = _timeline_ends(project)

    first = _round_config(fillers=["um"], max_pause_sec=5.0, retained_sec=0.55)
    configure(monkeypatch, first)
    propose_tighten_edits(project, first, intensity="medium")
    assert apply_auto_edits(project, defaults=first) == 1
    padded = project.editorial.edit_log[-1]
    assert padded.reason == "filler:um"
    assert {s["track_id"] for s in padded.params["pad_samples"]} == set(speech)

    second = _round_config(fillers=[], max_pause_sec=0.5, retained_sec=0.3)
    configure(monkeypatch, second)
    proposal = propose_tighten_edits(project, second, intensity="medium")
    pauses = [e for e in proposal.decisions if (e.reason or "").startswith("pause:")]
    assert pauses
    assert _pauses_across_a_join(project, pauses) == []
    assert apply_auto_edits(project, defaults=second) == len(proposal.decisions)

    assert _applied_problems(project) == {"overlaps": [], "one_track": [], "claimed_more": []}
    ends_after = _timeline_ends(project)
    assert len(set(ends_after.values())) == 1
    claimed = sum(
        r.source_end - r.source_start - (r.params.get("replace_gap_sec") or 0.0)
        for r in project.editorial.edit_log
    )
    assert next(iter(ends_before.values())) - next(iter(ends_after.values())) == pytest.approx(
        claimed, abs=TOLERANCE
    )
