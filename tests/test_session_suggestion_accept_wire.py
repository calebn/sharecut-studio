"""Pin the exact wire output of SessionSuggestionService.accept on every surface that forwards it."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE, TranscriptRefineRequiredError
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    StagedComment,
    StagedRoomTone,
    StagedTake,
)
from session_suggestion_wire_helpers import (
    ALL_SURFACES,
    THREE_TAKES,
    Scenario,
    Step,
    add_music_track,
    call,
    dump,
    guest_speech,
    run,
    stage_files,
    stage_insert,
    stage_replace,
    stage_unanchored_replace,
)
from test_record_session_preview import _source

pytest_plugins = ["test_record_session_preview"]
pytestmark = pytest.mark.unscoped_ok

ACCEPT = Step("accept")
SECOND = "ss-" + "b" * 12


def _scenario(build, *steps: Step, context=None) -> Scenario:
    return Scenario(build, steps or (ACCEPT,), ALL_SURFACES, context)


def _three(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, THREE_TAKES)


def _single(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})


def _same_length(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)], 1: [("host", 0.0, 2.0)]})


def _shorter(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 0.5)]})


def _at_start(ws) -> str:
    return stage_replace(ws, 0.0, 2.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 3.0)]})


def _to_end(ws) -> str:
    return stage_replace(ws, 8.0, 10.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 3.0)]})


def _segments(ws) -> str:
    return stage_replace(
        ws, 3.0, 5.0, {0: [("host", 0.0, 1.0), ("host", 1.5, 0.5), ("host", 3.0, 1.0)]}
    )


def _two_tracks(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {
            0: [("host", 0.0, 1.0), ("guest", 0.0, 1.0)],
            1: [("host", 0.0, 3.0), ("guest", 0.5, 2.0)],
        },
        track_ids=["host", "guest"],
    )


def _not_recorded(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 2.0)], 1: [("host", 0.0, 2.0), ("guest", 0.0, 2.0)]},
        track_ids=["host", "guest"],
    )


def _commented(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)]},
        comments={0: [("a", 100), ("b", 250)], 1: [("c", 50), ("d", 1500)]},
    )


def _commented_discarded_only(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)]},
        comments={0: [("a", 100)]},
    )


def _commented_discarded_many(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)], 2: [("host", 0.0, 3.0)]},
        comments={0: [("a", 100), ("b", 200)], 1: [("c", 300)]},
    )


def _with_bed(ws) -> str:
    sid = _three(ws)

    def add(project) -> None:
        project.editorial.session_suggestions[0].room_tone.append(
            StagedRoomTone(
                track_id="host",
                track_label="Host",
                source_id="bed-1",
                path="raw/bed-1.wav",
                duration_s=2.0,
                sample_rate=48_000,
                channels=1,
            )
        )

    ws.mutate("bed", "bedded", add)
    return sid


def _with_music(ws) -> str:
    add_music_track(ws)
    return _three(ws)


def _with_music_same_length(ws) -> str:
    add_music_track(ws)
    return _same_length(ws)


def _review_comment(ws) -> str:
    ws.mutate(
        "comment",
        "commented",
        lambda p: add_comment(p, body="inside", author="rev", timeline_start=3.5, comment_id="rc1"),
    )
    return _three(ws)


def _review_comments(ws) -> str:
    def add(project) -> None:
        add_comment(project, body="inside", author="rev", timeline_start=3.5, comment_id="rc1")
        add_comment(project, body="after", author="rev", timeline_start=7.0, comment_id="rc2")
        add_comment(project, body="before", author="rev", timeline_start=1.0, comment_id="rc3")

    ws.mutate("comments", "commented", add)
    return _three(ws)


def _decision(start: float, end: float, edit_id: str = "later") -> Any:
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.MUTE,
        start=start,
        end=end,
        timebase="timeline",
        applied=False,
    )


def _pending_after(ws) -> str:
    ws.mutate(
        "decision", "decided", lambda p: p.editorial.edit_decisions.append(_decision(7.0, 7.5))
    )
    return _three(ws)


def _pending_inside(ws) -> str:
    ws.mutate(
        "decision", "decided", lambda p: p.editorial.edit_decisions.append(_decision(3.5, 4.0))
    )
    return _three(ws)


def _held(ws) -> str:
    guest_speech(ws)
    return stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 3.0)]})


def _held_single(ws) -> str:
    guest_speech(ws)
    return stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})


def _held_many_words(ws) -> str:
    from test_record_replace_accept import _words

    _words(
        ws,
        "guest",
        ("one", 2.1, 2.3),
        ("two", 2.4, 2.6),
        ("three", 2.7, 2.9),
        ("four", 3.0, 3.2),
        ("five", 3.3, 3.5),
        ("six", 3.6, 3.8),
    )
    return stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})


def _held_host_speech(ws) -> str:
    from test_record_replace_accept import _words

    _words(ws, "host", ("hello", 2.5, 2.9))
    return stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})


def _insert(ws) -> str:
    return stage_insert(ws, 4.0, [1.0, 1.5])


def _insert_bed(ws) -> str:
    return stage_insert(ws, 4.0, [1.0, 1.5], bed=2.0)


def _insert_start(ws) -> str:
    return stage_insert(ws, 0.0, [1.0])


def _insert_end(ws) -> str:
    return stage_insert(ws, 10.0, [1.0])


def _insert_music(ws) -> str:
    add_music_track(ws)
    return _insert(ws)


def _insert_comments(ws) -> str:
    sid = _insert(ws)

    def add(project) -> None:
        takes = project.editorial.session_suggestions[0].takes
        takes[0].comments.append(
            StagedComment(
                id="live-0-0", author="host", body="first", recording_ms=250, timeline_offset_s=0.0
            )
        )
        takes[0].comments.append(
            StagedComment(
                id="live-0-1",
                author="guest",
                body="second",
                recording_ms=900,
                timeline_offset_s=0.5,
            )
        )

    ws.mutate("comments", "commented", add)
    return sid


def _insert_two_tracks(ws) -> str:
    sid = _insert(ws)

    def add(project) -> None:
        project.sources.append(_source("rec-guest-0", "raw/rec-guest-0.wav", 2.0))
        project.editorial.session_suggestions[0].takes.append(
            StagedTake(
                take_index=0,
                track_id="guest",
                track_label="Guest",
                segment_index=0,
                source_id="rec-guest-0",
                offset_s=0.0,
                duration_s=2.0,
            )
        )

    ws.mutate("guest", "guested", add)
    stage_files(ws)
    return sid


def _insert_non_dialogue(ws) -> str:
    sid = _insert(ws)
    add_music_track(ws)
    ws.mutate(
        "retarget",
        "retargeted",
        lambda p: [
            setattr(take, "track_id", "music") for take in p.editorial.session_suggestions[0].takes
        ],
    )
    return sid


def _insert_no_anchor(ws) -> str:
    sid = _insert(ws)
    ws.mutate(
        "unanchor",
        "unanchored",
        lambda p: setattr(p.editorial.session_suggestions[0], "anchor", None),
    )
    return sid


def _insert_empty(ws) -> str:
    sid = _insert(ws)
    ws.mutate(
        "empty", "emptied", lambda p: setattr(p.editorial.session_suggestions[0], "takes", [])
    )
    return sid


def _insert_pending_edit(ws) -> str:
    ws.mutate(
        "decision", "decided", lambda p: p.editorial.edit_decisions.append(_decision(4.5, 5.0))
    )
    return _insert(ws)


def _drop_sources(ws) -> None:
    ws.mutate(
        "drop",
        "dropped",
        lambda p: setattr(p, "sources", [s for s in p.sources if not s.id.startswith("rec-")]),
    )


def _source_gone(ws) -> str:
    sid = _three(ws)
    _drop_sources(ws)
    return sid


def _insert_source_gone(ws) -> str:
    sid = _insert(ws)
    _drop_sources(ws)
    return sid


def _drop_host_clips(ws) -> None:
    ws.mutate(
        "gone",
        "gone",
        lambda p: setattr(p, "clips", [c for c in p.clips if c.track_id != "host"]),
    )


def _range_gone(ws) -> str:
    sid = _three(ws)
    _drop_host_clips(ws)
    return sid


def _empty(ws) -> str:
    sid = _three(ws)
    ws.mutate(
        "empty", "emptied", lambda p: setattr(p.editorial.session_suggestions[0], "takes", [])
    )
    return sid


def _zero_length(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 0.0)], 1: [("host", 0.0, 2.0)]})


def _music(ws) -> str:
    add_music_track(ws)
    return stage_replace(ws, 3.0, 5.0, {0: [("music", 0.0, 1.0)]}, track_ids=["music"])


def _unanchored(ws) -> str:
    return stage_unanchored_replace(ws, 3.0, 5.0, THREE_TAKES)


def _two_sessions(ws) -> str:
    first = _three(ws)
    stage_replace(
        ws,
        6.0,
        8.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 3.0)]},
        session_id="b" * 12,
        number=2,
    )
    return first


def _gated():
    return patch.object(
        REFINE_GATE, "assert_clear", side_effect=TranscriptRefineRequiredError("refine first")
    )


def _after(build, *ops: tuple[str, int | None]):
    def prepared(ws) -> str:
        sid = build(ws)
        for op, take in ops:
            call("service", ws, Step(op, take=take), sid)
        return sid

    return prepared


SCENARIOS: dict[str, Scenario] = {
    "replace-default-last-take": _scenario(_three),
    "replace-take-0": _scenario(_three, Step("accept", take=0)),
    "replace-take-1": _scenario(_three, Step("accept", take=1)),
    "replace-take-2": _scenario(_three, Step("accept", take=2)),
    "replace-selected-take": _scenario(_after(_three, ("select", 0)), ACCEPT),
    "replace-explicit-take-beats-selected": _scenario(
        _after(_three, ("select", 0)), Step("accept", take=2)
    ),
    "replace-select-through-the-wire-then-accept": _scenario(
        _three, Step("select", take=1), ACCEPT
    ),
    "replace-single-take": _scenario(_single),
    "replace-single-take-explicit": _scenario(_single, Step("accept", take=0)),
    "replace-same-length": _scenario(_same_length, Step("accept", take=1)),
    "replace-shorter-take": _scenario(_shorter),
    "replace-at-the-start": _scenario(_at_start),
    "replace-to-the-end": _scenario(_to_end),
    "replace-several-segments": _scenario(_segments),
    "replace-two-tracks-default": _scenario(_two_tracks),
    "replace-two-tracks-first-take": _scenario(_two_tracks, Step("accept", take=0)),
    "replace-staged-comments-chosen-and-discarded": _scenario(_commented),
    "replace-staged-comments-chosen-first": _scenario(_commented, Step("accept", take=0)),
    "replace-one-discarded-comment": _scenario(_commented_discarded_only),
    "replace-many-discarded-takes-and-comments": _scenario(
        _commented_discarded_many, Step("accept", take=2)
    ),
    "replace-many-discarded-takes-no-comments": _scenario(_three),
    "replace-room-tone-not-placed": _scenario(_with_bed),
    "replace-moves-music-clip-not": _scenario(_with_music),
    "replace-same-length-leaves-music-unlisted": _scenario(
        _with_music_same_length, Step("accept", take=1)
    ),
    "replace-clamps-a-review-comment": _scenario(_review_comment),
    "replace-moves-review-comments": _scenario(_review_comments),
    "replace-shifts-a-later-pending-edit": _scenario(_pending_after),
    "replace-second-session-only": _scenario(
        _two_sessions, Step("accept", sid=SECOND), Step("takes", sid=SECOND)
    ),
    "replace-then-list": _scenario(_single, ACCEPT, Step("list")),
    "replace-then-takes": _scenario(_three, ACCEPT, Step("takes")),
    "replace-held-by-another-speakers-words": _scenario(_held),
    "replace-held-with-explicit-take": _scenario(_held, Step("accept", take=1)),
    "replace-held-single-take": _scenario(_held_single),
    "replace-held-six-words": _scenario(_held_many_words),
    "replace-held-then-overridden": _scenario(_held, ACCEPT, Step("accept", override=True)),
    "replace-held-then-held-again": _scenario(_held, ACCEPT, ACCEPT),
    "replace-override-flag-on-a-clear-replace": _scenario(_three, Step("accept", override=True)),
    "replace-overridden-at-once": _scenario(_held, Step("accept", override=True)),
    "replace-own-track-speech-never-asks": _scenario(_held_host_speech),
    "replace-held-leaves-no-history-step": _scenario(_held, ACCEPT, Step("takes")),
    "replace-twice": _scenario(_three, ACCEPT, ACCEPT),
    "replace-after-skip": _scenario(_after(_three, ("skip", None)), ACCEPT),
    "replace-unknown-id": _scenario(_three, Step("accept", sid="ss-nope")),
    "replace-empty-id": _scenario(_three, Step("accept", sid="")),
    "replace-unknown-take": _scenario(_three, Step("accept", take=9)),
    "replace-negative-take": _scenario(_three, Step("accept", take=-1)),
    "replace-unknown-take-after-pick": _scenario(
        _three, Step("select", take=1), Step("accept", take=9)
    ),
    "replace-take-not-recorded": _scenario(_not_recorded, Step("accept", take=0)),
    "replace-take-not-recorded-overridden": _scenario(
        _not_recorded, Step("accept", take=0, override=True)
    ),
    "replace-recorded-take-of-two-tracks": _scenario(_not_recorded, Step("accept", take=1)),
    "replace-non-dialogue-track": _scenario(_music),
    "replace-pending-edit-in-range": _scenario(_pending_inside),
    "replace-pending-edit-in-range-overridden": _scenario(
        _pending_inside, Step("accept", override=True)
    ),
    "replace-unanchored": _scenario(_unanchored),
    "replace-range-gone": _scenario(_range_gone),
    "replace-source-gone": _scenario(_source_gone),
    "replace-no-takes": _scenario(_empty),
    "replace-zero-length-take": _scenario(_zero_length, Step("accept", take=0)),
    "replace-refine-gate": _scenario(_three, context=_gated),
    "replace-refine-gate-single-take": _scenario(_single, context=_gated),
    "insert-plain": _scenario(_insert),
    "insert-with-bed": _scenario(_insert_bed),
    "insert-at-the-start": _scenario(_insert_start),
    "insert-at-the-end": _scenario(_insert_end),
    "insert-two-tracks": _scenario(_insert_two_tracks),
    "insert-staged-comments": _scenario(_insert_comments),
    "insert-with-music-clip-after": _scenario(_insert_music),
    "insert-with-a-pending-edit-after": _scenario(_insert_pending_edit),
    "insert-override-flag-is-harmless": _scenario(_insert, Step("accept", override=True)),
    "insert-then-list": _scenario(_insert, ACCEPT, Step("list")),
    "insert-then-takes": _scenario(_insert, ACCEPT, Step("takes")),
    "insert-with-a-take-index": _scenario(_insert, Step("accept", take=0)),
    "insert-with-a-take-index-then-plain": _scenario(_insert, Step("accept", take=1), ACCEPT),
    "insert-twice": _scenario(_insert, ACCEPT, ACCEPT),
    "insert-after-skip": _scenario(_after(_insert, ("skip", None)), ACCEPT),
    "insert-non-dialogue-track": _scenario(_insert_non_dialogue),
    "insert-no-anchor": _scenario(_insert_no_anchor),
    "insert-no-takes": _scenario(_insert_empty),
    "insert-source-gone": _scenario(_insert_source_gone),
    "insert-needs-no-refine": _scenario(_insert, context=_gated),
}

EXPECTED: dict[str, Any] = {
    "insert-after-skip": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already skipped, so "
                    "it cannot be changed again. Undo "
                    "that step first if you want it "
                    "back, or record a new session.",
                }
            }
        ],
    },
    "insert-at-the-end": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 10.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 10.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "span_s": 1.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 10.0,
                            "kind": "end",
                            "offset_s": 0.0,
                            "side": None,
                            "source_id": None,
                            "source_sec": None,
                            "track_id": None,
                        },
                        "at_sec": 10.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-at-the-start": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 0.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 0.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "span_s": 1.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 0.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 0.0,
                            "track_id": "host",
                        },
                        "at_sec": 0.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-needs-no-refine": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-no-anchor": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "stale_anchor",
                    "message": "This session has no recorded insert point. Record it again.",
                }
            }
        ],
    },
    "insert-no-takes": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_empty",
                    "message": "Session 1 has no recorded takes to "
                    "accept. Record it again, or skip "
                    "it.",
                }
            }
        ],
    },
    "insert-non-dialogue-track": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "track_not_dialogue",
                    "message": "track music is a music "
                    "track, so Session 1 cannot "
                    "be placed on it. Rename or "
                    "remove that track, then try "
                    "again.",
                }
            }
        ],
    },
    "insert-override-flag-is-harmless": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-plain": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-source-gone": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "staged_source_missing",
                    "message": "The recording for take 0 is no "
                    "longer in the project. Record the "
                    "session again.",
                }
            }
        ],
    },
    "insert-staged-comments": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [
                        {"id": "live-0-0", "timeline_start": 4.25},
                        {"id": "live-0-1", "timeline_start": 5.4},
                    ],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [
                                    {
                                        "author": "host",
                                        "body": "first",
                                        "id": "live-0-0",
                                        "recording_ms": 250,
                                        "timeline_offset_s": 0.0,
                                    },
                                    {
                                        "author": "guest",
                                        "body": "second",
                                        "id": "live-0-1",
                                        "recording_ms": 900,
                                        "timeline_offset_s": 0.5,
                                    },
                                ],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-then-list": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            },
            {
                "ok": [
                    {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    }
                ]
            },
        ],
    },
    "insert-then-takes": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            },
            {
                "ok": {
                    "default_take": None,
                    "kind": "insert",
                    "selectable": False,
                    "selected_take": None,
                    "status": "accepted",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already "
                                "accepted, so it "
                                "cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you "
                                "want it back, "
                                "or record a new "
                                "session.",
                            },
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
                                    "segments": 2,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        }
                    ],
                }
            },
        ],
    },
    "insert-twice": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            },
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already accepted, so it "
                    "cannot be changed again. Undo that step "
                    "first if you want it back, or record a "
                    "new session.",
                }
            },
        ],
    },
    "insert-two-tracks": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:2>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-guest-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "guest",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-guest-0",
                                "take_index": 0,
                                "track_id": "guest",
                                "track_label": "Guest",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-with-a-pending-edit-after": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-with-a-take-index": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "take_not_applicable",
                    "message": "Session 1 is an insert, "
                    "whose takes play one after "
                    "another, so a take cannot be "
                    "chosen. Accept it without a "
                    "take.",
                }
            }
        ],
    },
    "insert-with-a-take-index-then-plain": {
        "history_steps_added": [0, 1],
        "outcomes": [
            {
                "error": {
                    "code": "take_not_applicable",
                    "message": "Session 1 is an "
                    "insert, whose "
                    "takes play one "
                    "after another, so "
                    "a take cannot be "
                    "chosen. Accept it "
                    "without a take.",
                }
            },
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            },
        ],
    },
    "insert-with-bed": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [
                            {
                                "channels": 1,
                                "duration_s": 2.0,
                                "path": "raw/bed-1.wav",
                                "sample_rate": 48000,
                                "source_id": "bed-1",
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "insert-with-music-clip-after": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 4.0,
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 4.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 5.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "at_sec": 4.0,
                        "end_anchor": None,
                        "from_sec": None,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "insert",
                        "room_tone": [],
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.5,
                                "offset_s": 1.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": None,
                        "track_follows": {},
                        "track_ids": [],
                    },
                    "unmoved_track_ids": ["music"],
                }
            }
        ],
    },
    "replace-after-skip": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already skipped, so "
                    "it cannot be changed again. Undo "
                    "that step first if you want it "
                    "back, or record a new session.",
                }
            }
        ],
    },
    "replace-at-the-start": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 0.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 0.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 0.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 0.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 0.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "from_sec": 0.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 2.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 2.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-clamps-a-review-comment": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": ["rc1"],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other takes "
                    "(0, 1) were "
                    "discarded. Undo "
                    "brings them "
                    "back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-default-last-take": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other takes (0, 1) "
                    "were discarded. Undo "
                    "brings them back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-empty-id": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_not_found",
                    "message": "unknown session suggestion: . List "
                    "the staged sessions to see their "
                    "ids.",
                }
            }
        ],
    },
    "replace-explicit-take-beats-selected": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other "
                    "takes (0, "
                    "1) were "
                    "discarded. "
                    "Undo brings "
                    "them back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-held-by-another-speakers-words": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it "
                    "as is, "
                    "repeat the "
                    "call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back.",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            }
        ],
    },
    "replace-held-leaves-no-history-step": {
        "history_steps_added": [0, 0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it as "
                    "is, repeat the "
                    "call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back.",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            },
            {
                "ok": {
                    "default_take": 1,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 1.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": True,
                            "duration_s": 3.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 3.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                    ],
                }
            },
        ],
    },
    "replace-held-single-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it as is, repeat "
                    "the call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to apply "
                        "it; undo "
                        "brings "
                        "it back.",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            }
        ],
    },
    "replace-held-six-words": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it as is, repeat "
                    "the call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this range "
                        "also "
                        "removes 6 "
                        "words from "
                        "Guest: "
                        '"one two '
                        "three four "
                        'five six". '
                        "Replace "
                        "anyway to "
                        "apply it; "
                        "undo "
                        "brings it "
                        "back.",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "one", "timeline_end": 2.3, "timeline_start": 2.1},
                                        {"text": "two", "timeline_end": 2.6, "timeline_start": 2.4},
                                        {
                                            "text": "three",
                                            "timeline_end": 2.9,
                                            "timeline_start": 2.7,
                                        },
                                        {
                                            "text": "four",
                                            "timeline_end": 3.2,
                                            "timeline_start": 3.0,
                                        },
                                        {
                                            "text": "five",
                                            "timeline_end": 3.5,
                                            "timeline_start": 3.3,
                                        },
                                        {"text": "six", "timeline_end": 3.8, "timeline_start": 3.6},
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            }
        ],
    },
    "replace-held-then-held-again": {
        "history_steps_added": [0, 0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it as is, "
                    "repeat the call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back.",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            },
            {
                "ok": {
                    "apply_anyway": "To apply it as is, "
                    "repeat the call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back.",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            },
        ],
    },
    "replace-held-then-overridden": {
        "history_steps_added": [0, 1],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it as is, "
                    "repeat the call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back.",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            },
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            },
        ],
    },
    "replace-held-with-explicit-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it as is, "
                    "repeat the call "
                    "with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back.",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            }
        ],
    },
    "replace-many-discarded-takes-and-comments": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 3,
                    "delta_s": 1.0,
                    "discard_message": "The "
                    "other "
                    "takes "
                    "(0, 1) "
                    "were "
                    "discarded. "
                    "3 "
                    "comments "
                    "on "
                    "them "
                    "left "
                    "out. "
                    "Undo "
                    "brings "
                    "them "
                    "back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-many-discarded-takes-no-comments": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The "
                    "other "
                    "takes "
                    "(0, 1) "
                    "were "
                    "discarded. "
                    "Undo "
                    "brings "
                    "them "
                    "back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-moves-music-clip-not": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other takes (0, "
                    "1) were discarded. "
                    "Undo brings them "
                    "back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": ["music"],
                }
            }
        ],
    },
    "replace-moves-review-comments": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": ["rc1"],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other takes "
                    "(0, 1) were "
                    "discarded. Undo "
                    "brings them back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-negative-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "take_not_found",
                    "message": "Session 1 has no take -1. Pick one of: 0, 1, 2.",
                }
            }
        ],
    },
    "replace-no-takes": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_empty",
                    "message": "Session 1 has no recorded takes to "
                    "accept. Record it again, or skip "
                    "it.",
                }
            }
        ],
    },
    "replace-non-dialogue-track": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "track_not_dialogue",
                    "message": "track music is a music "
                    "track, so Session 1 cannot "
                    "be placed on it. Rename or "
                    "remove that track, then "
                    "try again.",
                }
            }
        ],
    },
    "replace-one-discarded-comment": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 1,
                    "delta_s": 0.0,
                    "discard_message": "The other take (0) "
                    "was discarded. 1 "
                    "comment on it left "
                    "out. Undo brings "
                    "it back.",
                    "discarded_takes": [0],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-overridden-at-once": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-override-flag-on-a-clear-replace": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The "
                    "other "
                    "takes "
                    "(0, 1) "
                    "were "
                    "discarded. "
                    "Undo "
                    "brings "
                    "them "
                    "back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-own-track-speech-never-asks": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": None,
                    "discarded_takes": [],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-pending-edit-in-range": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "pending_edits_in_range",
                    "message": "1 pending edit sits "
                    "inside the range this "
                    "session replaces. "
                    "Approve or reject them "
                    "first, then try "
                    "again.",
                }
            }
        ],
    },
    "replace-pending-edit-in-range-overridden": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "pending_edits_in_range",
                    "message": "1 pending "
                    "edit sits "
                    "inside the "
                    "range this "
                    "session "
                    "replaces. "
                    "Approve or "
                    "reject them "
                    "first, then "
                    "try "
                    "again.",
                }
            }
        ],
    },
    "replace-range-gone": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "stale_anchor",
                    "message": "The audio this session was staged "
                    "at is no longer on the timeline, "
                    "or more than one copy of it is. "
                    "Record the session again at the "
                    "new spot.",
                }
            }
        ],
    },
    "replace-recorded-take-of-two-tracks": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 2.0,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-1-guest-1",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "guest",
                        },
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 0.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-1-guest-1",
                                "take_index": 1,
                                "track_id": "guest",
                                "track_label": "Guest",
                            },
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host", "guest"],
                    },
                    "take_index": 1,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-refine-gate": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "transcript_refine_required",
                    "message": "The transcript clean-up needs to "
                    "finish first, so the words this "
                    "replace removes are the right "
                    "ones. Finish it with `podcast "
                    "transcript refine-done` / "
                    "`transcript_refine_done_tool`, or "
                    "skip it with `podcast transcript "
                    "refine-waive --reason ...` / "
                    "`transcript_refine_waive_tool`, "
                    "then try again.",
                }
            }
        ],
    },
    "replace-refine-gate-single-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "transcript_refine_required",
                    "message": "The transcript "
                    "clean-up needs to "
                    "finish first, so the "
                    "words this replace "
                    "removes are the right "
                    "ones. Finish it with "
                    "`podcast transcript "
                    "refine-done` / "
                    "`transcript_refine_done_tool`, "
                    "or skip it with "
                    "`podcast transcript "
                    "refine-waive --reason "
                    "...` / "
                    "`transcript_refine_waive_tool`, "
                    "then try again.",
                }
            }
        ],
    },
    "replace-room-tone-not-placed": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other takes (0, "
                    "1) were discarded. "
                    "Undo brings them "
                    "back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 1,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [
                            {
                                "channels": 1,
                                "duration_s": 2.0,
                                "path": "raw/bed-1.wav",
                                "sample_rate": 48000,
                                "source_id": "bed-1",
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-same-length": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 0.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-same-length-leaves-music-unlisted": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 0.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-second-session-only": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 6.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-bbbbbbbbbbbb-1-host-0",
                            "take_index": 1,
                            "timeline_start": 6.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 6.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 6.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 6.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 8.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 8.0,
                            "track_id": "host",
                        },
                        "from_sec": 6.0,
                        "id": "ss-bbbbbbbbbbbb",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "bbbbbbbbbbbb",
                        "session_number": 2,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 8.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 8.0,
                    "unmoved_track_ids": [],
                }
            },
            {
                "ok": {
                    "default_take": 1,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": 1,
                    "status": "accepted",
                    "suggestion_id": "ss-bbbbbbbbbbbb",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": True,
                            "default": True,
                            "duration_s": 3.0,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session "
                                "2 was "
                                "already "
                                "accepted, "
                                "so it "
                                "cannot "
                                "be "
                                "changed "
                                "again. "
                                "Undo "
                                "that "
                                "step "
                                "first "
                                "if "
                                "you "
                                "want "
                                "it "
                                "back, "
                                "or "
                                "record "
                                "a new "
                                "session.",
                            },
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 3.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        }
                    ],
                }
            },
        ],
    },
    "replace-select-through-the-wire-then-accept": {
        "history_steps_added": [1, 2],
        "outcomes": [
            {
                "ok": {
                    "selected_take": 1,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "pending",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                }
            },
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 0.5,
                    "discard_message": "The "
                    "other "
                    "takes "
                    "(0, "
                    "2) "
                    "were "
                    "discarded. "
                    "Undo "
                    "brings "
                    "them "
                    "back.",
                    "discarded_takes": [0, 2],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            },
        ],
    },
    "replace-selected-take": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": -1.0,
                    "discard_message": "The other takes (1, 2) "
                    "were discarded. Undo "
                    "brings them back.",
                    "discarded_takes": [1, 2],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 1.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-several-segments": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 0.5,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                            "take_index": 0,
                            "timeline_start": 4.5,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:2>",
                            "duration_s": 1.0,
                            "segment_index": 2,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-2",
                            "take_index": 0,
                            "timeline_start": 6.0,
                            "track_id": "host",
                        },
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 2.0,
                    "discard_message": None,
                    "discarded_takes": [],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 4.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 0.5,
                                "offset_s": 1.5,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-1",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 3.0,
                                "segment_index": 2,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-2",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-shifts-a-later-pending-edit": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other "
                    "takes (0, 1) "
                    "were "
                    "discarded. "
                    "Undo brings "
                    "them back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-shorter-take": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 0.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": -1.5,
                    "discard_message": None,
                    "discarded_takes": [],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 0.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 0.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-single-take": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 0.0,
                    "discard_message": None,
                    "discarded_takes": [],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-single-take-explicit": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 0.0,
                    "discard_message": None,
                    "discarded_takes": [],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-source-gone": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "staged_source_missing",
                    "message": "The recording for take 2 is no "
                    "longer in the project. Record the "
                    "session again.",
                }
            }
        ],
    },
    "replace-staged-comments-chosen-and-discarded": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [
                        {"id": "live-1-0", "timeline_start": 3.05},
                        {"id": "live-1-1", "timeline_start": 4.5},
                    ],
                    "comments_not_placed": 2,
                    "delta_s": 0.0,
                    "discard_message": "The "
                    "other "
                    "take "
                    "(0) "
                    "was "
                    "discarded. "
                    "2 "
                    "comments "
                    "on "
                    "them "
                    "left "
                    "out. "
                    "Undo "
                    "brings "
                    "it "
                    "back.",
                    "discarded_takes": [0],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [
                                    {
                                        "author": "host",
                                        "body": "note 1",
                                        "id": "live-1-0",
                                        "recording_ms": 50,
                                        "timeline_offset_s": 0.0,
                                    },
                                    {
                                        "author": "host",
                                        "body": "note 1",
                                        "id": "live-1-1",
                                        "recording_ms": 1500,
                                        "timeline_offset_s": 0.0,
                                    },
                                ],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-staged-comments-chosen-first": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [
                        {"id": "live-0-0", "timeline_start": 3.1},
                        {"id": "live-0-1", "timeline_start": 3.25},
                    ],
                    "comments_not_placed": 2,
                    "delta_s": -1.0,
                    "discard_message": "The other "
                    "take (1) "
                    "was "
                    "discarded. "
                    "2 comments "
                    "on them "
                    "left out. "
                    "Undo brings "
                    "it back.",
                    "discarded_takes": [1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 1.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [
                                    {
                                        "author": "host",
                                        "body": "note 0",
                                        "id": "live-0-0",
                                        "recording_ms": 100,
                                        "timeline_offset_s": 0.0,
                                    },
                                    {
                                        "author": "host",
                                        "body": "note 0",
                                        "id": "live-0-1",
                                        "recording_ms": 250,
                                        "timeline_offset_s": 0.0,
                                    },
                                ],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-take-0": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": -1.0,
                    "discard_message": "The other takes (1, 2) were "
                    "discarded. Undo brings them back.",
                    "discarded_takes": [1, 2],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 1.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-take-1": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 0.5,
                    "discard_message": "The other takes (0, 2) were "
                    "discarded. Undo brings them back.",
                    "discarded_takes": [0, 2],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-take-2": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other takes (0, 1) were "
                    "discarded. Undo brings them back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-take-not-recorded": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "track_not_recorded",
                    "message": "Take 0 did not record "
                    '"Guest", which this pickup '
                    "was set to replace. Pick a "
                    "take that recorded every "
                    "track, or record the "
                    "session again.",
                }
            }
        ],
    },
    "replace-take-not-recorded-overridden": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "track_not_recorded",
                    "message": "Take 0 did not "
                    'record "Guest", '
                    "which this "
                    "pickup was set "
                    "to replace. Pick "
                    "a take that "
                    "recorded every "
                    "track, or record "
                    "the session "
                    "again.",
                }
            }
        ],
    },
    "replace-then-list": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 2.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 0.0,
                    "discard_message": None,
                    "discarded_takes": [],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 2.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            },
            {
                "ok": [
                    {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    }
                ]
            },
        ],
    },
    "replace-then-takes": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other takes (0, 1) were "
                    "discarded. Undo brings them "
                    "back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            },
            {
                "ok": {
                    "default_take": 2,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": 2,
                    "status": "accepted",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": True,
                            "default": True,
                            "duration_s": 3.5,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already "
                                "accepted, so "
                                "it cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you "
                                "want it back, "
                                "or record a "
                                "new session.",
                            },
                            "speech_text": None,
                            "take_index": 2,
                            "tracks": [
                                {
                                    "duration_s": 3.5,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        }
                    ],
                }
            },
        ],
    },
    "replace-to-the-end": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 8.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 8.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 8.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 8.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 8.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 10.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "after",
                            "source_id": "src-host",
                            "source_sec": 10.0,
                            "track_id": "host",
                        },
                        "from_sec": 8.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 10.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 10.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-twice": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.5,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                            "take_index": 2,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.5,
                    "discard_message": "The other takes (0, 1) were "
                    "discarded. Undo brings them back.",
                    "discarded_takes": [0, 1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.5,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 2,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 2,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            },
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already accepted, so it "
                    "cannot be changed again. Undo that step "
                    "first if you want it back, or record a "
                    "new session.",
                }
            },
        ],
    },
    "replace-two-tracks-default": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 2.0,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-1-guest-1",
                            "take_index": 1,
                            "timeline_start": 3.5,
                            "track_id": "guest",
                        },
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.5,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-1-guest-1",
                                "take_index": 1,
                                "track_id": "guest",
                                "track_label": "Guest",
                            },
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host", "guest"],
                    },
                    "take_index": 1,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-two-tracks-first-take": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 3.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 1.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "host",
                        },
                        {
                            "clip_id": "<clip:1>",
                            "duration_s": 1.0,
                            "segment_index": 1,
                            "source_id": "rec-aaaaaaaaaaaa-0-guest-1",
                            "take_index": 0,
                            "timeline_start": 3.0,
                            "track_id": "guest",
                        },
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": -1.0,
                    "discard_message": "The other take (1) was discarded. Undo brings it back.",
                    "discarded_takes": [1],
                    "from_sec": 3.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 1.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 1,
                                "source_id": "rec-aaaaaaaaaaaa-0-guest-1",
                                "take_index": 0,
                                "track_id": "guest",
                                "track_label": "Guest",
                            },
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host", "guest"],
                    },
                    "take_index": 0,
                    "to_sec": 5.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    "replace-unanchored": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "stale_anchor",
                    "message": "This session was not recorded over "
                    "a range that starts and ends on "
                    "speech, so the audio to replace "
                    "cannot be found again. Record it "
                    "again with both ends on audio.",
                }
            }
        ],
    },
    "replace-unknown-id": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_not_found",
                    "message": "unknown session suggestion: "
                    "ss-nope. List the staged sessions "
                    "to see their ids.",
                }
            }
        ],
    },
    "replace-unknown-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "take_not_found",
                    "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
                }
            }
        ],
    },
    "replace-unknown-take-after-pick": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "selected_take": 1,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 3.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 3.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 5.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 5.0,
                            "track_id": "host",
                        },
                        "from_sec": 3.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "pending",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 3.5,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-2-host-0",
                                "take_index": 2,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                }
            },
            {
                "error": {
                    "code": "take_not_found",
                    "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
                }
            },
        ],
    },
    "replace-zero-length-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_empty",
                    "message": "Take 0 of Session 1 has no "
                    "recorded audio. Pick another "
                    "take, or record it "
                    "again.",
                }
            }
        ],
    },
}

OVERRIDES: dict[tuple[str, str], Any] = {
    ("replace-held-by-another-speakers-words", "cli"): {
        "history_steps_added": [0],
        "outcomes": [
            {
                "cli_exit": 1,
                "stderr": "Replacing this "
                "range also "
                "removes 2 words "
                'from Guest: "so '
                'plan". Replace '
                "anyway to apply "
                "it; undo brings "
                "it back.\n"
                "Nothing changed. "
                "To apply this "
                "replace as is, "
                "repeat the "
                "command with "
                "--override-audio-checks.\n",
            }
        ],
    },
    ("replace-held-by-another-speakers-words", "mcp"): {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To "
                    "apply "
                    "it "
                    "as "
                    "is, "
                    "repeat "
                    "the "
                    "call "
                    "with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back. "
                        "To "
                        "apply "
                        "it "
                        "as "
                        "is, "
                        "repeat "
                        "the "
                        "call "
                        "with "
                        "override_audio_checks=true "
                        "(CLI "
                        "--override-audio-checks).",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            }
        ],
    },
    ("replace-held-leaves-no-history-step", "cli"): {
        "history_steps_added": [0, 0],
        "outcomes": [
            {
                "cli_exit": 1,
                "stderr": "Replacing this "
                "range also removes "
                "2 words from Guest: "
                '"so plan". Replace '
                "anyway to apply it; "
                "undo brings it "
                "back.\n"
                "Nothing changed. To "
                "apply this replace "
                "as is, repeat the "
                "command with "
                "--override-audio-checks.\n",
            },
            {
                "ok": {
                    "default_take": 1,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 1.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": True,
                            "duration_s": 3.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 3.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                    ],
                }
            },
        ],
    },
    ("replace-held-leaves-no-history-step", "mcp"): {
        "history_steps_added": [0, 0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To "
                    "apply "
                    "it as "
                    "is, "
                    "repeat "
                    "the "
                    "call "
                    "with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back. "
                        "To "
                        "apply "
                        "it "
                        "as "
                        "is, "
                        "repeat "
                        "the "
                        "call "
                        "with "
                        "override_audio_checks=true "
                        "(CLI "
                        "--override-audio-checks).",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            },
            {
                "ok": {
                    "default_take": 1,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 1.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": True,
                            "duration_s": 3.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 3.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                    ],
                }
            },
        ],
    },
    ("replace-held-single-take", "cli"): {
        "history_steps_added": [0],
        "outcomes": [
            {
                "cli_exit": 1,
                "stderr": "Replacing this range also "
                "removes 2 words from Guest: "
                '"so plan". Replace anyway to '
                "apply it; undo brings it "
                "back.\n"
                "Nothing changed. To apply this "
                "replace as is, repeat the "
                "command with "
                "--override-audio-checks.\n",
            }
        ],
    },
    ("replace-held-single-take", "mcp"): {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it as "
                    "is, repeat the "
                    "call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back. "
                        "To "
                        "apply "
                        "it "
                        "as "
                        "is, "
                        "repeat "
                        "the "
                        "call "
                        "with "
                        "override_audio_checks=true "
                        "(CLI "
                        "--override-audio-checks).",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            }
        ],
    },
    ("replace-held-six-words", "cli"): {
        "history_steps_added": [0],
        "outcomes": [
            {
                "cli_exit": 1,
                "stderr": "Replacing this range also "
                'removes 6 words from Guest: "one '
                'two three four five six". '
                "Replace anyway to apply it; undo "
                "brings it back.\n"
                "Nothing changed. To apply this "
                "replace as is, repeat the "
                "command with "
                "--override-audio-checks.\n",
            }
        ],
    },
    ("replace-held-six-words", "mcp"): {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it as is, "
                    "repeat the call "
                    "with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "6 "
                        "words "
                        "from "
                        "Guest: "
                        '"one '
                        "two "
                        "three "
                        "four "
                        "five "
                        'six". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back. "
                        "To "
                        "apply "
                        "it "
                        "as "
                        "is, "
                        "repeat "
                        "the "
                        "call "
                        "with "
                        "override_audio_checks=true "
                        "(CLI "
                        "--override-audio-checks).",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "one", "timeline_end": 2.3, "timeline_start": 2.1},
                                        {"text": "two", "timeline_end": 2.6, "timeline_start": 2.4},
                                        {
                                            "text": "three",
                                            "timeline_end": 2.9,
                                            "timeline_start": 2.7,
                                        },
                                        {
                                            "text": "four",
                                            "timeline_end": 3.2,
                                            "timeline_start": 3.0,
                                        },
                                        {
                                            "text": "five",
                                            "timeline_end": 3.5,
                                            "timeline_start": 3.3,
                                        },
                                        {"text": "six", "timeline_end": 3.8, "timeline_start": 3.6},
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            }
        ],
    },
    ("replace-held-then-held-again", "cli"): {
        "history_steps_added": [0, 0],
        "outcomes": [
            {
                "cli_exit": 1,
                "stderr": "Replacing this range also "
                "removes 2 words from "
                'Guest: "so plan". Replace '
                "anyway to apply it; undo "
                "brings it back.\n"
                "Nothing changed. To apply "
                "this replace as is, repeat "
                "the command with "
                "--override-audio-checks.\n",
            },
            {
                "cli_exit": 1,
                "stderr": "Replacing this range also "
                "removes 2 words from "
                'Guest: "so plan". Replace '
                "anyway to apply it; undo "
                "brings it back.\n"
                "Nothing changed. To apply "
                "this replace as is, repeat "
                "the command with "
                "--override-audio-checks.\n",
            },
        ],
    },
    ("replace-held-then-held-again", "mcp"): {
        "history_steps_added": [0, 0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it "
                    "as is, repeat "
                    "the call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back. "
                        "To "
                        "apply "
                        "it "
                        "as "
                        "is, "
                        "repeat "
                        "the "
                        "call "
                        "with "
                        "override_audio_checks=true "
                        "(CLI "
                        "--override-audio-checks).",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            },
            {
                "ok": {
                    "apply_anyway": "To apply it "
                    "as is, repeat "
                    "the call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back. "
                        "To "
                        "apply "
                        "it "
                        "as "
                        "is, "
                        "repeat "
                        "the "
                        "call "
                        "with "
                        "override_audio_checks=true "
                        "(CLI "
                        "--override-audio-checks).",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            },
        ],
    },
    ("replace-held-then-overridden", "cli"): {
        "history_steps_added": [0, 1],
        "outcomes": [
            {
                "cli_exit": 1,
                "stderr": "Replacing this range also "
                "removes 2 words from "
                'Guest: "so plan". Replace '
                "anyway to apply it; undo "
                "brings it back.\n"
                "Nothing changed. To apply "
                "this replace as is, repeat "
                "the command with "
                "--override-audio-checks.\n",
            },
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            },
        ],
    },
    ("replace-held-then-overridden", "mcp"): {
        "history_steps_added": [0, 1],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply it "
                    "as is, repeat "
                    "the call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back. "
                        "To "
                        "apply "
                        "it "
                        "as "
                        "is, "
                        "repeat "
                        "the "
                        "call "
                        "with "
                        "override_audio_checks=true "
                        "(CLI "
                        "--override-audio-checks).",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            },
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            },
        ],
    },
    ("replace-held-with-explicit-take", "cli"): {
        "history_steps_added": [0],
        "outcomes": [
            {
                "cli_exit": 1,
                "stderr": "Replacing this range "
                "also removes 2 words "
                'from Guest: "so plan". '
                "Replace anyway to apply "
                "it; undo brings it "
                "back.\n"
                "Nothing changed. To "
                "apply this replace as "
                "is, repeat the command "
                "with "
                "--override-audio-checks.\n",
            }
        ],
    },
    ("replace-held-with-explicit-take", "mcp"): {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "apply_anyway": "To apply "
                    "it as is, "
                    "repeat the "
                    "call with "
                    "override_audio_checks=true "
                    "(CLI "
                    "--override-audio-checks).",
                    "needs_confirmation": {
                        "message": "Replacing "
                        "this "
                        "range "
                        "also "
                        "removes "
                        "2 "
                        "words "
                        "from "
                        "Guest: "
                        '"so '
                        'plan". '
                        "Replace "
                        "anyway "
                        "to "
                        "apply "
                        "it; "
                        "undo "
                        "brings "
                        "it "
                        "back. "
                        "To "
                        "apply "
                        "it "
                        "as "
                        "is, "
                        "repeat "
                        "the "
                        "call "
                        "with "
                        "override_audio_checks=true "
                        "(CLI "
                        "--override-audio-checks).",
                        "reason": "cuts_other_speech",
                        "speech": {
                            "spans": [{"end": 4.0, "start": 2.0}],
                            "tracks": [
                                {
                                    "sound_spans": [],
                                    "speaker": "Guest",
                                    "track_id": "guest",
                                    "words": [
                                        {"text": "so", "timeline_end": 2.8, "timeline_start": 2.5},
                                        {
                                            "text": "plan",
                                            "timeline_end": 3.4,
                                            "timeline_start": 3.0,
                                        },
                                    ],
                                }
                            ],
                        },
                        "status": "needs_confirmation",
                    },
                    "operation": "accept_session_suggestion",
                    "unchanged": True,
                }
            }
        ],
    },
    ("replace-overridden-at-once", "host"): {
        "history_steps_added": [2],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    ("replace-overridden-at-once", "web"): {
        "history_steps_added": [2],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": "The other take (0) was discarded. Undo brings it back.",
                    "discarded_takes": [0],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 1,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 1,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    ("replace-own-track-speech-never-asks", "host"): {
        "history_steps_added": [2],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": None,
                    "discarded_takes": [],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
    ("replace-own-track-speech-never-asks", "web"): {
        "history_steps_added": [2],
        "outcomes": [
            {
                "ok": {
                    "at_sec": 2.0,
                    "clamped_comment_ids": [],
                    "clips": [
                        {
                            "clip_id": "<clip:0>",
                            "duration_s": 3.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                            "take_index": 0,
                            "timeline_start": 2.0,
                            "track_id": "host",
                        }
                    ],
                    "comments": [],
                    "comments_not_placed": 0,
                    "delta_s": 1.0,
                    "discard_message": None,
                    "discarded_takes": [],
                    "from_sec": 2.0,
                    "removed_s": 2.0,
                    "retired_decision_ids": [],
                    "room_tone_not_placed": 0,
                    "span_s": 3.0,
                    "suggestion": {
                        "anchor": {
                            "at_sec": 2.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 2.0,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 4.0,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 4.0,
                            "track_id": "host",
                        },
                        "from_sec": 2.0,
                        "id": "ss-aaaaaaaaaaaa",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 3.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 4.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    "take_index": 0,
                    "to_sec": 4.0,
                    "unmoved_track_ids": [],
                }
            }
        ],
    },
}

_SURFACES = [(name, surface) for name, case in SCENARIOS.items() for surface in case.surfaces]


@pytest.mark.parametrize(("name", "surface"), _SURFACES)
def test_accept_wire(ws, name, surface):
    expected = OVERRIDES.get((name, surface), EXPECTED[name])
    assert dump(run(ws, SCENARIOS[name], surface)) == dump(expected)
