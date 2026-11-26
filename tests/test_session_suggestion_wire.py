"""Pin the exact wire output of SessionSuggestionService skip, select_take and list on every surface."""

from __future__ import annotations

from typing import Any

import pytest

from session_suggestion_wire_helpers import (
    ALL_SURFACES,
    READ_SURFACES,
    THREE_TAKES,
    Scenario,
    Step,
    add_music_track,
    call,
    dump,
    guest_speech,
    history_steps,
    raw,
    run,
    shape,
    stage_insert,
    stage_replace,
    stage_unanchored_replace,
)

pytest_plugins = ["test_record_session_preview"]
pytestmark = pytest.mark.unscoped_ok

SKIP = Step("skip")
UNKNOWN = "ss-nope"
SECOND = "ss-" + "b" * 12


def _three(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, THREE_TAKES)


def _single(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})


def _insert(ws) -> str:
    return stage_insert(ws, 4.0, [1.0, 1.5])


def _insert_bed(ws) -> str:
    return stage_insert(ws, 4.0, [1.0, 1.5], bed=2.0)


def _commented(ws) -> str:
    return stage_replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)]},
        comments={0: [("a", 100), ("b", 250)], 1: [("c", 50)]},
    )


def _two_sessions(ws) -> str:
    first = _three(ws)
    stage_replace(
        ws,
        6.0,
        8.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)]},
        session_id="b" * 12,
        number=2,
    )
    return first


def _unanchored(ws) -> str:
    return stage_unanchored_replace(ws, 3.0, 5.0, THREE_TAKES)


def _drop_host_clips(ws) -> None:
    ws.mutate(
        "gone",
        "gone",
        lambda p: setattr(p, "clips", [c for c in p.clips if c.track_id != "host"]),
    )


def _drop_sources(ws) -> None:
    ws.mutate(
        "drop",
        "dropped",
        lambda p: setattr(p, "sources", [s for s in p.sources if not s.id.startswith("rec-")]),
    )


def _range_gone(ws) -> str:
    sid = _three(ws)
    _drop_host_clips(ws)
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
    return stage_replace(ws, 3.0, 5.0, {0: [("music", 0.0, 1.0)]}, track_ids=["music"])


def _source_gone(ws) -> str:
    sid = _three(ws)
    _drop_sources(ws)
    return sid


def _empty(ws) -> str:
    sid = _three(ws)
    ws.mutate(
        "empty", "emptied", lambda p: setattr(p.editorial.session_suggestions[0], "takes", [])
    )
    return sid


def _zero_length(ws) -> str:
    return stage_replace(ws, 3.0, 5.0, {0: [("host", 0.0, 0.0)], 1: [("host", 0.0, 2.0)]})


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


def _mixed(ws) -> str:
    first = _three(ws)
    stage_replace(
        ws,
        6.0,
        8.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)]},
        session_id="b" * 12,
        number=2,
    )
    stage_replace(ws, 8.5, 9.5, {0: [("host", 0.0, 1.0)]}, session_id="c" * 12, number=3)
    call("service", ws, Step("skip"), SECOND)
    call("service", ws, Step("accept"), "ss-" + "c" * 12)
    return first


def _held(ws) -> str:
    guest_speech(ws)
    return stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 3.0)]})


def _gated():
    from unittest.mock import patch

    from podcast_mcp.edits.transcript_refine_status import (
        REFINE_GATE,
        TranscriptRefineRequiredError,
    )

    return patch.object(
        REFINE_GATE, "assert_clear", side_effect=TranscriptRefineRequiredError("refine first")
    )


def _none_staged(ws) -> str:
    return "ss-none"


LIST = ("service", "mcp", "cli")


SCENARIOS: dict[str, Scenario] = {
    "skip-replace": Scenario(_three, (SKIP,)),
    "skip-single-take-replace": Scenario(_single, (SKIP,)),
    "skip-insert": Scenario(_insert, (SKIP,)),
    "skip-insert-with-bed": Scenario(_insert_bed, (SKIP,)),
    "skip-with-staged-comments": Scenario(_commented, (SKIP,)),
    "skip-unanchored-replace": Scenario(_unanchored, (SKIP,)),
    "skip-second-of-two-sessions": Scenario(_two_sessions, (Step("skip", sid=SECOND),)),
    "skip-first-of-two-sessions": Scenario(_two_sessions, (SKIP,)),
    "skip-twice": Scenario(_three, (SKIP, SKIP)),
    "skip-unknown-id": Scenario(_three, (Step("skip", sid=UNKNOWN),)),
    "skip-empty-id": Scenario(_three, (Step("skip", sid=""),)),
    "skip-after-accept": Scenario(_single, (Step("accept"), SKIP)),
    "skip-then-select": Scenario(_three, (SKIP, Step("select", take=1))),
    "skip-then-accept": Scenario(_three, (SKIP, Step("accept"))),
    "skip-selected-take-kept": Scenario(_three, (Step("select", take=0), SKIP)),
    "skip-with-a-pending-edit-in-range": Scenario(_pending_edit, (SKIP,)),
    "skip-range-gone": Scenario(_range_gone, (SKIP,)),
    "skip-source-gone": Scenario(_source_gone, (SKIP,)),
    "skip-no-takes": Scenario(_empty, (SKIP,)),
    "select-take-0": Scenario(_three, (Step("select", take=0),)),
    "select-take-1": Scenario(_three, (Step("select", take=1),)),
    "select-take-2": Scenario(_three, (Step("select", take=2),)),
    "select-single-take": Scenario(_single, (Step("select", take=0),)),
    "select-same-take-twice": Scenario(_three, (Step("select", take=1), Step("select", take=1))),
    "select-another-take": Scenario(_three, (Step("select", take=1), Step("select", take=2))),
    "select-back-and-forth": Scenario(
        _three, (Step("select", take=0), Step("select", take=2), Step("select", take=0))
    ),
    "select-unknown-take": Scenario(_three, (Step("select", take=9),)),
    "select-negative-take": Scenario(_three, (Step("select", take=-1),)),
    "select-after-valid-pick-unknown-take": Scenario(
        _three, (Step("select", take=1), Step("select", take=7), Step("takes"))
    ),
    "select-on-insert": Scenario(_insert, (Step("select", take=0),)),
    "select-not-recorded-take": Scenario(_not_recorded, (Step("select", take=0),)),
    "select-recorded-take-of-a-two-track-replace": Scenario(
        _not_recorded, (Step("select", take=1),)
    ),
    "select-unanchored": Scenario(_unanchored, (Step("select", take=1),)),
    "select-range-gone": Scenario(_range_gone, (Step("select", take=1),)),
    "select-same-take-range-gone-after": Scenario(
        _three, (Step("select", take=1), Step("do", fn=_drop_host_clips), Step("select", take=1))
    ),
    "select-then-source-gone": Scenario(
        _three, (Step("select", take=1), Step("do", fn=_drop_sources), Step("takes"))
    ),
    "select-unknown-id": Scenario(_three, (Step("select", take=1, sid=UNKNOWN),)),
    "select-after-skip": Scenario(_three, (SKIP, Step("select", take=1))),
    "select-after-accept": Scenario(_three, (Step("accept"), Step("select", take=1))),
    "select-same-take-after-skip": Scenario(
        _three, (Step("select", take=1), SKIP, Step("select", take=1))
    ),
    "select-non-dialogue-track": Scenario(_music, (Step("select", take=0),)),
    "select-source-gone": Scenario(_source_gone, (Step("select", take=1),)),
    "select-no-takes": Scenario(_empty, (Step("select", take=0),)),
    "select-zero-length-take": Scenario(_zero_length, (Step("select", take=0),)),
    "select-with-a-pending-edit-in-range": Scenario(_pending_edit, (Step("select", take=1),)),
    "select-in-second-session": Scenario(
        _two_sessions, (Step("select", take=1, sid=SECOND), Step("takes", sid=SECOND))
    ),
    "select-then-takes": Scenario(_three, (Step("select", take=0), Step("takes"))),
    "select-then-accept-picked": Scenario(_three, (Step("select", take=0), Step("accept"))),
    "list-nothing-staged": Scenario(_none_staged, (Step("list"),), LIST),
    "list-one-pending-replace": Scenario(_three, (Step("list"),), LIST),
    "list-one-pending-insert": Scenario(_insert, (Step("list"),), LIST),
    "list-insert-with-bed": Scenario(_insert_bed, (Step("list"),), LIST),
    "list-with-staged-comments": Scenario(_commented, (Step("list"),), LIST),
    "list-after-a-pick": Scenario(_three, (Step("select", take=2), Step("list")), LIST),
    "list-after-skip": Scenario(_three, (SKIP, Step("list")), LIST),
    "list-mixed-statuses": Scenario(_mixed, (Step("list"),), LIST),
    "list-mixed-pending": Scenario(_mixed, (Step("list", status="pending"),), LIST),
    "list-mixed-skipped": Scenario(_mixed, (Step("list", status="skipped"),), LIST),
    "list-mixed-accepted": Scenario(_mixed, (Step("list", status="accepted"),), LIST),
    "list-mixed-unknown-status": Scenario(_mixed, (Step("list", status="bogus"),), LIST),
    "list-mixed-empty-status": Scenario(_mixed, (Step("list", status=""),), LIST),
    "list-pending-when-none-pending": Scenario(
        _single, (Step("accept"), Step("list", status="pending")), LIST
    ),
}

