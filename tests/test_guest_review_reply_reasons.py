import pytest

from podcast_mcp.services.document_sync.service import _review_reply_facts

GENERIC = "it could not be applied"


def _row(code, reason="x", label="Ana's cut at 0:02.5"):
    return {"id": "e1", "label": label, "reason": reason, "code": code}


def _guest_reason(row):
    result = {"count": 0, "held": [row]}
    return _review_reply_facts("ApproveEdits", result, "guest")["review_result"]["held"][0][
        "reason"
    ]


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (
            _row("peer_speech", "Ben is speaking where the session cut would remove it"),
            "someone else is speaking there and would be cut off",
        ),
        (
            _row("stale", "its audio was already cut away, so it no longer plays"),
            "its audio was already cut away, so it no longer plays",
        ),
        (
            _row("waits_with_held", "it sits right beside a held cut, so it waits with it"),
            "it sits right beside a held cut, so it waits with it",
        ),
        (
            _row("", "unsure_word"),
            "it has a word the transcript is not sure of",
        ),
        (
            _row("source_geometry", "the selected audio no longer has one complete placement"),
            "that part of the recording is no longer in one piece on the timeline",
        ),
        (_row("brand_new_code", "host wording"), GENERIC),
        (_row("", "host wording from an old journal row"), GENERIC),
        (_row("", "/home/host/Mic.wav is speaking where the session cut would remove it"), GENERIC),
        (
            _row("peer_speech", "/home/host/Mic.wav is speaking where it would cut"),
            "someone else is speaking there and would be cut off",
        ),
        (_row("brand_new_code", "C:\\Users\\x\\Mic.wav is speaking"), GENERIC),
    ],
)
def test_a_guest_hold_reason_is_always_a_plain_sentence(row, expected):
    assert _guest_reason(row) == expected


def test_a_path_named_speaker_never_reaches_the_guest_row():
    row = _row(
        "peer_speech", "/home/host/Mic.wav is speaking where the session cut would remove it"
    )
    held = _review_reply_facts("ApproveEdits", {"count": 0, "held": [row]}, "guest")[
        "review_result"
    ]["held"]
    assert held == [
        {
            "id": "e1",
            "label": "Ana's cut at 0:02.5",
            "reason": "someone else is speaking there and would be cut off",
        }
    ]


def test_a_row_without_a_code_from_an_old_journal_still_has_a_reason():
    row = {"id": "e1", "label": "x", "reason": "/home/host/Mic.wav is speaking there"}
    held = _review_reply_facts("ApproveEdits", {"count": 0, "held": [row]}, "guest")[
        "review_result"
    ]["held"]
    assert held[0]["reason"] == GENERIC


def test_the_host_keeps_the_raw_reason():
    row = _row("peer_speech", "Ben is speaking where the session cut would remove it")
    held = _review_reply_facts("ApproveEdits", {"count": 0, "held": [row]}, "host")[
        "review_result"
    ]["held"]
    assert held[0]["reason"] == "Ben is speaking where the session cut would remove it"
