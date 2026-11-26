"""Pin the exact wire output of SessionSuggestionService.takes on every surface that reads it."""

from __future__ import annotations

from typing import Any

import pytest

from podcast_mcp.models import StagedRoomTone, StagedTake, Transcript, TranscriptWord
from session_suggestion_wire_helpers import (
    READ_SURFACES,
    THREE_TAKES,
    Scenario,
    Step,
    add_music_track,
    call,
    dump,
    run,
    say,
    stage_insert,
    stage_replace,
    stage_unanchored_replace,
)

pytest_plugins = ["test_record_session_preview"]
pytestmark = pytest.mark.unscoped_ok

TAKES = Step("takes")
SECOND = "ss-" + "b" * 12


def _scenario(build, *steps: Step) -> Scenario:
    return Scenario(build, steps or (TAKES,), READ_SURFACES)


def _three(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, THREE_TAKES)


def _single(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})


def _said_second(ws) -> str:
    sid = _three(ws)
    say(ws, 1, "so", "this", "is", "the", "second", "try")
    return sid


def _said_all(ws) -> str:
    sid = _three(ws)
    say(ws, 0, "one")
    say(ws, 1, "two", "words")
    say(ws, 2)
    return sid


def _long_words(ws) -> str:
    sid = _three(ws)
    say(ws, 0, *[f"w{i}" for i in range(30)])
    return sid


def _long_chars(ws) -> str:
    sid = _three(ws)
    say(ws, 0, *[f"extraordinarily{i}" for i in range(14)])
    return sid


def _suppressed(ws) -> str:
    sid = _three(ws)
    say(ws, 0, "keep", "drop", "keep")
    ws.mutate(
        "suppress",
        "suppressed",
        lambda p: setattr(p.transcripts[-1].words[1], "suppressed", True),
    )
    return sid


def _padded_words(ws) -> str:
    sid = _three(ws)
    say(ws, 0, "  spaced  ", "out ")
    return sid


def _other_track_words(ws) -> str:
    sid = _three(ws)

    def add(project) -> None:
        source = next(t.source_id for t in project.editorial.session_suggestions[0].takes)
        project.transcripts.append(
            Transcript(
                track_id="guest",
                source_id=source,
                words=[TranscriptWord(text="elsewhere", start=0.0, end=0.5)],
            )
        )

    ws.mutate("words", "worded", add)
    return sid


def _two_tracks(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 2.0), ("guest", 0.5, 2.0)]},
        track_ids=["host", "guest"],
    )


def _two_tracks_three_takes(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {
            0: [("host", 0.0, 1.0)],
            1: [("host", 0.0, 2.0), ("guest", 0.0, 2.0)],
            2: [("host", 0.0, 3.0), ("guest", 1.0, 1.0)],
        },
        track_ids=["host", "guest"],
    )


def _segments(ws) -> str:
    return stage_replace(
        ws, 3.0, 5.0, {0: [("host", 0.0, 1.0), ("host", 1.5, 0.5), ("host", 3.0, 1.0)]}
    )


def _sparse(ws) -> str:
    return stage_replace(
        ws, 3.0, 5.0, {0: [("host", 0.0, 1.0)], 3: [("host", 0.0, 2.0)], 5: [("host", 0.0, 3.0)]}
    )


def _picked(index: int):
    def build(ws) -> str:
        sid = _three(ws)
        ws.mutate(
            "pick",
            "picked",
            lambda p: setattr(p.editorial.session_suggestions[0], "selected_take", index),
        )
        return sid

    return build


def _dangling(ws) -> str:
    sid = stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)]})
    ws.mutate(
        "dangle",
        "dangled",
        lambda p: setattr(p.editorial.session_suggestions[0], "selected_take", 4),
    )
    return sid


def _insert(ws) -> str:
    return stage_insert(ws, 4.0, [1.0, 1.5])


def _insert_bed(ws) -> str:
    return stage_insert(ws, 4.0, [1.0, 1.5], bed=2.0)


def _insert_said(ws) -> str:
    sid = _insert(ws)
    say(ws, 0, "hello", "again")
    return sid


def _insert_picked(ws) -> str:
    sid = _insert(ws)
    ws.mutate(
        "pick", "picked", lambda p: setattr(p.editorial.session_suggestions[0], "selected_take", 0)
    )
    return sid


def _not_recorded(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 2.0)], 1: [("host", 0.0, 2.0), ("guest", 0.0, 2.0)]},
        track_ids=["host", "guest"],
    )