EXPECTED: dict[str, Any] = {
    "list-after-a-pick": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "selected_take": 2,
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
                        "selected_take": 2,
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
                    }
                ]
            },
        ],
    },
    "list-after-skip": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "skipped",
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
                    }
                ]
            },
        ],
    },
    "list-insert-with-bed": {
        "history_steps_added": [0],
        "outcomes": [
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
            }
        ],
    },
    "list-mixed-accepted": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": [
                    {
                        "anchor": {
                            "at_sec": 8.5,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 8.5,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 9.5,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 9.5,
                            "track_id": "host",
                        },
                        "from_sec": 8.5,
                        "id": "ss-cccccccccccc",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "cccccccccccc",
                        "session_number": 3,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-cccccccccccc-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 9.5,
                        "track_follows": {},
                        "track_ids": ["host"],
                    }
                ]
            }
        ],
    },
    "list-mixed-empty-status": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "invalid_status",
                    "message": "status must be one of pending, skipped, accepted",
                }
            }
        ],
    },
    "list-mixed-pending": {
        "history_steps_added": [0],
        "outcomes": [
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
                        "selected_take": None,
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
                    }
                ]
            }
        ],
    },
    "list-mixed-skipped": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "ok": [
                    {
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
                        "selected_take": None,
                        "session_id": "bbbbbbbbbbbb",
                        "session_number": 2,
                        "status": "skipped",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": 8.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    }
                ]
            }
        ],
    },
    "list-mixed-statuses": {
        "history_steps_added": [0],
        "outcomes": [
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
                        "selected_take": None,
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
                    {
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
                        "selected_take": None,
                        "session_id": "bbbbbbbbbbbb",
                        "session_number": 2,
                        "status": "skipped",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": 8.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    {
                        "anchor": {
                            "at_sec": 8.5,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 8.5,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 9.5,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 9.5,
                            "track_id": "host",
                        },
                        "from_sec": 8.5,
                        "id": "ss-cccccccccccc",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "cccccccccccc",
                        "session_number": 3,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-cccccccccccc-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 9.5,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                ]
            }
        ],
    },
    "list-mixed-unknown-status": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "invalid_status",
                    "message": "status must be one of pending, skipped, accepted",
                }
            }
        ],
    },
    "list-nothing-staged": {"history_steps_added": [0], "outcomes": [{"ok": []}]},
    "list-one-pending-insert": {
        "history_steps_added": [0],
        "outcomes": [
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
            }
        ],
    },
    "list-one-pending-replace": {
        "history_steps_added": [0],
        "outcomes": [
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
                        "selected_take": None,
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
                    }
                ]
            }
        ],
    },
    "list-pending-when-none-pending": {
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
            {"ok": []},
        ],
    },
    "list-with-staged-comments": {
        "history_steps_added": [0],
        "outcomes": [
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
                        "selected_take": None,
                        "session_id": "aaaaaaaaaaaa",
                        "session_number": 1,
                        "status": "pending",
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
                            },
                            {
                                "comments": [
                                    {
                                        "author": "host",
                                        "body": "note 1",
                                        "id": "live-1-0",
                                        "recording_ms": 50,
                                        "timeline_offset_s": 0.0,
                                    }
                                ],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": 5.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    }
                ]
            }
        ],
    },
    "select-after-accept": {
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
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already accepted, "
                    "so it cannot be changed again. "
                    "Undo that step first if you want "
                    "it back, or record a new "
                    "session.",
                }
            },
        ],
    },
    "select-after-skip": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            },
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already skipped, so "
                    "it cannot be changed again. Undo "
                    "that step first if you want it "
                    "back, or record a new session.",
                }
            },
        ],
    },
    "select-after-valid-pick-unknown-take": {
        "history_steps_added": [1, 1, 1],
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
                    "message": "Session 1 has no take 7. Pick one of: 0, 1, 2.",
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
        ],
    },
    "select-another-take": {
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
                    "selected_take": 2,
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
        ],
    },
    "select-back-and-forth": {
        "history_steps_added": [1, 2, 3],
        "outcomes": [
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
                    "selected_take": 2,
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
        ],
    },
    "select-in-second-session": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
                    "selected_take": 1,
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
                        "status": "pending",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": 8.0,
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
                            "chosen": True,
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
            },
        ],
    },
    "select-negative-take": {
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
    "select-no-takes": {
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
    "select-non-dialogue-track": {
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
    "select-not-recorded-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "track_not_recorded",
                    "message": "Take 0 did not record "
                    '"Guest", which this pickup '
                    "was set to replace. Pick a "
                    "take that recorded every "
                    "track, or record the session "
                    "again.",
                }
            }
        ],
    },
    "select-on-insert": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "take_not_applicable",
                    "message": "Session 1 is an insert, whose takes "
                    "play one after another, so a take "
                    "cannot be chosen. Accept it without "
                    "a take.",
                }
            }
        ],
    },
    "select-range-gone": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "stale_anchor",
                    "message": "The audio this session was staged "
                    "at is no longer on the timeline, or "
                    "more than one copy of it is. Record "
                    "the session again at the new "
                    "spot.",
                }
            }
        ],
    },
    "select-recorded-take-of-a-two-track-replace": {
        "history_steps_added": [1],
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
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-aaaaaaaaaaaa-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
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
                }
            }
        ],
    },
    "select-same-take-after-skip": {
        "history_steps_added": [1, 2, 2],
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
                    "status": "skipped",
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
                }
            },
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already "
                    "skipped, so it cannot be "
                    "changed again. Undo that "
                    "step first if you want it "
                    "back, or record a new "
                    "session.",
                }
            },
        ],
    },
    "select-same-take-range-gone-after": {
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
                "error": {
                    "code": "stale_anchor",
                    "message": "The audio this "
                    "session was staged "
                    "at is no longer on "
                    "the timeline, or "
                    "more than one copy "
                    "of it is. Record "
                    "the session again "
                    "at the new "
                    "spot.",
                }
            },
        ],
    },
    "select-same-take-twice": {
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
        ],
    },
    "select-single-take": {
        "history_steps_added": [1],
        "outcomes": [
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
                }
            }
        ],
    },
    "select-source-gone": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "staged_source_missing",
                    "message": "The recording for take 1 is no "
                    "longer in the project. Record the "
                    "session again.",
                }
            }
        ],
    },
    "select-take-0": {
        "history_steps_added": [1],
        "outcomes": [
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
            }
        ],
    },
    "select-take-1": {
        "history_steps_added": [1],
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
            }
        ],
    },
    "select-take-2": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "selected_take": 2,
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
            }
        ],
    },
    "select-then-accept-picked": {
        "history_steps_added": [1, 2],
        "outcomes": [
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
            },
        ],
    },
    "select-then-source-gone": {
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
                    "default_take": 1,
                    "kind": "replace",
                    "selectable": True,
                    "selected_take": 1,
                    "status": "pending",
                    "suggestion_id": "ss-aaaaaaaaaaaa",
                    "takes": [
                        {
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 1.0,
                            "refusal": {
                                "code": "staged_source_missing",
                                "message": "The "
                                "recording "
                                "for take "
                                "0 is no "
                                "longer in "
                                "the "
                                "project. "
                                "Record "
                                "the "
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
                            "acceptable": False,
                            "chosen": True,
                            "default": True,
                            "duration_s": 2.5,
                            "refusal": {
                                "code": "staged_source_missing",
                                "message": "The "
                                "recording "
                                "for take "
                                "1 is no "
                                "longer in "
                                "the "
                                "project. "
                                "Record "
                                "the "
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
                            "acceptable": False,
                            "chosen": False,
                            "default": False,
                            "duration_s": 3.5,
                            "refusal": {
                                "code": "staged_source_missing",
                                "message": "The "
                                "recording "
                                "for take "
                                "2 is no "
                                "longer in "
                                "the "
                                "project. "
                                "Record "
                                "the "
                                "session "
                                "again.",
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
            },
        ],
    },
    "select-then-takes": {
        "history_steps_added": [1, 1],
        "outcomes": [
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
    "select-unanchored": {
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
    "select-unknown-id": {
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
    "select-unknown-take": {
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
    "select-with-a-pending-edit-in-range": {
        "history_steps_added": [1],
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
            }
        ],
    },
    "select-zero-length-take": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_empty",
                    "message": "Take 0 of Session 1 has no "
                    "recorded audio. Pick another "
                    "take, or record it again.",
                }
            }
        ],
    },
    "skip-after-accept": {
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
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already accepted, so "
                    "it cannot be changed again. Undo "
                    "that step first if you want it "
                    "back, or record a new session.",
                }
            },
        ],
    },
    "skip-empty-id": {
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
    "skip-first-of-two-sessions": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            }
        ],
    },
    "skip-insert": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "status": "skipped",
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
            }
        ],
    },
    "skip-insert-with-bed": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "status": "skipped",
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
            }
        ],
    },
    "skip-no-takes": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
                    "takes": [],
                    "to_sec": 5.0,
                    "track_follows": {},
                    "track_ids": ["host"],
                }
            }
        ],
    },
    "skip-range-gone": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            }
        ],
    },
    "skip-replace": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            }
        ],
    },
    "skip-second-of-two-sessions": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "bbbbbbbbbbbb",
                    "session_number": 2,
                    "status": "skipped",
                    "takes": [
                        {
                            "comments": [],
                            "duration_s": 1.0,
                            "offset_s": 0.0,
                            "segment_index": 0,
                            "source_id": "rec-bbbbbbbbbbbb-0-host-0",
                            "take_index": 0,
                            "track_id": "host",
                            "track_label": "Host",
                        },
                        {
                            "comments": [],
                            "duration_s": 2.0,
                            "offset_s": 0.0,
                            "segment_index": 0,
                            "source_id": "rec-bbbbbbbbbbbb-1-host-0",
                            "take_index": 1,
                            "track_id": "host",
                            "track_label": "Host",
                        },
                    ],
                    "to_sec": 8.0,
                    "track_follows": {},
                    "track_ids": ["host"],
                }
            }
        ],
    },
    "skip-selected-take-kept": {
        "history_steps_added": [1, 2],
        "outcomes": [
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
                    "status": "skipped",
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
                }
            },
        ],
    },
    "skip-single-take-replace": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
            }
        ],
    },
    "skip-source-gone": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            }
        ],
    },
    "skip-then-accept": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            },
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already skipped, so it "
                    "cannot be changed again. Undo that "
                    "step first if you want it back, or "
                    "record a new session.",
                }
            },
        ],
    },
    "skip-then-select": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            },
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already skipped, so it "
                    "cannot be changed again. Undo that "
                    "step first if you want it back, or "
                    "record a new session.",
                }
            },
        ],
    },
    "skip-twice": {
        "history_steps_added": [1, 1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            },
            {
                "error": {
                    "code": "session_suggestion_not_pending",
                    "message": "Session 1 was already skipped, so it "
                    "cannot be changed again. Undo that step "
                    "first if you want it back, or record a new "
                    "session.",
                }
            },
        ],
    },
    "skip-unanchored-replace": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
                    "anchor": None,
                    "at_sec": None,
                    "end_anchor": None,
                    "from_sec": 3.0,
                    "id": "ss-aaaaaaaaaaaa",
                    "kind": "replace",
                    "room_tone": [],
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            }
        ],
    },
    "skip-unknown-id": {
        "history_steps_added": [0],
        "outcomes": [
            {
                "error": {
                    "code": "session_suggestion_not_found",
                    "message": "unknown session suggestion: ss-nope. "
                    "List the staged sessions to see their "
                    "ids.",
                }
            }
        ],
    },
    "skip-with-a-pending-edit-in-range": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                }
            }
        ],
    },
    "skip-with-staged-comments": {
        "history_steps_added": [1],
        "outcomes": [
            {
                "ok": {
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
                    "selected_take": None,
                    "session_id": "aaaaaaaaaaaa",
                    "session_number": 1,
                    "status": "skipped",
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
                        },
                        {
                            "comments": [
                                {
                                    "author": "host",
                                    "body": "note 1",
                                    "id": "live-1-0",
                                    "recording_ms": 50,
                                    "timeline_offset_s": 0.0,
                                }
                            ],
                            "duration_s": 2.0,
                            "offset_s": 0.0,
                            "segment_index": 0,
                            "source_id": "rec-aaaaaaaaaaaa-1-host-0",
                            "take_index": 1,
                            "track_id": "host",
                            "track_label": "Host",
                        },
                    ],
                    "to_sec": 5.0,
                    "track_follows": {},
                    "track_ids": ["host"],
                }
            }
        ],
    },
}

