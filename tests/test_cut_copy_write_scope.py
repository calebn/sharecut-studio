"""A source cut writes a private candidate and nothing else: the input project stays untouched.

``_cut_copy`` shares every section the write path leaves alone, so a writer that reaches one
would change the project the caller still holds (the published one, a held cut's base, the
re-pass base). These tests hash the input around each shape of cut and pin which sections
the candidate shares and which it owns.
"""

from __future__ import annotations

import hashlib
import math
import random
import wave
from array import array
from pathlib import Path

import pytest

from podcast_mcp.edits import cut_application
from podcast_mcp.edits.cut_application import _apply_source_remove, approve_edits
from podcast_mcp.edits.cut_placement import CutScopeHold
from podcast_mcp.models import (
    AppliedEditRecord,
    ArchivedTranscriptWord,
    ChapterMarker,
    Clip,
    ClipMuteRegion,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    TimelineComment,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.models.episode import CutIntent, SpeakerIngestAlignment
from podcast_mcp.services.app import ProjectWorkspace

RATE = 16_000
SPAN = 5
DURATION = 60


def _tone(path: Path, hz: int) -> None:
    """Speech-like bursts: 3.5 s of tone then 1.5 s of faint room noise, on both tracks."""
    path.parent.mkdir(parents=True, exist_ok=True)
    noise = random.Random(hz)
    samples = array(
        "h",
        (
            int(2000 * math.sin(2 * math.pi * hz * i / RATE))
            if (i / RATE) % SPAN < 3.5
            else noise.randint(-12, 12)
            for i in range(RATE * DURATION)
        ),
    )
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(samples.tobytes())


def _edit(name: str, start: float, end: float, *, reason="nl:range", **fields) -> EditDecision:
    return EditDecision(
        id=name,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason=reason,
        applied=False,
        boundary_mode="vocal_transcript_guided",
        boundary_intent=CutIntent.PROGRAMMATIC,
        **fields,
    )


def build(tmp_path: Path, *, implicit_guest: bool = False) -> ProjectWorkspace:
    """Two bursty tracks with every kind of project state a cut could be tempted to write."""
    project = EpisodeProject.create("write scope", str(tmp_path))
    project.tracks = []
    project.clips = []
    for track_id, hz in (("host", 180), ("guest", 230)):
        _tone(tmp_path / "raw" / f"{track_id}.wav", hz)
        project.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(
                    path=f"raw/{track_id}.wav",
                    duration_sec=DURATION,
                    sample_rate=RATE,
                    channels=1,
                ),
            )
        )
        if track_id == "guest" and implicit_guest:
            continue
        project.clips.append(
            Clip(
                id=track_id,
                track_id=track_id,
                source_start=0,
                source_end=DURATION,
                timeline_start=0,
            )
        )
    project.timeline.duration_sec = DURATION
    project.clips[0].mute_regions = [ClipMuteRegion(start_s=33.0, end_s=33.4)]
    project.meta.ingest_alignment = {"host:host": SpeakerIngestAlignment(align_method="manual")}
    project.transcripts = [
        Transcript(
            track_id=track_id,
            words=[
                TranscriptWord(
                    text=f"w{block}_{k}",
                    start=block * SPAN + 0.25 * k + 0.02,
                    end=block * SPAN + 0.25 * k + 0.2,
                )
                for block in range(DURATION // SPAN)
                for k in range(14)
            ]
            + [
                TranscriptWord(text=f"um{block}", start=block * SPAN + 3.9, end=block * SPAN + 4.1)
                for block in range(DURATION // SPAN)
                if track_id == "host"
            ],
            archived_words=[
                ArchivedTranscriptWord(
                    ordinal=0, word=TranscriptWord(text="gone", start=0.0, end=0.01)
                )
            ],
        )
        for track_id in ("host", "guest")
    ]
    project.editorial.edit_log = [
        AppliedEditRecord(id="alog_old", applied_at="2026-01-01T00:00:00+00:00", operation="seed")
    ]
    project.chapters = [ChapterMarker(time=t, title=f"c{t}") for t in (2.0, 20.0, 50.0)]
    project.comments = [
        TimelineComment(
            id=f"k{t}",
            body="note",
            author="me",
            created_at="2026-01-01T00:00:00+00:00",
            timeline_start=t,
            timeline_end=t + 1,
        )
        for t in (1.0, 12.0, 41.0)
    ]
    project.render.last_completed_step = "propose"
    project.render.reconciliation_stale = True
    project.edit_decisions = [
        _edit("pending-a", 8.8, 9.2),
        _edit("pending-b", 33.8, 34.2),
    ]
    return ProjectWorkspace.open(save_project(project))


def digest(project: EpisodeProject) -> str:
    return hashlib.sha256(project.model_dump_json().encode()).hexdigest()


# (name, edit, whether the fixture drops the guest's clip). A cut in the silence between bursts
# applies; a cut inside a burst is peer speech on the other track and is held.
SHAPES = {
    "applied": (lambda: _edit("cut", 3.8, 4.2), False),
    "held": (lambda: _edit("cut", 1.0, 1.5), False),
    "punch": (lambda: _edit("cut", 3.8, 4.2, scope="track"), False),
    "room_tone_pad": (lambda: _edit("cut", 3.8, 4.2, replace_gap_sec=0.3), False),
    "implicit_clip": (lambda: _edit("cut", 3.8, 4.2), True),
}


@pytest.mark.parametrize("record_log", [False, True])
@pytest.mark.parametrize("shape", sorted(SHAPES))
def test_a_source_cut_leaves_its_input_project_unchanged(tmp_path, shape, record_log):
    make, implicit = SHAPES[shape]
    ws = build(tmp_path, implicit_guest=implicit)
    project = ws.project
    before = digest(project)

    result = _apply_source_remove(
        project, make(), defaults=ws.effective_config(), batch=(), record_log=record_log
    )

    assert digest(project) == before
    assert project.render.last_completed_step == "propose"
    if shape == "held":
        assert isinstance(result, CutScopeHold)
    else:
        candidate, report = result
        assert digest(candidate) != before
        logged = len(candidate.editorial.edit_log) - len(project.editorial.edit_log)
        assert (logged > 0) is record_log
        if shape == "room_tone_pad":
            assert report[3]["pad_samples"]
        if shape == "implicit_clip":
            assert any(c.track_id == "guest" for c in candidate.clips)


@pytest.mark.parametrize("shape", sorted(set(SHAPES) - {"held"}))
def test_the_candidate_owns_the_sections_a_cut_writes_and_shares_the_rest(tmp_path, shape):
    make, implicit = SHAPES[shape]
    ws = build(tmp_path, implicit_guest=implicit)
    project = ws.project

    candidate, _ = _apply_source_remove(
        project, make(), defaults=ws.effective_config(), batch=(), record_log=False
    )

    for name in ("mix", "render", "social", "history", "document_sync"):
        assert getattr(candidate, name) is getattr(project, name), name
    for name in (
        "retained_bleed_alignments",
        "sound_actions",
        "speaker_splits",
        "record_sessions",
        "session_suggestions",
    ):
        assert getattr(candidate.editorial, name) is getattr(project.editorial, name), name
    assert candidate.review.versions is project.review.versions
    assert candidate.sources is not project.sources
    assert candidate.sources == project.sources
    assert candidate.transcript_data.combined is not project.transcript_data.combined
    assert candidate.timeline is not project.timeline
    assert candidate.timeline.clips is not project.timeline.clips
    assert candidate.editorial is not project.editorial
    assert candidate.editorial.edit_decisions is not project.editorial.edit_decisions
    assert candidate.editorial.chapters is not project.editorial.chapters
    assert candidate.review.comments is not project.review.comments
    assert candidate.meta.ingest_alignment is not project.meta.ingest_alignment
    original_clips = {id(clip) for clip in project.clips}
    assert not original_clips & {id(clip) for clip in candidate.clips}
    for mine, theirs in zip(candidate.transcripts, project.transcripts, strict=True):
        assert mine is not theirs
        assert mine.words is not theirs.words
        assert mine.archived_words is not theirs.archived_words
        assert mine.archived_words[0] is theirs.archived_words[0]
    host, original = candidate.transcripts[0], project.transcripts[0]
    assert len(host.archived_words) > len(original.archived_words)
    assert len(host.words) < len(original.words)
    assert host.words[0] is original.words[0]


def test_a_held_edit_still_leaves_the_pending_decisions_as_they_were(tmp_path):
    ws = build(tmp_path)
    project = ws.project
    decisions = list(project.edit_decisions)
    fields = [d.model_dump_json() for d in decisions]

    _apply_source_remove(
        project, _edit("cut", 1.0, 1.5), defaults=ws.effective_config(), batch=(), record_log=False
    )

    assert project.edit_decisions == decisions
    assert [d.model_dump_json() for d in decisions] == fields
    assert all(a is b for a, b in zip(project.edit_decisions, decisions, strict=True))


def test_a_write_to_a_decision_after_the_cut_does_not_reach_the_candidate(tmp_path):
    """``_apply_auto_removes`` rewrites the decision it was handed after the cut."""
    ws = build(tmp_path)
    project = ws.project
    pending = project.edit_decisions[0]

    candidate, _ = _apply_source_remove(
        project, _edit("cut", 3.8, 4.2), defaults=ws.effective_config(), batch=(), record_log=False
    )
    pending.replace_gap_sec = 0.9
    pending.start = 8.0

    mirrored = next(d for d in candidate.edit_decisions if d.id == pending.id)
    assert mirrored is not pending
    assert mirrored.replace_gap_sec is None
    assert mirrored.start == 8.8


def _spy_copies(monkeypatch):
    """Every ``_cut_copy`` made: (source, its copy, digest of the source at that moment)."""
    made: list[tuple[EpisodeProject, EpisodeProject, str]] = []
    real = cut_application._cut_copy

    def spy(project):
        duplicate = real(project)
        made.append((project, duplicate, digest(project)))
        return duplicate

    monkeypatch.setattr(cut_application, "_cut_copy", spy)
    return made


def _batch(ws: ProjectWorkspace, edits: list[EditDecision]) -> EpisodeProject:
    project = ws.project.model_copy(deep=True)
    project.edit_decisions = edits
    return project


def test_a_batch_with_held_applied_and_padded_cuts_never_changes_the_project_it_approves(
    tmp_path, monkeypatch
):
    ws = build(tmp_path)
    ids = ["applied", "held", "padded", "punch"]
    project = _batch(
        ws,
        [
            _edit("applied", 3.8, 4.2),
            _edit("held", 31.0, 31.5),
            _edit("padded", 23.8, 24.2, replace_gap_sec=0.3),
            _edit("punch", 43.8, 44.2, scope="track"),
        ],
    )
    published = digest(project)
    made = _spy_copies(monkeypatch)
    held: list = []

    applied = approve_edits(project, ids, defaults=ws.effective_config(), held_out=held)

    assert applied == 3
    assert [h.edit_id for h in held] == ["held"]
    assert made
    for source, _copy, source_digest in made:
        assert digest(source) == source_digest
    assert digest(project) != published


def test_a_forced_re_pass_leaves_the_mute_base_it_restarts_from_unchanged(tmp_path, monkeypatch):
    """An applied cut beside a newly held one starts the pass over from ``mute_base``."""
    ws = build(tmp_path)
    ids = ["near-applied", "near-held"]
    project = _batch(ws, [_edit("near-applied", 3.8, 4.2), _edit("near-held", 2.9, 3.4)])
    made = _spy_copies(monkeypatch)
    held: list = []

    approve_edits(project, ids, defaults=ws.effective_config(), held_out=held)

    base = made[0][1]
    restarts = [entry for entry in made if entry[0] is base]
    assert len(restarts) >= 2, "the held cut beside an applied one must force a second pass"
    assert {digest(src) for src, _c, _d in restarts} == {restarts[0][2]}
    assert digest(base) == restarts[0][2]
    assert {h.edit_id for h in held} == {"near-held", "near-applied"}


@pytest.mark.parametrize("shape", ["applied", "punch", "room_tone_pad", "implicit_clip"])
def test_a_cut_adds_archive_entries_without_touching_the_ones_it_shares(tmp_path, shape):
    """Words and archive entries are shared objects, so a cut must only append and replace."""
    make, implicit = SHAPES[shape]
    ws = build(tmp_path, implicit_guest=implicit)
    project = ws.project
    entries = [list(t.archived_words) for t in project.transcripts]
    entry_dumps = [[e.model_dump() for e in group] for group in entries]
    word_dumps = [[w.model_dump() for w in t.words] for t in project.transcripts]

    candidate, _ = _apply_source_remove(
        project, make(), defaults=ws.effective_config(), batch=(), record_log=True
    )

    for mine, shared, dumps in zip(candidate.transcripts, entries, entry_dumps, strict=True):
        assert all(a is b for a, b in zip(mine.archived_words, shared, strict=False))
        assert [e.model_dump() for e in shared] == dumps
    host = candidate.transcripts[0]
    assert len(host.archived_words) > len(entries[0])
    assert [[w.model_dump() for w in t.words] for t in project.transcripts] == word_dumps
    survivors = {id(w) for t in project.transcripts for w in t.words}
    assert all(id(w) in survivors for t in candidate.transcripts for w in t.words)