def _music(ws) -> str:
    add_music_track(ws)
    return stage_replace(
        ws, 3.0, 5.0, {0: [("music", 0.0, 1.0)], 1: [("music", 0.0, 2.0)]}, track_ids=["music"]
    )


def _source_gone(ws) -> str:
    sid = _three(ws)
    ws.mutate(
        "drop",
        "dropped",
        lambda p: setattr(
            p, "sources", [s for s in p.sources if not s.id.startswith("rec-aaaaaaaaaaaa-1")]
        ),
    )
    return sid


def _zero_length(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 0.0)], 1: [("host", 0.0, 2.0)]})


def _empty(ws) -> str:
    sid = _three(ws)
    ws.mutate(
        "empty", "emptied", lambda p: setattr(p.editorial.session_suggestions[0], "takes", [])
    )
    return sid


def _pending_edit(ws) -> str:
    from podcast_mcp.models import EditDecision, EditDecisionType

    ws.mutate(
        "decision",
        "decided",
        lambda p: p.editorial.edit_decisions.append(
            EditDecision(
                id="inside",
                track_id="host",
                type=EditDecisionType.MUTE,
                start=3.5,
                end=4.0,
                timebase="timeline",
                applied=False,
            )
        ),
    )
    return _three(ws)


def _commented(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)]},
        comments={0: [("a", 100)], 1: [("b", 50)]},
    )


def _two_sessions(ws) -> str:
    _three(ws)
    stage_replace(
        ws,
        6.0,
        8.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)]},
        session_id="b" * 12,
        number=2,
    )
    return SECOND


def _with_room_tone(ws) -> str:
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


def _extra_segment(ws) -> str:
    sid = _three(ws)

    def add(project) -> None:
        row = project.editorial.session_suggestions[0]
        row.takes.append(
            StagedTake(
                take_index=1,
                track_id="host",
                track_label="Host",
                segment_index=1,
                source_id="rec-aaaaaaaaaaaa-1-host-0",
                offset_s=2.5,
                duration_s=1.0,
            )
        )

    ws.mutate("segment", "segmented", add)
    return sid


def _after(build, *ops: str):
    def prepared(ws) -> str:
        sid = build(ws)
        for op in ops:
            take = None if ":" not in op else int(op.split(":")[1])
            call("service", ws, Step(op.split(":")[0], take=take), sid)
        return sid

    return prepared


SCENARIOS: dict[str, Scenario] = {
    "three-fresh": _scenario(_three),
    "three-twice": _scenario(_three, TAKES, TAKES),
    "single-take": _scenario(_single),
    "with-words-on-the-second": _scenario(_said_second),
    "with-words-on-every-take": _scenario(_said_all),
    "long-snippet-clipped-at-words": _scenario(_long_words),
    "long-snippet-clipped-at-characters": _scenario(_long_chars),
    "suppressed-word-not-counted": _scenario(_suppressed),
    "words-are-trimmed": _scenario(_padded_words),
    "words-of-another-track-not-counted": _scenario(_other_track_words),
    "one-take-on-two-tracks": _scenario(_two_tracks),
    "two-tracks-three-takes": _scenario(_two_tracks_three_takes),
    "several-segments-one-track": _scenario(_segments),
    "sparse-take-numbers": _scenario(_sparse),
    "picked-first": _scenario(_picked(0)),
    "picked-middle": _scenario(_picked(1)),
    "picked-last": _scenario(_picked(2)),
    "dangling-pick-not-reported": _scenario(_dangling),
    "pick-through-select": _scenario(
        _three, Step("select", take=1), TAKES, Step("select", take=0), TAKES
    ),
    "insert-has-nothing-to-pick": _scenario(_insert),
    "insert-with-bed": _scenario(_insert_bed),
    "insert-with-words": _scenario(_insert_said),
    "insert-with-a-stray-pick": _scenario(_insert_picked),
    "take-not-recorded-refusal": _scenario(_not_recorded),
    "non-dialogue-track-refusal": _scenario(_music),
    "source-gone-refusal": _scenario(_source_gone),
    "zero-length-take-refusal": _scenario(_zero_length),
    "no-takes": _scenario(_empty),
    "pending-edit-in-range-still-acceptable": _scenario(_pending_edit),
    "unanchored-range-still-acceptable": _scenario(
        lambda ws: stage_unanchored_replace(ws, 3.0, 5.0, THREE_TAKES)
    ),
    "staged-comments-are-not-listed": _scenario(_commented),
    "room-tone-is-not-listed": _scenario(_with_room_tone),
    "second-session": _scenario(_two_sessions, Step("takes", sid=SECOND)),
    "two-segments-in-one-take": _scenario(_extra_segment),
    "unknown-id": _scenario(_three, Step("takes", sid="ss-nope")),
    "empty-id": _scenario(_three, Step("takes", sid="")),
    "skipped-replace": _scenario(_after(_three, "skip")),
    "skipped-after-pick": _scenario(_after(_three, "select:0", "skip")),
    "skipped-insert": _scenario(_after(_insert, "skip")),
    "accepted-replace": _scenario(_after(_three, "accept")),
    "accepted-single-take": _scenario(_after(_single, "accept")),
    "accepted-insert": _scenario(_after(_insert, "accept")),
    "accepted-after-pick": _scenario(_after(_three, "select:0", "accept")),
    "after-accepting-a-replace-with-words": _scenario(_after(_said_second, "accept")),
}