OVERRIDES: dict[tuple[str, str], Any] = {
    ("list-mixed-empty-status", "mcp"): {
        "history_steps_added": [0],
        "outcomes": [
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
                        "selected_take": None,
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
                    {
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
                        "selected_take": None,
                        "session_id": "bbbbbbbbbbbb",
                        "session_number": 2,
                        "status": "skipped",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                            {
                                "comments": [],
                                "duration_s": 2.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-bbbbbbbbbbbb-1-host-0",
                                "take_index": 1,
                                "track_id": "host",
                                "track_label": "Host",
                            },
                        ],
                        "to_sec": 8.0,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                    {
                        "anchor": {
                            "at_sec": 8.5,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 8.5,
                            "track_id": "host",
                        },
                        "at_sec": None,
                        "end_anchor": {
                            "at_sec": 9.5,
                            "kind": "clip",
                            "offset_s": 0.0,
                            "side": "before",
                            "source_id": "src-host",
                            "source_sec": 9.5,
                            "track_id": "host",
                        },
                        "from_sec": 8.5,
                        "id": "ss-cccccccccccc",
                        "kind": "replace",
                        "room_tone": [],
                        "selected_take": 0,
                        "session_id": "cccccccccccc",
                        "session_number": 3,
                        "status": "accepted",
                        "takes": [
                            {
                                "comments": [],
                                "duration_s": 1.0,
                                "offset_s": 0.0,
                                "segment_index": 0,
                                "source_id": "rec-cccccccccccc-0-host-0",
                                "take_index": 0,
                                "track_id": "host",
                                "track_label": "Host",
                            }
                        ],
                        "to_sec": 9.5,
                        "track_follows": {},
                        "track_ids": ["host"],
                    },
                ]
            }
        ],
    }
}


_SURFACES = [(name, surface) for name, case in SCENARIOS.items() for surface in case.surfaces]


@pytest.mark.parametrize(("name", "surface"), _SURFACES)
def test_skip_select_list_wire(ws, name, surface):
    expected = OVERRIDES.get((name, surface), EXPECTED[name])
    assert dump(run(ws, SCENARIOS[name], surface)) == dump(expected)


def order_of(value: Any) -> Any:
    """The key order of a result, nested: ``[key]`` for a leaf, ``[key, order]`` for a branch."""
    if isinstance(value, dict):
        rows = []
        for key, item in value.items():
            inner = order_of(item)
            rows.append([key] if inner is None else [key, inner])
        return rows
    if isinstance(value, list) and value and isinstance(value[0], (dict, list)):
        return order_of(value[0])
    return None


ORDER_CASES: dict[str, tuple[Any, Step, tuple[str, ...]]] = {
    "skip": (_three, SKIP, ALL_SURFACES),
    "select": (_three, Step("select", take=1), ALL_SURFACES),
    "takes": (_three, Step("takes"), READ_SURFACES),
    "takes-insert": (_insert, Step("takes"), READ_SURFACES),
    "accept-replace": (_three, Step("accept"), ALL_SURFACES),
    "accept-replace-with-comments": (_commented, Step("accept", take=0), ALL_SURFACES),
    "accept-insert": (_insert, Step("accept"), ALL_SURFACES),
    "accept-held": (_held, Step("accept"), ("service", "handler", "host", "mcp", "web")),
    "list": (_three, Step("list"), ("service", "mcp", "cli")),
}

SHAPE_CASES: dict[str, tuple[Any, Step, tuple[str, ...], Any]] = {
    "skip-ok": (_three, SKIP, ALL_SURFACES, None),
    "skip-unknown-id": (_three, Step("skip", sid=UNKNOWN), ALL_SURFACES, None),
    "skip-twice": (_three, SKIP, ALL_SURFACES, "twice"),
    "takes-ok": (_three, Step("takes"), READ_SURFACES, None),
    "takes-unknown-id": (_three, Step("takes", sid=UNKNOWN), READ_SURFACES, None),
    "select-ok": (_three, Step("select", take=1), ALL_SURFACES, None),
    "select-unknown-take": (_three, Step("select", take=9), ALL_SURFACES, None),
    "select-unknown-id": (_three, Step("select", take=1, sid=UNKNOWN), ALL_SURFACES, None),
    "select-on-insert": (_insert, Step("select", take=0), ALL_SURFACES, None),
    "accept-replace-ok": (_three, Step("accept"), ALL_SURFACES, None),
    "accept-insert-ok": (_insert, Step("accept"), ALL_SURFACES, None),
    "accept-held": (_held, Step("accept"), ALL_SURFACES, None),
    "accept-held-overridden": (_held, Step("accept", override=True), ALL_SURFACES, None),
    "accept-unknown-take": (_three, Step("accept", take=9), ALL_SURFACES, None),
    "accept-take-on-insert": (_insert, Step("accept", take=0), ALL_SURFACES, None),
    "accept-gated-by-refine": (_three, Step("accept"), ALL_SURFACES, _gated),
    "list-ok": (_three, Step("list"), ("service", "mcp", "cli"), None),
    "list-bad-status": (_three, Step("list", status="bogus"), ("service", "mcp", "cli"), None),
}

EXPECTED_ORDERS: dict[str, Any] = {
    "accept-held": [
        ["operation"],
        ["unchanged"],
        [
            "needs_confirmation",
            [
                ["status"],
                ["reason"],
                ["message"],
                [
                    "speech",
                    [
                        ["spans", [["start"], ["end"]]],
                        [
                            "tracks",
                            [
                                ["track_id"],
                                ["speaker"],
                                ["words", [["text"], ["timeline_start"], ["timeline_end"]]],
                                ["sound_spans"],
                            ],
                        ],
                    ],
                ],
            ],
        ],
        ["apply_anyway"],
    ],
    "accept-insert": [
        [
            "suggestion",
            [
                ["id"],
                ["kind"],
                ["session_id"],
                ["session_number"],
                ["at_sec"],
                [
                    "anchor",
                    [
                        ["kind"],
                        ["at_sec"],
                        ["track_id"],
                        ["source_id"],
                        ["source_sec"],
                        ["side"],
                        ["offset_s"],
                    ],
                ],
                ["end_anchor"],
                ["from_sec"],
                ["to_sec"],
                ["track_ids"],
                ["track_follows", []],
                [
                    "takes",
                    [
                        ["take_index"],
                        ["track_id"],
                        ["track_label"],
                        ["segment_index"],
                        ["source_id"],
                        ["offset_s"],
                        ["duration_s"],
                        ["comments"],
                    ],
                ],
                ["room_tone"],
                ["selected_take"],
                ["status"],
            ],
        ],
        ["at_sec"],
        ["span_s"],
        [
            "clips",
            [
                ["clip_id"],
                ["track_id"],
                ["source_id"],
                ["take_index"],
                ["segment_index"],
                ["timeline_start"],
                ["duration_s"],
            ],
        ],
        ["comments"],
        ["unmoved_track_ids"],
    ],
    "accept-replace": [
        [
            "suggestion",
            [
                ["id"],
                ["kind"],
                ["session_id"],
                ["session_number"],
                ["at_sec"],
                [
                    "anchor",
                    [
                        ["kind"],
                        ["at_sec"],
                        ["track_id"],
                        ["source_id"],
                        ["source_sec"],
                        ["side"],
                        ["offset_s"],
                    ],
                ],
                [
                    "end_anchor",
                    [
                        ["kind"],
                        ["at_sec"],
                        ["track_id"],
                        ["source_id"],
                        ["source_sec"],
                        ["side"],
                        ["offset_s"],
                    ],
                ],
                ["from_sec"],
                ["to_sec"],
                ["track_ids"],
                ["track_follows", []],
                [
                    "takes",
                    [
                        ["take_index"],
                        ["track_id"],
                        ["track_label"],
                        ["segment_index"],
                        ["source_id"],
                        ["offset_s"],
                        ["duration_s"],
                        ["comments"],
                    ],
                ],
                ["room_tone"],
                ["selected_take"],
                ["status"],
            ],
        ],
        ["discarded_takes"],
        ["discard_message"],
        ["at_sec"],
        ["from_sec"],
        ["to_sec"],
        ["removed_s"],
        ["span_s"],
        ["delta_s"],
        ["take_index"],
        [
            "clips",
            [
                ["clip_id"],
                ["track_id"],
                ["source_id"],
                ["take_index"],
                ["segment_index"],
                ["timeline_start"],
                ["duration_s"],
            ],
        ],
        ["comments"],
        ["comments_not_placed"],
        ["room_tone_not_placed"],
        ["clamped_comment_ids"],
        ["retired_decision_ids"],
        ["unmoved_track_ids"],
    ],
    "accept-replace-with-comments": [
        [
            "suggestion",
            [
                ["id"],
                ["kind"],
                ["session_id"],
                ["session_number"],
                ["at_sec"],
                [
                    "anchor",
                    [
                        ["kind"],
                        ["at_sec"],
                        ["track_id"],
                        ["source_id"],
                        ["source_sec"],
                        ["side"],
                        ["offset_s"],
                    ],
                ],
                [
                    "end_anchor",
                    [
                        ["kind"],
                        ["at_sec"],
                        ["track_id"],
                        ["source_id"],
                        ["source_sec"],
                        ["side"],
                        ["offset_s"],
                    ],
                ],
                ["from_sec"],
                ["to_sec"],
                ["track_ids"],
                ["track_follows", []],
                [
                    "takes",
                    [
                        ["take_index"],
                        ["track_id"],
                        ["track_label"],
                        ["segment_index"],
                        ["source_id"],
                        ["offset_s"],
                        ["duration_s"],
                        [
                            "comments",
                            [["id"], ["body"], ["author"], ["recording_ms"], ["timeline_offset_s"]],
                        ],
                    ],
                ],
                ["room_tone"],
                ["selected_take"],
                ["status"],
            ],
        ],
        ["discarded_takes"],
        ["discard_message"],
        ["at_sec"],
        ["from_sec"],
        ["to_sec"],
        ["removed_s"],
        ["span_s"],
        ["delta_s"],
        ["take_index"],
        [
            "clips",
            [
                ["clip_id"],
                ["track_id"],
                ["source_id"],
                ["take_index"],
                ["segment_index"],
                ["timeline_start"],
                ["duration_s"],
            ],
        ],
        ["comments", [["id"], ["timeline_start"]]],
        ["comments_not_placed"],
        ["room_tone_not_placed"],
        ["clamped_comment_ids"],
        ["retired_decision_ids"],
        ["unmoved_track_ids"],
    ],
    "list": [
        ["id"],
        ["kind"],
        ["session_id"],
        ["session_number"],
        ["at_sec"],
        [
            "anchor",
            [
                ["kind"],
                ["at_sec"],
                ["track_id"],
                ["source_id"],
                ["source_sec"],
                ["side"],
                ["offset_s"],
            ],
        ],
        [
            "end_anchor",
            [
                ["kind"],
                ["at_sec"],
                ["track_id"],
                ["source_id"],
                ["source_sec"],
                ["side"],
                ["offset_s"],
            ],
        ],
        ["from_sec"],
        ["to_sec"],
        ["track_ids"],
        ["track_follows", []],
        [
            "takes",
            [
                ["take_index"],
                ["track_id"],
                ["track_label"],
                ["segment_index"],
                ["source_id"],
                ["offset_s"],
                ["duration_s"],
                ["comments"],
            ],
        ],
        ["room_tone"],
        ["selected_take"],
        ["status"],
    ],
    "select": [
        [
            "suggestion",
            [
                ["id"],
                ["kind"],
                ["session_id"],
                ["session_number"],
                ["at_sec"],
                [
                    "anchor",
                    [
                        ["kind"],
                        ["at_sec"],
                        ["track_id"],
                        ["source_id"],
                        ["source_sec"],
                        ["side"],
                        ["offset_s"],
                    ],
                ],
                [
                    "end_anchor",
                    [
                        ["kind"],
                        ["at_sec"],
                        ["track_id"],
                        ["source_id"],
                        ["source_sec"],
                        ["side"],
                        ["offset_s"],
                    ],
                ],
                ["from_sec"],
                ["to_sec"],
                ["track_ids"],
                ["track_follows", []],
                [
                    "takes",
                    [
                        ["take_index"],
                        ["track_id"],
                        ["track_label"],
                        ["segment_index"],
                        ["source_id"],
                        ["offset_s"],
                        ["duration_s"],
                        ["comments"],
                    ],
                ],
                ["room_tone"],
                ["selected_take"],
                ["status"],
            ],
        ],
        ["selected_take"],
    ],
    "skip": [
        ["id"],
        ["kind"],
        ["session_id"],
        ["session_number"],
        ["at_sec"],
        [
            "anchor",
            [
                ["kind"],
                ["at_sec"],
                ["track_id"],
                ["source_id"],
                ["source_sec"],
                ["side"],
                ["offset_s"],
            ],
        ],
        [
            "end_anchor",
            [
                ["kind"],
                ["at_sec"],
                ["track_id"],
                ["source_id"],
                ["source_sec"],
                ["side"],
                ["offset_s"],
            ],
        ],
        ["from_sec"],
        ["to_sec"],
        ["track_ids"],
        ["track_follows", []],
        [
            "takes",
            [
                ["take_index"],
                ["track_id"],
                ["track_label"],
                ["segment_index"],
                ["source_id"],
                ["offset_s"],
                ["duration_s"],
                ["comments"],
            ],
        ],
        ["room_tone"],
        ["selected_take"],
        ["status"],
    ],
    "takes": [
        ["suggestion_id"],
        ["kind"],
        ["status"],
        ["selectable"],
        ["selected_take"],
        ["default_take"],
        [
            "takes",
            [
                ["take_index"],
                ["duration_s"],
                ["tracks", [["track_id"], ["track_label"], ["duration_s"], ["segments"]]],
                ["word_count"],
                ["speech_text"],
                ["chosen"],
                ["default"],
                ["acceptable"],
                ["refusal"],
            ],
        ],
    ],
    "takes-insert": [
        ["suggestion_id"],
        ["kind"],
        ["status"],
        ["selectable"],
        ["selected_take"],
        ["default_take"],
        [
            "takes",
            [
                ["take_index"],
                ["duration_s"],
                ["tracks", [["track_id"], ["track_label"], ["duration_s"], ["segments"]]],
                ["word_count"],
                ["speech_text"],
                ["chosen"],
                ["default"],
                ["acceptable"],
                ["refusal"],
            ],
        ],
    ],
}

