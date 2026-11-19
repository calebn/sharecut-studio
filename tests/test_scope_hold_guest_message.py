from __future__ import annotations

from typing import get_args, get_type_hints

import pytest

from podcast_mcp.edits.cut_placement import CutScopeHold
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.timeline_ops import LaneUnavailable
from podcast_mcp.util.coded_error import guest_message_for_code
from podcast_mcp.util.redact import mentions_host_path

LABEL = "Reference's cut at 0:02.5"
SPEAKERS = {"reference": "Reference", "guest": "Guest"}

WHY_BY_REASON = {
    "acoustic_edge": "the edit would start or end inside a word or a breath, and that could be heard",
    "source_geometry": "that part of the recording is no longer in one piece on the timeline",
    "stored_track_pause": "a pause can only be shortened for the whole recording, not for one speaker",
    "speaker_bleed": "that sound is another speaker's voice on this microphone",
    "scope_unavailable": "the other speakers' audio could not be checked",
    "media_extent_unavailable": "the full recording is not available right now",
    "operation_scope": "other audio plays inside it that this edit would not remove",
    "pause_not_shorter": "it would not make the pause any shorter",
    "pause_imperceptible": "it would shorten the pause too little to hear",
    "pause_air": "it could not keep enough quiet room sound in the pause",
    "pause_join": "the pause would sound abrupt where it joins",
    "peer_speech": "Guest is speaking there and would be cut off",
}

ENGINEER_WORDS = ("edge", "geometry", "scope", "override", "MCP", "CLI", "conflict", "bleed")


def _refusal(reason, *, peers=("guest",), lanes=(), label=LABEL, speakers=None):
    hold = CutScopeHold("e1", peers, reason, tuple(lanes))
    cuts = {} if label is None else {"e1": label}
    return ScopeChangedAtApproval([hold], SPEAKERS if speakers is None else speakers, cuts)


def test_the_table_covers_every_hold_reason():
    assert set(
        get_args(
            get_type_hints(CutScopeHold, localns={"LaneUnavailable": LaneUnavailable})["reason"]
        )
    ) == set(WHY_BY_REASON)


@pytest.mark.parametrize("reason", sorted(WHY_BY_REASON))
def test_each_hold_reads_as_one_plain_sentence(reason):
    message = _refusal(reason).guest_message()
    assert (
        message == f"{LABEL} was not applied because {WHY_BY_REASON[reason]}. Nothing was changed."
    )
    assert not mentions_host_path(message)
    assert [w for w in ENGINEER_WORDS if w in message] == []


def test_the_host_text_is_unchanged():
    assert str(_refusal("media_extent_unavailable")) == (
        "Reference's cut at 0:02.5 was not applied because the full recording duration is "
        "unavailable. Select the part to cut on the timeline, or reject the held cuts."
    )


def test_two_holds_read_one_after_the_other():
    holds = [CutScopeHold("e1", (), "pause_air"), CutScopeHold("e2", (), "pause_join")]
    refusal = ScopeChangedAtApproval(
        holds,
        SPEAKERS,
        {"e1": "Guest's pause trim at 0:09.0", "e2": "Guest's pause trim at 0:12.4"},
    )
    assert refusal.guest_message() == (
        "Guest's pause trim at 0:09.0 was not applied because it could not keep enough quiet "
        "room sound in the pause. Guest's pause trim at 0:12.4 was not applied because the "
        "pause would sound abrupt where it joins. Nothing was changed."
    )


def test_an_unnamed_edit_and_an_unnamed_peer_still_read_plainly():
    message = _refusal("peer_speech", peers=("track_7",), label=None).guest_message()
    assert message == (
        "That edit was not applied because someone else is speaking there and would be cut off. "
        "Nothing was changed."
    )


def test_an_unreadable_lane_is_named_in_the_reason():
    lanes = [LaneUnavailable("guest", "media_extent_unavailable")]
    message = _refusal("scope_unavailable", lanes=lanes).guest_message()
    assert message == (
        f"{LABEL} was not applied because the other speakers' audio could not be checked "
        "(Guest has a recording whose length is unknown). Nothing was changed."
    )


@pytest.mark.parametrize("name", ["C:\\Users\\x", "/home/x"])
def test_a_path_in_a_speaker_name_is_never_shown(name):
    message = _refusal("speaker_bleed", label=f"{name}'s cut at 0:02.5").guest_message()
    assert message == (
        "That edit was not applied because that sound is another speaker's voice on this "
        "microphone. Nothing was changed."
    )
    peer = _refusal("peer_speech", speakers={"guest": name}).guest_message()
    assert peer == (
        f"{LABEL} was not applied because someone else is speaking there and would be cut off. "
        "Nothing was changed."
    )


def test_a_path_in_a_lane_name_falls_back_to_the_fixed_sentence():
    lanes = [LaneUnavailable("guest", "media_extent_unavailable")]
    message = _refusal(
        "scope_unavailable", lanes=lanes, speakers={"guest": "/home/x"}
    ).guest_message()
    assert message == guest_message_for_code("cut_scope_changed")