EXPECTED: dict[str, Any] = {
    "accepted-after-pick": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 0,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": 0,
                    "status": "accepted",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": True,
                            "default": True,
                            "duration_s": 1.0,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already "
                                "accepted, so "
                                "it cannot be "
                                "changed "
                                "again. Undo "
                                "that step "
                                "first if you "
                                "want it back, "
                                "or record a "
                                "new session.",
                            },
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
                        }
                    ],
                }
            }
        ],
    },
    "accepted-insert": {
        "history_steps_added": [0],
        "outcomes": [
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
                                "already accepted, "
                                "so it cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you want "
                                "it back, or "
                                "record a new "
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
            }
        ],
    },
    "accepted-replace": {
        "history_steps_added": [0],
        "outcomes": [
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
                                "accepted, so it "
                                "cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you "
                                "want it back, or "
                                "record a new "
                                "session.",
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
            }
        ],
    },
    "accepted-single-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 0,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": 0,
                    "status": "accepted",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": True,
                            "default": True,
                            "duration_s": 2.0,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 "
                                "was already "
                                "accepted, so "
                                "it cannot be "
                                "changed "
                                "again. Undo "
                                "that step "
                                "first if you "
                                "want it "
                                "back, or "
                                "record a new "
                                "session.",
                            },
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        }
                    ],
                }
            }
        ],
    },
    "after-accepting-a-replace-with-words": {
        "history_steps_added": [0],
        "outcomes": [
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
                                "message": "Session "
                                "1 "
                                "was "
                                "already "
                                "accepted, "
                                "so "
                                "it "
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
                                "a "
                                "new "
                                "session.",
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
            }
        ],
    },
    "dangling-pick-not-reported": {
        "history_steps_added": [0],
        "outcomes": [
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
                            "duration_s": 2.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                    ],
                }
            }
        ],
    },
    "empty-id": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_not_found",
                    "message": "unknown session suggestion: . List the "
                    "staged sessions to see their ids.",
                }
            }
        ],
    },
    "insert-has-nothing-to-pick": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": None,
                    "kind": "insert",
                    "selectable": False,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
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
            }
        ],
    },
    "insert-with-a-stray-pick": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": None,
                    "kind": "insert",
                    "selectable": False,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
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
            }
        ],
    },
    "insert-with-bed": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": None,
                    "kind": "insert",
                    "selectable": False,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
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
            }
        ],
    },
    "insert-with-words": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": None,
                    "kind": "insert",
                    "selectable": False,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": "hello again",
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
                                    "segments": 2,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": 2,
                        }
                    ],
                }
            }
        ],
    },
    "long-snippet-clipped-at-characters": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "speech_text": "extraordinarily0 "
                            "extraordinarily1 "
                            "extraordinarily2 "
                            "extraordinarily3 "
                            "extraordinarily4 "
                            "extraordinarily5 "
                            "extraordinarily6 "
                            "e…",
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": 14,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "long-snippet-clipped-at-words": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "speech_text": "w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13…",
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": 30,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "no-takes": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": None,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [],
                }
            }
        ],
    },
    "non-dialogue-track-refusal": {
        "history_steps_added": [0],
        "outcomes": [
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
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 1.0,
                            "refusal": {
                                "code": "track_not_dialogue",
                                "message": "track "
                                "music "
                                "is a "
                                "music "
                                "track, "
                                "so "
                                "Session "
                                "1 "
                                "cannot "
                                "be "
                                "placed "
                                "on it. "
                                "Rename "
                                "or "
                                "remove "
                                "that "
                                "track, "
                                "then "
                                "try "
                                "again.",
                            },
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "music",
                                    "track_label": "Music",
                                }
                            ],
                            "word_count": None,
                        },
                        {
                            "acceptable": False,
                            "chosen": False,
                            "default": True,
                            "duration_s": 2.0,
                            "refusal": {
                                "code": "track_not_dialogue",
                                "message": "track "
                                "music "
                                "is a "
                                "music "
                                "track, "
                                "so "
                                "Session "
                                "1 "
                                "cannot "
                                "be "
                                "placed "
                                "on it. "
                                "Rename "
                                "or "
                                "remove "
                                "that "
                                "track, "
                                "then "
                                "try "
                                "again.",
                            },
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "music",
                                    "track_label": "Music",
                                }
                            ],
                            "word_count": None,
                        },
                    ],
                }
            }
        ],
    },
    "one-take-on-two-tracks": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 0,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": True,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
                                    "segments": 1,
                                    "track_id": "guest",
                                    "track_label": "Guest",
                                },
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                },
                            ],
                            "word_count": None,
                        }
                    ],
                }
            }
        ],
    },
    "pending-edit-in-range-still-acceptable": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "pick-through-select": {
        "history_steps_added": [1, 1, 2, 2],
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
                    "default_take": 1,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": 1,
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
                            "chosen": True,
                            "default": True,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "default": False,
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            },
            {
                "ok": {
                    "selected_take": 0,
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
                    "default_take": 0,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": 0,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": True,
                            "default": True,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "default": False,
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            },
        ],
    },
    "picked-first": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 0,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": 0,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": True,
                            "default": True,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "default": False,
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "picked-last": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                        {
                            "acceptable": True,
                            "chosen": True,
                            "default": True,
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "picked-middle": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 1,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": 1,
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
                            "chosen": True,
                            "default": True,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "default": False,
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "room-tone-is-not-listed": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "second-session": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 1,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-bbbbbbbbbbbb",
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
                            "duration_s": 2.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                    ],
                }
            }
        ],
    },
    "several-segments-one-track": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 0,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": True,
                            "duration_s": 4.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 4.0,
                                    "segments": 3,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        }
                    ],
                }
            }
        ],
    },
    "single-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 0,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": True,
                            "duration_s": 2.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        }
                    ],
                }
            }
        ],
    },
    "skipped-after-pick": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 0,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": 0,
                    "status": "skipped",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": True,
                            "default": True,
                            "duration_s": 1.0,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already "
                                "skipped, so it "
                                "cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you "
                                "want it back, "
                                "or record a "
                                "new session.",
                            },
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
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already "
                                "skipped, so it "
                                "cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you "
                                "want it back, "
                                "or record a "
                                "new session.",
                            },
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                        {
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 3.5,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already "
                                "skipped, so it "
                                "cannot be "
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
                        },
                    ],
                }
            }
        ],
    },
    "skipped-insert": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": None,
                    "kind": "insert",
                    "selectable": False,
                    "selected_take": None,
                    "status": "skipped",
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
                                "already skipped, "
                                "so it cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you want "
                                "it back, or record "
                                "a new session.",
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
            }
        ],
    },
    "skipped-replace": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
                    "kind": "replace",
                    "selectable": False,
                    "selected_take": None,
                    "status": "skipped",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 1.0,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already skipped, "
                                "so it cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you want "
                                "it back, or "
                                "record a new "
                                "session.",
                            },
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
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already skipped, "
                                "so it cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you want "
                                "it back, or "
                                "record a new "
                                "session.",
                            },
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                        {
                            "acceptable": False,
                            "chosen": False,
                            "default": True,
                            "duration_s": 3.5,
                            "refusal": {
                                "code": "session_suggestion_not_pending",
                                "message": "Session 1 was "
                                "already skipped, "
                                "so it cannot be "
                                "changed again. "
                                "Undo that step "
                                "first if you want "
                                "it back, or "
                                "record a new "
                                "session.",
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
                        },
                    ],
                }
            }
        ],
    },
    "source-gone-refusal": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": {
                                "code": "staged_source_missing",
                                "message": "The recording "
                                "for take 1 is "
                                "no longer in "
                                "the project. "
                                "Record the "
                                "session "
                                "again.",
                            },
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "sparse-take-numbers": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 5,
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
                            "default": False,
                            "duration_s": 2.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 3,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
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
                            "take_index": 5,
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
            }
        ],
    },
    "staged-comments-are-not-listed": {
        "history_steps_added": [0],
        "outcomes": [
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
                            "duration_s": 2.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                    ],
                }
            }
        ],
    },
    "suppressed-word-not-counted": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "speech_text": "keep keep",
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": 2,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "take-not-recorded-refusal": {
        "history_steps_added": [0],
        "outcomes": [
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
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.0,
                            "refusal": {
                                "code": "track_not_recorded",
                                "message": "Take 0 "
                                "did not "
                                "record "
                                '"Guest", '
                                "which "
                                "this "
                                "pickup "
                                "was set "
                                "to "
                                "replace. "
                                "Pick a "
                                "take "
                                "that "
                                "recorded "
                                "every "
                                "track, "
                                "or "
                                "record "
                                "the "
                                "session "
                                "again.",
                            },
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
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
                            "duration_s": 2.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "guest",
                                    "track_label": "Guest",
                                },
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                },
                            ],
                            "word_count": None,
                        },
                    ],
                }
            }
        ],
    },
    "three-fresh": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "three-twice": {
        "history_steps_added": [0, 0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            },
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            },
        ],
    },
    "two-segments-in-one-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 3.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 3.5,
                                    "segments": 2,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "two-tracks-three-takes": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": None,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 1.0,
                            "refusal": {
                                "code": "track_not_recorded",
                                "message": "Take 0 did "
                                "not record "
                                '"Guest", '
                                "which this "
                                "pickup was "
                                "set to "
                                "replace. "
                                "Pick a "
                                "take that "
                                "recorded "
                                "every "
                                "track, or "
                                "record the "
                                "session "
                                "again.",
                            },
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
                            "default": False,
                            "duration_s": 2.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "guest",
                                    "track_label": "Guest",
                                },
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                },
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
                            "take_index": 2,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "guest",
                                    "track_label": "Guest",
                                },
                                {
                                    "duration_s": 3.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                },
                            ],
                            "word_count": None,
                        },
                    ],
                }
            }
        ],
    },
    "unanchored-range-still-acceptable": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "unknown-id": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_not_found",
                    "message": "unknown session suggestion: ss-nope. List "
                    "the staged sessions to see their ids.",
                }
            }
        ],
    },
    "with-words-on-every-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "speech_text": "one",
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": 1,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": "two words",
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": 2,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": True,
                            "duration_s": 3.5,
                            "refusal": None,
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
                            "word_count": 0,
                        },
                    ],
                }
            }
        ],
    },
    "with-words-on-the-second": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": "so this is the second try",
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": 6,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": True,
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "words-are-trimmed": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "speech_text": "spaced out",
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 1.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": 2,
                        },
                        {
                            "acceptable": True,
                            "chosen": False,
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "words-of-another-track-not-counted": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": {
                    "default_take": 2,
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
                            "default": False,
                            "duration_s": 2.5,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.5,
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
                            "duration_s": 3.5,
                            "refusal": None,
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
                        },
                    ],
                }
            }
        ],
    },
    "zero-length-take-refusal": {
        "history_steps_added": [0],
        "outcomes": [
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
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 0.0,
                            "refusal": {
                                "code": "session_suggestion_empty",
                                "message": "Take 0 "
                                "of "
                                "Session "
                                "1 has no "
                                "recorded "
                                "audio. "
                                "Pick "
                                "another "
                                "take, or "
                                "record "
                                "it "
                                "again.",
                            },
                            "speech_text": None,
                            "take_index": 0,
                            "tracks": [
                                {
                                    "duration_s": 0.0,
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
                            "duration_s": 2.0,
                            "refusal": None,
                            "speech_text": None,
                            "take_index": 1,
                            "tracks": [
                                {
                                    "duration_s": 2.0,
                                    "segments": 1,
                                    "track_id": "host",
                                    "track_label": "Host",
                                }
                            ],
                            "word_count": None,
                        },
                    ],
                }
            }
        ],
    },
}

OVERRIDES: dict[tuple[str, str], Any] = {}

_SURFACES = [(name, surface) for name, case in SCENARIOS.items() for surface in case.surfaces]


@pytest.mark.parametrize(("name", "surface"), _SURFACES)
def test_takes_wire(ws, name, surface):
    expected = OVERRIDES.get((name, surface), EXPECTED[name])
    assert dump(run(ws, SCENARIOS[name], surface)) == dump(expected)