ORDER_OVERRIDES: dict[tuple[str, str], Any] = {}

EXPECTED_SHAPES: dict[tuple[str, str], Any] = {
    ("accept-gated-by-refine", "cli"): {
        "exit_code": 1,
        "stderr": "The transcript clean-up needs to finish first, "
        "so the words this replace removes are the "
        "right ones. Finish it with `podcast transcript "
        "refine-done` / `transcript_refine_done_tool`, "
        "or skip it with `podcast transcript "
        "refine-waive --reason ...` / "
        "`transcript_refine_waive_tool`, then try "
        "again. (code transcript_refine_required)\n",
        "stdout": "",
    },
    ("accept-gated-by-refine", "handler"): {
        "code": "transcript_refine_required",
        "message": "The transcript clean-up needs to finish "
        "first, so the words this replace removes "
        "are the right ones. Finish it with "
        "`podcast transcript refine-done` / "
        "`transcript_refine_done_tool`, or skip it "
        "with `podcast transcript refine-waive "
        "--reason ...` / "
        "`transcript_refine_waive_tool`, then try "
        "again.",
        "raised": "TranscriptRefineRequiredError",
    },
    ("accept-gated-by-refine", "host"): {
        "code": "transcript_refine_required",
        "message": "The transcript clean-up needs to finish "
        "first, so the words this replace removes are "
        "the right ones. Finish it with `podcast "
        "transcript refine-done` / "
        "`transcript_refine_done_tool`, or skip it "
        "with `podcast transcript refine-waive "
        "--reason ...` / "
        "`transcript_refine_waive_tool`, then try "
        "again.",
        "raised": "TranscriptRefineRequiredError",
    },
    ("accept-gated-by-refine", "mcp"): {
        "code": "transcript_refine_required",
        "message": "The transcript clean-up needs to finish "
        "first, so the words this replace removes are "
        "the right ones. Finish it with `podcast "
        "transcript refine-done` / "
        "`transcript_refine_done_tool`, or skip it "
        "with `podcast transcript refine-waive "
        "--reason ...` / "
        "`transcript_refine_waive_tool`, then try "
        "again.",
        "raised": "TranscriptRefineRequiredError",
    },
    ("accept-gated-by-refine", "service"): {
        "code": "transcript_refine_required",
        "message": "The transcript clean-up needs to finish "
        "first, so the words this replace removes "
        "are the right ones. Finish it with "
        "`podcast transcript refine-done` / "
        "`transcript_refine_done_tool`, or skip it "
        "with `podcast transcript refine-waive "
        "--reason ...` / "
        "`transcript_refine_waive_tool`, then try "
        "again.",
        "raised": "TranscriptRefineRequiredError",
    },
    ("accept-gated-by-refine", "web"): {
        "body": '{"detail":"The transcript clean-up needs to '
        "finish first, so the words this replace removes "
        "are the right ones. Finish it with `podcast "
        "transcript refine-done` / "
        "`transcript_refine_done_tool`, or skip it with "
        "`podcast transcript refine-waive --reason ...` / "
        "`transcript_refine_waive_tool`, then try "
        'again."}',
        "error_code": "transcript_refine_required",
        "status": 409,
    },
    ("accept-held", "cli"): {
        "exit_code": 1,
        "stderr": 'Replacing this range also removes 2 words from Guest: "so '
        'plan". Replace anyway to apply it; undo brings it back.\n'
        "Nothing changed. To apply this replace as is, repeat the "
        "command with --override-audio-checks.\n",
        "stdout": "",
    },
    ("accept-held", "handler"): {
        "keys": ["operation", "unchanged", "needs_confirmation", "apply_anyway"],
        "returned": "dict",
    },
    ("accept-held", "host"): {
        "keys": ["operation", "unchanged", "needs_confirmation", "apply_anyway"],
        "returned": "dict",
    },
    ("accept-held", "mcp"): {
        "text": "{\n"
        '  "operation": "accept_session_suggestion",\n'
        '  "unchanged": true,\n'
        '  "needs_confirmation": {\n'
        '    "status": "needs_confirmation",\n'
        '    "reason": "cuts_other_speech",\n'
        '    "message": "Replacing this range also removes 2 words '
        'from Guest: \\"so plan\\". Replace anyway to apply it; undo '
        "brings it back. To apply it as is, repeat the call with "
        "override_audio_checks=true (CLI "
        '--override-audio-checks).",\n'
        '    "speech": {\n'
        '      "spans": [\n'
        "        {\n"
        '          "start": 2.0,\n'
        '          "end": 4.0\n'
        "        }\n"
        "      ],\n"
        '      "tracks": [\n'
        "        {\n"
        '          "track_id": "guest",\n'
        '          "speaker": "Guest",\n'
        '          "words": [\n'
        "            {\n"
        '              "text": "so",\n'
        '              "timeline_start": 2.5,\n'
        '              "timeline_end": 2.8\n'
        "            },\n"
        "            {\n"
        '              "text": "plan",\n'
        '              "timeline_start": 3.0,\n'
        '              "timeline_end": 3.4\n'
        "            }\n"
        "          ],\n"
        '          "sound_spans": []\n'
        "        }\n"
        "      ]\n"
        "    }\n"
        "  },\n"
        '  "apply_anyway": "To apply it as is, repeat the call with '
        'override_audio_checks=true (CLI --override-audio-checks)."\n'
        "}"
    },
    ("accept-held", "service"): {
        "keys": ["operation", "unchanged", "needs_confirmation", "apply_anyway"],
        "returned": "dict",
    },
    ("accept-held", "web"): {"body": "<command reply>", "error_code": None, "status": 200},
    ("accept-held-overridden", "cli"): {
        "exit_code": 0,
        "stderr": "",
        "stdout": "{\n"
        '  "suggestion": {\n'
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "replace",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": null,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 2.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 2.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 4.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 4.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "from_sec": 2.0,\n'
        '    "to_sec": 4.0,\n'
        '    "track_ids": [\n'
        '      "host"\n'
        "    ],\n"
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 1,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": '
        '"rec-aaaaaaaaaaaa-1-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 3.0,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": 1,\n'
        '    "status": "accepted"\n'
        "  },\n"
        '  "discarded_takes": [\n'
        "    0\n"
        "  ],\n"
        '  "discard_message": "The other take (0) was '
        'discarded. Undo brings it back.",\n'
        '  "at_sec": 2.0,\n'
        '  "from_sec": 2.0,\n'
        '  "to_sec": 4.0,\n'
        '  "removed_s": 2.0,\n'
        '  "span_s": 3.0,\n'
        '  "delta_s": 1.0,\n'
        '  "take_index": 1,\n'
        '  "clips": [\n'
        "    {\n"
        '      "clip_id": "<clip>",\n'
        '      "track_id": "host",\n'
        '      "source_id": '
        '"rec-aaaaaaaaaaaa-1-host-0",\n'
        '      "take_index": 1,\n'
        '      "segment_index": 0,\n'
        '      "timeline_start": 2.0,\n'
        '      "duration_s": 3.0\n'
        "    }\n"
        "  ],\n"
        '  "comments": [],\n'
        '  "comments_not_placed": 0,\n'
        '  "room_tone_not_placed": 0,\n'
        '  "clamped_comment_ids": [],\n'
        '  "retired_decision_ids": [],\n'
        '  "unmoved_track_ids": []\n'
        "}\n",
    },
    ("accept-held-overridden", "handler"): {
        "keys": [
            "suggestion",
            "discarded_takes",
            "discard_message",
            "at_sec",
            "from_sec",
            "to_sec",
            "removed_s",
            "span_s",
            "delta_s",
            "take_index",
            "clips",
            "comments",
            "comments_not_placed",
            "room_tone_not_placed",
            "clamped_comment_ids",
            "retired_decision_ids",
            "unmoved_track_ids",
        ],
        "returned": "dict",
    },
    ("accept-held-overridden", "host"): {
        "keys": [
            "suggestion",
            "discarded_takes",
            "discard_message",
            "at_sec",
            "from_sec",
            "to_sec",
            "removed_s",
            "span_s",
            "delta_s",
            "take_index",
            "clips",
            "comments",
            "comments_not_placed",
            "room_tone_not_placed",
            "clamped_comment_ids",
            "retired_decision_ids",
            "unmoved_track_ids",
        ],
        "returned": "dict",
    },
    ("accept-held-overridden", "mcp"): {
        "text": "{\n"
        '  "suggestion": {\n'
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "replace",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": null,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 2.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 2.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 4.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 4.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "from_sec": 2.0,\n'
        '    "to_sec": 4.0,\n'
        '    "track_ids": [\n'
        '      "host"\n'
        "    ],\n"
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 1,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": '
        '"rec-aaaaaaaaaaaa-1-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 3.0,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": 1,\n'
        '    "status": "accepted"\n'
        "  },\n"
        '  "discarded_takes": [\n'
        "    0\n"
        "  ],\n"
        '  "discard_message": "The other take (0) was '
        'discarded. Undo brings it back.",\n'
        '  "at_sec": 2.0,\n'
        '  "from_sec": 2.0,\n'
        '  "to_sec": 4.0,\n'
        '  "removed_s": 2.0,\n'
        '  "span_s": 3.0,\n'
        '  "delta_s": 1.0,\n'
        '  "take_index": 1,\n'
        '  "clips": [\n'
        "    {\n"
        '      "clip_id": "<clip>",\n'
        '      "track_id": "host",\n'
        '      "source_id": "rec-aaaaaaaaaaaa-1-host-0",\n'
        '      "take_index": 1,\n'
        '      "segment_index": 0,\n'
        '      "timeline_start": 2.0,\n'
        '      "duration_s": 3.0\n'
        "    }\n"
        "  ],\n"
        '  "comments": [],\n'
        '  "comments_not_placed": 0,\n'
        '  "room_tone_not_placed": 0,\n'
        '  "clamped_comment_ids": [],\n'
        '  "retired_decision_ids": [],\n'
        '  "unmoved_track_ids": []\n'
        "}"
    },
    ("accept-held-overridden", "service"): {
        "keys": [
            "suggestion",
            "discarded_takes",
            "discard_message",
            "at_sec",
            "from_sec",
            "to_sec",
            "removed_s",
            "span_s",
            "delta_s",
            "take_index",
            "clips",
            "comments",
            "comments_not_placed",
            "room_tone_not_placed",
            "clamped_comment_ids",
            "retired_decision_ids",
            "unmoved_track_ids",
        ],
        "returned": "dict",
    },
    ("accept-held-overridden", "web"): {
        "body": "<command reply>",
        "error_code": None,
        "status": 200,
    },
    ("accept-insert-ok", "cli"): {
        "exit_code": 0,
        "stderr": "",
        "stdout": "{\n"
        '  "suggestion": {\n'
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "insert",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": 4.0,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 4.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 4.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": null,\n'
        '    "from_sec": null,\n'
        '    "to_sec": null,\n'
        '    "track_ids": [],\n'
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 0,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 1.0,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 0,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 1,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-0-host-1",\n'
        '        "offset_s": 1.0,\n'
        '        "duration_s": 1.5,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": null,\n'
        '    "status": "accepted"\n'
        "  },\n"
        '  "at_sec": 4.0,\n'
        '  "span_s": 2.5,\n'
        '  "clips": [\n'
        "    {\n"
        '      "clip_id": "<clip>",\n'
        '      "track_id": "host",\n'
        '      "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '      "take_index": 0,\n'
        '      "segment_index": 0,\n'
        '      "timeline_start": 4.0,\n'
        '      "duration_s": 1.0\n'
        "    },\n"
        "    {\n"
        '      "clip_id": "<clip>",\n'
        '      "track_id": "host",\n'
        '      "source_id": "rec-aaaaaaaaaaaa-0-host-1",\n'
        '      "take_index": 0,\n'
        '      "segment_index": 1,\n'
        '      "timeline_start": 5.0,\n'
        '      "duration_s": 1.5\n'
        "    }\n"
        "  ],\n"
        '  "comments": [],\n'
        '  "unmoved_track_ids": []\n'
        "}\n",
    },
    ("accept-insert-ok", "handler"): {
        "keys": ["suggestion", "at_sec", "span_s", "clips", "comments", "unmoved_track_ids"],
        "returned": "dict",
    },
    ("accept-insert-ok", "host"): {
        "keys": ["suggestion", "at_sec", "span_s", "clips", "comments", "unmoved_track_ids"],
        "returned": "dict",
    },
    ("accept-insert-ok", "mcp"): {
        "text": "{\n"
        '  "suggestion": {\n'
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "insert",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": 4.0,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 4.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 4.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": null,\n'
        '    "from_sec": null,\n'
        '    "to_sec": null,\n'
        '    "track_ids": [],\n'
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 0,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 1.0,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 0,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 1,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-0-host-1",\n'
        '        "offset_s": 1.0,\n'
        '        "duration_s": 1.5,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": null,\n'
        '    "status": "accepted"\n'
        "  },\n"
        '  "at_sec": 4.0,\n'
        '  "span_s": 2.5,\n'
        '  "clips": [\n'
        "    {\n"
        '      "clip_id": "<clip>",\n'
        '      "track_id": "host",\n'
        '      "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '      "take_index": 0,\n'
        '      "segment_index": 0,\n'
        '      "timeline_start": 4.0,\n'
        '      "duration_s": 1.0\n'
        "    },\n"
        "    {\n"
        '      "clip_id": "<clip>",\n'
        '      "track_id": "host",\n'
        '      "source_id": "rec-aaaaaaaaaaaa-0-host-1",\n'
        '      "take_index": 0,\n'
        '      "segment_index": 1,\n'
        '      "timeline_start": 5.0,\n'
        '      "duration_s": 1.5\n'
        "    }\n"
        "  ],\n"
        '  "comments": [],\n'
        '  "unmoved_track_ids": []\n'
        "}"
    },
    ("accept-insert-ok", "service"): {
        "keys": ["suggestion", "at_sec", "span_s", "clips", "comments", "unmoved_track_ids"],
        "returned": "dict",
    },
    ("accept-insert-ok", "web"): {"body": "<command reply>", "error_code": None, "status": 200},
    ("accept-replace-ok", "cli"): {
        "exit_code": 0,
        "stderr": "",
        "stdout": "{\n"
        '  "suggestion": {\n'
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "replace",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": null,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 3.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 3.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 5.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 5.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "from_sec": 3.0,\n'
        '    "to_sec": 5.0,\n'
        '    "track_ids": [\n'
        '      "host"\n'
        "    ],\n"
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 2,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 3.5,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": 2,\n'
        '    "status": "accepted"\n'
        "  },\n"
        '  "discarded_takes": [\n'
        "    0,\n"
        "    1\n"
        "  ],\n"
        '  "discard_message": "The other takes (0, 1) were '
        'discarded. Undo brings them back.",\n'
        '  "at_sec": 3.0,\n'
        '  "from_sec": 3.0,\n'
        '  "to_sec": 5.0,\n'
        '  "removed_s": 2.0,\n'
        '  "span_s": 3.5,\n'
        '  "delta_s": 1.5,\n'
        '  "take_index": 2,\n'
        '  "clips": [\n'
        "    {\n"
        '      "clip_id": "<clip>",\n'
        '      "track_id": "host",\n'
        '      "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '      "take_index": 2,\n'
        '      "segment_index": 0,\n'
        '      "timeline_start": 3.0,\n'
        '      "duration_s": 3.5\n'
        "    }\n"
        "  ],\n"
        '  "comments": [],\n'
        '  "comments_not_placed": 0,\n'
        '  "room_tone_not_placed": 0,\n'
        '  "clamped_comment_ids": [],\n'
        '  "retired_decision_ids": [],\n'
        '  "unmoved_track_ids": []\n'
        "}\n",
    },
    ("accept-replace-ok", "handler"): {
        "keys": [
            "suggestion",
            "discarded_takes",
            "discard_message",
            "at_sec",
            "from_sec",
            "to_sec",
            "removed_s",
            "span_s",
            "delta_s",
            "take_index",
            "clips",
            "comments",
            "comments_not_placed",
            "room_tone_not_placed",
            "clamped_comment_ids",
            "retired_decision_ids",
            "unmoved_track_ids",
        ],
        "returned": "dict",
    },
    ("accept-replace-ok", "host"): {
        "keys": [
            "suggestion",
            "discarded_takes",
            "discard_message",
            "at_sec",
            "from_sec",
            "to_sec",
            "removed_s",
            "span_s",
            "delta_s",
            "take_index",
            "clips",
            "comments",
            "comments_not_placed",
            "room_tone_not_placed",
            "clamped_comment_ids",
            "retired_decision_ids",
            "unmoved_track_ids",
        ],
        "returned": "dict",
    },
    ("accept-replace-ok", "mcp"): {
        "text": "{\n"
        '  "suggestion": {\n'
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "replace",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": null,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 3.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 3.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 5.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 5.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "from_sec": 3.0,\n'
        '    "to_sec": 5.0,\n'
        '    "track_ids": [\n'
        '      "host"\n'
        "    ],\n"
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 2,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 3.5,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": 2,\n'
        '    "status": "accepted"\n'
        "  },\n"
        '  "discarded_takes": [\n'
        "    0,\n"
        "    1\n"
        "  ],\n"
        '  "discard_message": "The other takes (0, 1) were '
        'discarded. Undo brings them back.",\n'
        '  "at_sec": 3.0,\n'
        '  "from_sec": 3.0,\n'
        '  "to_sec": 5.0,\n'
        '  "removed_s": 2.0,\n'
        '  "span_s": 3.5,\n'
        '  "delta_s": 1.5,\n'
        '  "take_index": 2,\n'
        '  "clips": [\n'
        "    {\n"
        '      "clip_id": "<clip>",\n'
        '      "track_id": "host",\n'
        '      "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '      "take_index": 2,\n'
        '      "segment_index": 0,\n'
        '      "timeline_start": 3.0,\n'
        '      "duration_s": 3.5\n'
        "    }\n"
        "  ],\n"
        '  "comments": [],\n'
        '  "comments_not_placed": 0,\n'
        '  "room_tone_not_placed": 0,\n'
        '  "clamped_comment_ids": [],\n'
        '  "retired_decision_ids": [],\n'
        '  "unmoved_track_ids": []\n'
        "}"
    },
    ("accept-replace-ok", "service"): {
        "keys": [
            "suggestion",
            "discarded_takes",
            "discard_message",
            "at_sec",
            "from_sec",
            "to_sec",
            "removed_s",
            "span_s",
            "delta_s",
            "take_index",
            "clips",
            "comments",
            "comments_not_placed",
            "room_tone_not_placed",
            "clamped_comment_ids",
            "retired_decision_ids",
            "unmoved_track_ids",
        ],
        "returned": "dict",
    },
    ("accept-replace-ok", "web"): {"body": "<command reply>", "error_code": None, "status": 200},
    ("accept-take-on-insert", "cli"): {
        "exit_code": 1,
        "stderr": "Session 1 is an insert, whose takes play one "
        "after another, so a take cannot be chosen. "
        "Accept it without a take. (code "
        "take_not_applicable)\n",
        "stdout": "",
    },
    ("accept-take-on-insert", "handler"): {
        "code": "take_not_applicable",
        "message": "Session 1 is an insert, whose takes play "
        "one after another, so a take cannot be "
        "chosen. Accept it without a take.",
        "raised": "CodedValueError",
    },
    ("accept-take-on-insert", "host"): {
        "code": "take_not_applicable",
        "message": "Session 1 is an insert, whose takes play one "
        "after another, so a take cannot be chosen. "
        "Accept it without a take.",
        "raised": "CodedValueError",
    },
    ("accept-take-on-insert", "mcp"): {
        "code": "take_not_applicable",
        "message": "Session 1 is an insert, whose takes play one "
        "after another, so a take cannot be chosen. "
        "Accept it without a take.",
        "raised": "CodedValueError",
    },
    ("accept-take-on-insert", "service"): {
        "code": "take_not_applicable",
        "message": "Session 1 is an insert, whose takes play "
        "one after another, so a take cannot be "
        "chosen. Accept it without a take.",
        "raised": "CodedValueError",
    },
    ("accept-take-on-insert", "web"): {
        "body": '{"detail":"Session 1 is an insert, whose takes '
        "play one after another, so a take cannot be "
        'chosen. Accept it without a take."}',
        "error_code": "take_not_applicable",
        "status": 400,
    },
    ("accept-unknown-take", "cli"): {
        "exit_code": 1,
        "stderr": "Session 1 has no take 9. Pick one of: 0, 1, 2. (code take_not_found)\n",
        "stdout": "",
    },
    ("accept-unknown-take", "handler"): {
        "code": "take_not_found",
        "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
        "raised": "CodedValueError",
    },
    ("accept-unknown-take", "host"): {
        "code": "take_not_found",
        "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
        "raised": "DocumentConflictError",
    },
    ("accept-unknown-take", "mcp"): {
        "code": "take_not_found",
        "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
        "raised": "CodedValueError",
    },
    ("accept-unknown-take", "service"): {
        "code": "take_not_found",
        "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
        "raised": "CodedValueError",
    },
    ("accept-unknown-take", "web"): {
        "body": '{"detail":{"detail":"Session 1 has no take 9. Pick '
        'one of: 0, 1, 2.","conflict":true}}',
        "error_code": "take_not_found",
        "status": 409,
    },
    ("list-bad-status", "cli"): {
        "exit_code": 1,
        "stderr": "status must be one of pending, skipped, accepted (code invalid_status)\n",
        "stdout": "",
    },
    ("list-bad-status", "mcp"): {
        "code": "invalid_status",
        "message": "status must be one of pending, skipped, accepted",
        "raised": "CodedValueError",
    },
    ("list-bad-status", "service"): {
        "code": "invalid_status",
        "message": "status must be one of pending, skipped, accepted",
        "raised": "CodedValueError",
    },
    ("list-ok", "cli"): {
        "exit_code": 0,
        "stderr": "",
        "stdout": "[\n"
        "  {\n"
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "replace",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": null,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 3.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 3.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 5.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 5.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "from_sec": 3.0,\n'
        '    "to_sec": 5.0,\n'
        '    "track_ids": [\n'
        '      "host"\n'
        "    ],\n"
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 0,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 1.0,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 1,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-1-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 2.5,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 2,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 3.5,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": null,\n'
        '    "status": "pending"\n'
        "  }\n"
        "]\n",
    },
    ("list-ok", "mcp"): {
        "text": "[\n"
        "  {\n"
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "replace",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": null,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 3.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 3.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 5.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 5.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "from_sec": 3.0,\n'
        '    "to_sec": 5.0,\n'
        '    "track_ids": [\n'
        '      "host"\n'
        "    ],\n"
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 0,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 1.0,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 1,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-1-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 2.5,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 2,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 3.5,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": null,\n'
        '    "status": "pending"\n'
        "  }\n"
        "]"
    },
    ("list-ok", "service"): {
        "keys": [
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
                "selected_take": None,
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
            }
        ],
        "returned": "list",
    },
    ("select-ok", "cli"): {
        "exit_code": 0,
        "stderr": "",
        "stdout": "{\n"
        '  "suggestion": {\n'
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "replace",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": null,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 3.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 3.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 5.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 5.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "from_sec": 3.0,\n'
        '    "to_sec": 5.0,\n'
        '    "track_ids": [\n'
        '      "host"\n'
        "    ],\n"
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 0,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 1.0,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 1,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-1-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 2.5,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 2,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 3.5,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": 1,\n'
        '    "status": "pending"\n'
        "  },\n"
        '  "selected_take": 1\n'
        "}\n",
    },
    ("select-ok", "handler"): {"keys": ["suggestion", "selected_take"], "returned": "dict"},
    ("select-ok", "host"): {"keys": ["suggestion", "selected_take"], "returned": "dict"},
    ("select-ok", "mcp"): {
        "text": "{\n"
        '  "suggestion": {\n'
        '    "id": "ss-aaaaaaaaaaaa",\n'
        '    "kind": "replace",\n'
        '    "session_id": "aaaaaaaaaaaa",\n'
        '    "session_number": 1,\n'
        '    "at_sec": null,\n'
        '    "anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 3.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 3.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "end_anchor": {\n'
        '      "kind": "clip",\n'
        '      "at_sec": 5.0,\n'
        '      "track_id": "host",\n'
        '      "source_id": "src-host",\n'
        '      "source_sec": 5.0,\n'
        '      "side": "before",\n'
        '      "offset_s": 0.0\n'
        "    },\n"
        '    "from_sec": 3.0,\n'
        '    "to_sec": 5.0,\n'
        '    "track_ids": [\n'
        '      "host"\n'
        "    ],\n"
        '    "track_follows": {},\n'
        '    "takes": [\n'
        "      {\n"
        '        "take_index": 0,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 1.0,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 1,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-1-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 2.5,\n'
        '        "comments": []\n'
        "      },\n"
        "      {\n"
        '        "take_index": 2,\n'
        '        "track_id": "host",\n'
        '        "track_label": "Host",\n'
        '        "segment_index": 0,\n'
        '        "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '        "offset_s": 0.0,\n'
        '        "duration_s": 3.5,\n'
        '        "comments": []\n'
        "      }\n"
        "    ],\n"
        '    "room_tone": [],\n'
        '    "selected_take": 1,\n'
        '    "status": "pending"\n'
        "  },\n"
        '  "selected_take": 1\n'
        "}"
    },
    ("select-ok", "service"): {"keys": ["suggestion", "selected_take"], "returned": "dict"},
    ("select-ok", "web"): {
        "body": '{"suggestion":{"id":"ss-aaaaaaaaaaaa","kind":"replace","session_id":"aaaaaaaaaaaa","session_number":1,"at_sec":null,"anchor":{"kind":"clip","at_sec":3.0,"track_id":"host","source_id":"src-host","source_sec":3.0,"side":"before","offset_s":0.0},"end_anchor":{"kind":"clip","at_sec":5.0,"track_id":"host","source_id":"src-host","source_sec":5.0,"side":"before","offset_s":0.0},"from_sec":3.0,"to_sec":5.0,"track_ids":["host"],"track_follows":{},"takes":[{"take_index":0,"track_id":"host","track_label":"Host","segment_index":0,"source_id":"rec-aaaaaaaaaaaa-0-host-0","offset_s":0.0,"duration_s":1.0,"comments":[]},{"take_index":1,"track_id":"host","track_label":"Host","segment_index":0,"source_id":"rec-aaaaaaaaaaaa-1-host-0","offset_s":0.0,"duration_s":2.5,"comments":[]},{"take_index":2,"track_id":"host","track_label":"Host","segment_index":0,"source_id":"rec-aaaaaaaaaaaa-2-host-0","offset_s":0.0,"duration_s":3.5,"comments":[]}],"room_tone":[],"selected_take":1,"status":"pending"},"selected_take":1}',
        "error_code": None,
        "status": 200,
    },
    ("select-on-insert", "cli"): {
        "exit_code": 1,
        "stderr": "Session 1 is an insert, whose takes play one after "
        "another, so a take cannot be chosen. Accept it "
        "without a take. (code take_not_applicable)\n",
        "stdout": "",
    },
    ("select-on-insert", "handler"): {
        "code": "take_not_applicable",
        "message": "Session 1 is an insert, whose takes play one "
        "after another, so a take cannot be chosen. "
        "Accept it without a take.",
        "raised": "CodedValueError",
    },
    ("select-on-insert", "host"): {
        "code": "take_not_applicable",
        "message": "Session 1 is an insert, whose takes play one after "
        "another, so a take cannot be chosen. Accept it "
        "without a take.",
        "raised": "CodedValueError",
    },
    ("select-on-insert", "mcp"): {
        "code": "take_not_applicable",
        "message": "Session 1 is an insert, whose takes play one after "
        "another, so a take cannot be chosen. Accept it "
        "without a take.",
        "raised": "CodedValueError",
    },
    ("select-on-insert", "service"): {
        "code": "take_not_applicable",
        "message": "Session 1 is an insert, whose takes play one "
        "after another, so a take cannot be chosen. "
        "Accept it without a take.",
        "raised": "CodedValueError",
    },
    ("select-on-insert", "web"): {
        "body": '{"detail":"Session 1 is an insert, whose takes play '
        "one after another, so a take cannot be chosen. Accept "
        'it without a take."}',
        "error_code": "take_not_applicable",
        "status": 400,
    },
    ("select-unknown-id", "cli"): {
        "exit_code": 1,
        "stderr": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids. (code "
        "session_suggestion_not_found)\n",
        "stdout": "",
    },
    ("select-unknown-id", "handler"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "CodedKeyError",
    },
    ("select-unknown-id", "host"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "DocumentConflictError",
    },
    ("select-unknown-id", "mcp"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "CodedKeyError",
    },
    ("select-unknown-id", "service"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "CodedKeyError",
    },
    ("select-unknown-id", "web"): {
        "body": '{"detail":"unknown session suggestion: ss-nope. List '
        'the staged sessions to see their ids."}',
        "error_code": "session_suggestion_not_found",
        "status": 404,
    },
    ("select-unknown-take", "cli"): {
        "exit_code": 1,
        "stderr": "Session 1 has no take 9. Pick one of: 0, 1, 2. (code take_not_found)\n",
        "stdout": "",
    },
    ("select-unknown-take", "handler"): {
        "code": "take_not_found",
        "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
        "raised": "CodedValueError",
    },
    ("select-unknown-take", "host"): {
        "code": "take_not_found",
        "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
        "raised": "DocumentConflictError",
    },
    ("select-unknown-take", "mcp"): {
        "code": "take_not_found",
        "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
        "raised": "CodedValueError",
    },
    ("select-unknown-take", "service"): {
        "code": "take_not_found",
        "message": "Session 1 has no take 9. Pick one of: 0, 1, 2.",
        "raised": "CodedValueError",
    },
    ("select-unknown-take", "web"): {
        "body": '{"detail":"Session 1 has no take 9. Pick one of: 0, 1, 2."}',
        "error_code": "take_not_found",
        "status": 400,
    },
    ("skip-ok", "cli"): {
        "exit_code": 0,
        "stderr": "",
        "stdout": "{\n"
        '  "id": "ss-aaaaaaaaaaaa",\n'
        '  "kind": "replace",\n'
        '  "session_id": "aaaaaaaaaaaa",\n'
        '  "session_number": 1,\n'
        '  "at_sec": null,\n'
        '  "anchor": {\n'
        '    "kind": "clip",\n'
        '    "at_sec": 3.0,\n'
        '    "track_id": "host",\n'
        '    "source_id": "src-host",\n'
        '    "source_sec": 3.0,\n'
        '    "side": "before",\n'
        '    "offset_s": 0.0\n'
        "  },\n"
        '  "end_anchor": {\n'
        '    "kind": "clip",\n'
        '    "at_sec": 5.0,\n'
        '    "track_id": "host",\n'
        '    "source_id": "src-host",\n'
        '    "source_sec": 5.0,\n'
        '    "side": "before",\n'
        '    "offset_s": 0.0\n'
        "  },\n"
        '  "from_sec": 3.0,\n'
        '  "to_sec": 5.0,\n'
        '  "track_ids": [\n'
        '    "host"\n'
        "  ],\n"
        '  "track_follows": {},\n'
        '  "takes": [\n'
        "    {\n"
        '      "take_index": 0,\n'
        '      "track_id": "host",\n'
        '      "track_label": "Host",\n'
        '      "segment_index": 0,\n'
        '      "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '      "offset_s": 0.0,\n'
        '      "duration_s": 1.0,\n'
        '      "comments": []\n'
        "    },\n"
        "    {\n"
        '      "take_index": 1,\n'
        '      "track_id": "host",\n'
        '      "track_label": "Host",\n'
        '      "segment_index": 0,\n'
        '      "source_id": "rec-aaaaaaaaaaaa-1-host-0",\n'
        '      "offset_s": 0.0,\n'
        '      "duration_s": 2.5,\n'
        '      "comments": []\n'
        "    },\n"
        "    {\n"
        '      "take_index": 2,\n'
        '      "track_id": "host",\n'
        '      "track_label": "Host",\n'
        '      "segment_index": 0,\n'
        '      "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '      "offset_s": 0.0,\n'
        '      "duration_s": 3.5,\n'
        '      "comments": []\n'
        "    }\n"
        "  ],\n"
        '  "room_tone": [],\n'
        '  "selected_take": null,\n'
        '  "status": "skipped"\n'
        "}\n",
    },
    ("skip-ok", "handler"): {
        "keys": [
            "id",
            "kind",
            "session_id",
            "session_number",
            "at_sec",
            "anchor",
            "end_anchor",
            "from_sec",
            "to_sec",
            "track_ids",
            "track_follows",
            "takes",
            "room_tone",
            "selected_take",
            "status",
        ],
        "returned": "dict",
    },
    ("skip-ok", "host"): {
        "keys": [
            "id",
            "kind",
            "session_id",
            "session_number",
            "at_sec",
            "anchor",
            "end_anchor",
            "from_sec",
            "to_sec",
            "track_ids",
            "track_follows",
            "takes",
            "room_tone",
            "selected_take",
            "status",
        ],
        "returned": "dict",
    },
    ("skip-ok", "mcp"): {
        "text": "{\n"
        '  "id": "ss-aaaaaaaaaaaa",\n'
        '  "kind": "replace",\n'
        '  "session_id": "aaaaaaaaaaaa",\n'
        '  "session_number": 1,\n'
        '  "at_sec": null,\n'
        '  "anchor": {\n'
        '    "kind": "clip",\n'
        '    "at_sec": 3.0,\n'
        '    "track_id": "host",\n'
        '    "source_id": "src-host",\n'
        '    "source_sec": 3.0,\n'
        '    "side": "before",\n'
        '    "offset_s": 0.0\n'
        "  },\n"
        '  "end_anchor": {\n'
        '    "kind": "clip",\n'
        '    "at_sec": 5.0,\n'
        '    "track_id": "host",\n'
        '    "source_id": "src-host",\n'
        '    "source_sec": 5.0,\n'
        '    "side": "before",\n'
        '    "offset_s": 0.0\n'
        "  },\n"
        '  "from_sec": 3.0,\n'
        '  "to_sec": 5.0,\n'
        '  "track_ids": [\n'
        '    "host"\n'
        "  ],\n"
        '  "track_follows": {},\n'
        '  "takes": [\n'
        "    {\n"
        '      "take_index": 0,\n'
        '      "track_id": "host",\n'
        '      "track_label": "Host",\n'
        '      "segment_index": 0,\n'
        '      "source_id": "rec-aaaaaaaaaaaa-0-host-0",\n'
        '      "offset_s": 0.0,\n'
        '      "duration_s": 1.0,\n'
        '      "comments": []\n'
        "    },\n"
        "    {\n"
        '      "take_index": 1,\n'
        '      "track_id": "host",\n'
        '      "track_label": "Host",\n'
        '      "segment_index": 0,\n'
        '      "source_id": "rec-aaaaaaaaaaaa-1-host-0",\n'
        '      "offset_s": 0.0,\n'
        '      "duration_s": 2.5,\n'
        '      "comments": []\n'
        "    },\n"
        "    {\n"
        '      "take_index": 2,\n'
        '      "track_id": "host",\n'
        '      "track_label": "Host",\n'
        '      "segment_index": 0,\n'
        '      "source_id": "rec-aaaaaaaaaaaa-2-host-0",\n'
        '      "offset_s": 0.0,\n'
        '      "duration_s": 3.5,\n'
        '      "comments": []\n'
        "    }\n"
        "  ],\n"
        '  "room_tone": [],\n'
        '  "selected_take": null,\n'
        '  "status": "skipped"\n'
        "}"
    },
    ("skip-ok", "service"): {
        "keys": [
            "id",
            "kind",
            "session_id",
            "session_number",
            "at_sec",
            "anchor",
            "end_anchor",
            "from_sec",
            "to_sec",
            "track_ids",
            "track_follows",
            "takes",
            "room_tone",
            "selected_take",
            "status",
        ],
        "returned": "dict",
    },
    ("skip-ok", "web"): {"body": "<command reply>", "error_code": None, "status": 200},
    ("skip-twice", "cli"): {
        "exit_code": 1,
        "stderr": "Session 1 was already skipped, so it cannot be changed "
        "again. Undo that step first if you want it back, or record "
        "a new session. (code session_suggestion_not_pending)\n",
        "stdout": "",
    },
    ("skip-twice", "handler"): {
        "code": "session_suggestion_not_pending",
        "message": "Session 1 was already skipped, so it cannot be "
        "changed again. Undo that step first if you want it "
        "back, or record a new session.",
        "raised": "CodedValueError",
    },
    ("skip-twice", "host"): {
        "code": "session_suggestion_not_pending",
        "message": "Session 1 was already skipped, so it cannot be changed "
        "again. Undo that step first if you want it back, or "
        "record a new session.",
        "raised": "CodedValueError",
    },
    ("skip-twice", "mcp"): {
        "code": "session_suggestion_not_pending",
        "message": "Session 1 was already skipped, so it cannot be changed "
        "again. Undo that step first if you want it back, or "
        "record a new session.",
        "raised": "CodedValueError",
    },
    ("skip-twice", "service"): {
        "code": "session_suggestion_not_pending",
        "message": "Session 1 was already skipped, so it cannot be "
        "changed again. Undo that step first if you want it "
        "back, or record a new session.",
        "raised": "CodedValueError",
    },
    ("skip-twice", "web"): {
        "body": '{"detail":"Session 1 was already skipped, so it cannot be '
        "changed again. Undo that step first if you want it back, or "
        'record a new session."}',
        "error_code": "session_suggestion_not_pending",
        "status": 400,
    },
    ("skip-unknown-id", "cli"): {
        "exit_code": 1,
        "stderr": "unknown session suggestion: ss-nope. List the staged "
        "sessions to see their ids. (code "
        "session_suggestion_not_found)\n",
        "stdout": "",
    },
    ("skip-unknown-id", "handler"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "CodedKeyError",
    },
    ("skip-unknown-id", "host"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "DocumentConflictError",
    },
    ("skip-unknown-id", "mcp"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the staged "
        "sessions to see their ids.",
        "raised": "CodedKeyError",
    },
    ("skip-unknown-id", "service"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "CodedKeyError",
    },
    ("skip-unknown-id", "web"): {
        "body": '{"detail":{"detail":"unknown session suggestion: '
        "ss-nope. List the staged sessions to see their "
        'ids.","conflict":true}}',
        "error_code": "session_suggestion_not_found",
        "status": 409,
    },
    ("takes-ok", "cli"): {
        "exit_code": 0,
        "stderr": "",
        "stdout": "{\n"
        '  "suggestion_id": "ss-aaaaaaaaaaaa",\n'
        '  "kind": "replace",\n'
        '  "status": "pending",\n'
        '  "selectable": true,\n'
        '  "selected_take": null,\n'
        '  "default_take": 2,\n'
        '  "takes": [\n'
        "    {\n"
        '      "take_index": 0,\n'
        '      "duration_s": 1.0,\n'
        '      "tracks": [\n'
        "        {\n"
        '          "track_id": "host",\n'
        '          "track_label": "Host",\n'
        '          "duration_s": 1.0,\n'
        '          "segments": 1\n'
        "        }\n"
        "      ],\n"
        '      "word_count": null,\n'
        '      "speech_text": null,\n'
        '      "chosen": false,\n'
        '      "default": false,\n'
        '      "acceptable": true,\n'
        '      "refusal": null\n'
        "    },\n"
        "    {\n"
        '      "take_index": 1,\n'
        '      "duration_s": 2.5,\n'
        '      "tracks": [\n'
        "        {\n"
        '          "track_id": "host",\n'
        '          "track_label": "Host",\n'
        '          "duration_s": 2.5,\n'
        '          "segments": 1\n'
        "        }\n"
        "      ],\n"
        '      "word_count": null,\n'
        '      "speech_text": null,\n'
        '      "chosen": false,\n'
        '      "default": false,\n'
        '      "acceptable": true,\n'
        '      "refusal": null\n'
        "    },\n"
        "    {\n"
        '      "take_index": 2,\n'
        '      "duration_s": 3.5,\n'
        '      "tracks": [\n'
        "        {\n"
        '          "track_id": "host",\n'
        '          "track_label": "Host",\n'
        '          "duration_s": 3.5,\n'
        '          "segments": 1\n'
        "        }\n"
        "      ],\n"
        '      "word_count": null,\n'
        '      "speech_text": null,\n'
        '      "chosen": false,\n'
        '      "default": true,\n'
        '      "acceptable": true,\n'
        '      "refusal": null\n'
        "    }\n"
        "  ]\n"
        "}\n",
    },
    ("takes-ok", "mcp"): {
        "text": "{\n"
        '  "suggestion_id": "ss-aaaaaaaaaaaa",\n'
        '  "kind": "replace",\n'
        '  "status": "pending",\n'
        '  "selectable": true,\n'
        '  "selected_take": null,\n'
        '  "default_take": 2,\n'
        '  "takes": [\n'
        "    {\n"
        '      "take_index": 0,\n'
        '      "duration_s": 1.0,\n'
        '      "tracks": [\n'
        "        {\n"
        '          "track_id": "host",\n'
        '          "track_label": "Host",\n'
        '          "duration_s": 1.0,\n'
        '          "segments": 1\n'
        "        }\n"
        "      ],\n"
        '      "word_count": null,\n'
        '      "speech_text": null,\n'
        '      "chosen": false,\n'
        '      "default": false,\n'
        '      "acceptable": true,\n'
        '      "refusal": null\n'
        "    },\n"
        "    {\n"
        '      "take_index": 1,\n'
        '      "duration_s": 2.5,\n'
        '      "tracks": [\n'
        "        {\n"
        '          "track_id": "host",\n'
        '          "track_label": "Host",\n'
        '          "duration_s": 2.5,\n'
        '          "segments": 1\n'
        "        }\n"
        "      ],\n"
        '      "word_count": null,\n'
        '      "speech_text": null,\n'
        '      "chosen": false,\n'
        '      "default": false,\n'
        '      "acceptable": true,\n'
        '      "refusal": null\n'
        "    },\n"
        "    {\n"
        '      "take_index": 2,\n'
        '      "duration_s": 3.5,\n'
        '      "tracks": [\n'
        "        {\n"
        '          "track_id": "host",\n'
        '          "track_label": "Host",\n'
        '          "duration_s": 3.5,\n'
        '          "segments": 1\n'
        "        }\n"
        "      ],\n"
        '      "word_count": null,\n'
        '      "speech_text": null,\n'
        '      "chosen": false,\n'
        '      "default": true,\n'
        '      "acceptable": true,\n'
        '      "refusal": null\n'
        "    }\n"
        "  ]\n"
        "}"
    },
    ("takes-ok", "service"): {
        "keys": [
            "suggestion_id",
            "kind",
            "status",
            "selectable",
            "selected_take",
            "default_take",
            "takes",
        ],
        "returned": "dict",
    },
    ("takes-ok", "web"): {
        "body": '{"suggestion_id":"ss-aaaaaaaaaaaa","kind":"replace","status":"pending","selectable":true,"selected_take":null,"default_take":2,"takes":[{"take_index":0,"duration_s":1.0,"tracks":[{"track_id":"host","track_label":"Host","duration_s":1.0,"segments":1}],"word_count":null,"speech_text":null,"chosen":false,"default":false,"acceptable":true,"refusal":null},{"take_index":1,"duration_s":2.5,"tracks":[{"track_id":"host","track_label":"Host","duration_s":2.5,"segments":1}],"word_count":null,"speech_text":null,"chosen":false,"default":false,"acceptable":true,"refusal":null},{"take_index":2,"duration_s":3.5,"tracks":[{"track_id":"host","track_label":"Host","duration_s":3.5,"segments":1}],"word_count":null,"speech_text":null,"chosen":false,"default":true,"acceptable":true,"refusal":null}]}',
        "error_code": None,
        "status": 200,
    },
    ("takes-unknown-id", "cli"): {
        "exit_code": 1,
        "stderr": "unknown session suggestion: ss-nope. List the staged "
        "sessions to see their ids. (code "
        "session_suggestion_not_found)\n",
        "stdout": "",
    },
    ("takes-unknown-id", "mcp"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "CodedKeyError",
    },
    ("takes-unknown-id", "service"): {
        "code": "session_suggestion_not_found",
        "message": "unknown session suggestion: ss-nope. List the "
        "staged sessions to see their ids.",
        "raised": "CodedKeyError",
    },
    ("takes-unknown-id", "web"): {
        "body": '{"detail":"unknown session suggestion: ss-nope. List '
        'the staged sessions to see their ids."}',
        "error_code": "session_suggestion_not_found",
        "status": 404,
    },
}

_ORDERS = [
    (name, surface) for name, (_, _, surfaces) in ORDER_CASES.items() for surface in surfaces
]
_SHAPES = [
    (name, surface) for name, (_, _, surfaces, _) in SHAPE_CASES.items() for surface in surfaces
]


@pytest.mark.parametrize(("name", "surface"), _ORDERS)
def test_result_key_order(ws, name, surface):
    build, step, _ = ORDER_CASES[name]
    sid = build(ws)
    if name == "skip-twice":
        call("service", ws, step, sid)
    expected = ORDER_OVERRIDES.get((name, surface), EXPECTED_ORDERS[name])
    assert dump(order_of(raw(surface, ws, step, sid))) == dump(expected)


@pytest.mark.parametrize(("name", "surface"), _SHAPES)
def test_surface_shape(ws, name, surface):
    from contextlib import nullcontext

    build, step, _, extra = SHAPE_CASES[name]
    sid = build(ws)
    if extra == "twice":
        call("service", ws, step, sid)
    with extra() if callable(extra) else nullcontext():
        assert dump(shape(surface, ws, step, sid)) == dump(EXPECTED_SHAPES[(name, surface)])


def test_service_results_are_plain_dicts_and_lists(ws):
    from podcast_mcp.services.document import SessionSuggestionService

    service = SessionSuggestionService(ws)
    sid = _three(ws)
    listed = service.list()
    assert type(listed) is list and type(listed[0]) is dict
    assert type(listed[0]["takes"]) is list and type(listed[0]["takes"][0]) is dict
    takes = service.takes(sid)
    assert type(takes) is dict and type(takes["takes"]) is list
    assert all(type(row) is dict and type(row["tracks"][0]) is dict for row in takes["takes"])
    picked = service.select_take(sid, 1)
    assert type(picked) is dict and type(picked["suggestion"]) is dict
    accepted = service.accept(sid)
    assert type(accepted) is dict and type(accepted["suggestion"]) is dict
    assert type(accepted["clips"]) is list and type(accepted["clips"][0]) is dict
    assert type(accepted["discarded_takes"]) is list and type(accepted["comments"]) is list
    skipped = SessionSuggestionService(ws)
    stage_replace(ws, 6.0, 8.0, {0: [("host", 0.0, 1.0)]}, session_id="b" * 12, number=2)
    assert type(skipped.skip(SECOND)) is dict


def test_accept_naming_override_appends_how_to_apply_to_a_held_replace(ws):
    from podcast_mcp.services.document import SessionSuggestionService

    sid = _held(ws)
    baseline = history_steps(ws)
    result = SessionSuggestionService(ws).accept_naming_override(sid)
    assert list(result) == ["operation", "unchanged", "needs_confirmation", "apply_anyway"]
    assert result["needs_confirmation"]["message"] == (
        'Replacing this range also removes 2 words from Guest: "so plan". '
        "Replace anyway to apply it; undo brings it back. "
        "To apply it as is, repeat the call with override_audio_checks=true "
        "(CLI --override-audio-checks)."
    )
    assert result["apply_anyway"] == (
        "To apply it as is, repeat the call with override_audio_checks=true "
        "(CLI --override-audio-checks)."
    )
    again = SessionSuggestionService(ws).accept_naming_override(sid)
    assert again["needs_confirmation"]["message"] == result["needs_confirmation"]["message"]
    assert history_steps(ws) == baseline


def test_plain_accept_leaves_the_held_message_without_the_how_to_apply(ws):
    from podcast_mcp.services.document import SessionSuggestionService

    sid = _held(ws)
    result = SessionSuggestionService(ws).accept(sid)
    assert result["needs_confirmation"]["message"] == (
        'Replacing this range also removes 2 words from Guest: "so plan". '
        "Replace anyway to apply it; undo brings it back."
    )


def test_accept_naming_override_with_the_flag_applies_and_adds_no_message(ws):
    from podcast_mcp.services.document import SessionSuggestionService

    sid = _held(ws)
    result = SessionSuggestionService(ws).accept_naming_override(
        sid, take_index=1, override_audio_checks=True
    )
    assert "needs_confirmation" not in result
    assert (result["take_index"], result["discarded_takes"], result["delta_s"]) == (1, [0], 1.0)
    assert result["suggestion"]["status"] == "accepted"


def test_accept_naming_override_on_a_clear_replace_and_an_insert_changes_nothing(ws):
    from podcast_mcp.services.document import SessionSuggestionService

    sid = _insert(ws)
    result = SessionSuggestionService(ws).accept_naming_override(sid)
    assert list(result) == [
        "suggestion",
        "at_sec",
        "span_s",
        "clips",
        "comments",
        "unmoved_track_ids",
    ]
    assert (result["at_sec"], result["span_s"]) == (4.0, 2.5)


def test_accept_naming_override_refuses_as_accept_does(ws):
    from podcast_mcp.services.document import SessionSuggestionService
    from podcast_mcp.util.coded_error import CodedValueError

    sid = _insert(ws)
    with pytest.raises(CodedValueError) as refused:
        SessionSuggestionService(ws).accept_naming_override(sid, take_index=0)
    assert refused.value.code == "take_not_applicable"


def test_a_take_index_of_true_is_not_a_take_number(ws):
    from podcast_mcp.services.document import SessionSuggestionService
    from podcast_mcp.util.coded_error import CodedValueError

    sid = _three(ws)
    with pytest.raises(CodedValueError) as refused:
        SessionSuggestionService(ws).accept(sid, take_index=True)
    assert (refused.value.code, str(refused.value)) == (
        "take_not_found",
        "Session 1 has no take True. Pick one of: 0, 1, 2.",
    )


def test_relayed_requests_are_refused_on_both_routes_and_change_nothing(ws):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    sid = _three(ws)
    query = {"path": str(ws.path), "suggestion_id": sid}
    relayed = {"x-sharecut-relayed": "1"}
    with TestClient(create_app()) as client:
        got = client.get("/api/session-suggestion/takes", params=query, headers=relayed)
        posted = client.post(
            "/api/session-suggestion/select-take",
            params={**query, "take_index": 0},
            headers=relayed,
        )
    assert (got.status_code, posted.status_code) == (403, 403)
    assert call("service", ws, Step("takes"), sid)["ok"]["selected_take"] is None


def test_a_missing_suggestion_id_is_a_validation_error_on_the_routes(ws):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    _three(ws)
    with TestClient(create_app()) as client:
        got = client.get("/api/session-suggestion/takes", params={"path": str(ws.path)})
        posted = client.post(
            "/api/session-suggestion/select-take",
            params={"path": str(ws.path), "suggestion_id": "ss-x", "take_index": "x"},
        )
    assert (got.status_code, posted.status_code) == (422, 422)
