"""Wire JSON of the three word flag commands stays exactly as clients read it (#1811)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.models import (
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand


def assert_wire(actual: dict, expected: dict) -> None:
    assert json.dumps(actual) == json.dumps(expected)


def _words(texts: list[str], *, ignored: frozenset[int] = frozenset()) -> list[TranscriptWord]:
    return [
        TranscriptWord(
            text=text,
            start=i * 0.5,
            end=i * 0.5 + 0.4,
            confidence=0.9,
            ignored=i in ignored,
        )
        for i, text in enumerate(texts)
    ]


def _seed(project_path: Path, transcripts: list[Transcript]) -> None:
    project = load_project(project_path)
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.transcripts = transcripts
    save_project(project, project_path)


@pytest.fixture
def single_take(minimal_project: Path) -> Path:
    _seed(
        minimal_project,
        [
            Transcript(
                track_id="host",
                source_id="take-a",
                words=_words(["café", "naïve", "plain", "tail"], ignored=frozenset({3})),
            )
        ],
    )
    return minimal_project


@pytest.fixture
def no_take(minimal_project: Path) -> Path:
    _seed(
        minimal_project,
        [Transcript(track_id="host", words=_words(["café", "naïve", "plain", "tail"]))],
    )
    return minimal_project


@pytest.fixture
def multi_take(minimal_project: Path) -> Path:
    _seed(
        minimal_project,
        [
            Transcript(track_id="host", source_id="take-a", words=_words(["one", "two"])),
            Transcript(
                track_id="host",
                source_id="take-b",
                words=_words(["naïve", "café", "plain"], ignored=frozenset({2})),
            ),
        ],
    )
    return minimal_project


def _submit(project_path: Path, command_type: str, payload: dict) -> dict:
    svc = DocumentSyncService.open(project_path)
    reply = svc.submit(
        DocumentCommand(
            type=command_type, payload=payload, client_id="c1", role="viewer", client_seq=1
        )
    )
    assert reply["ok"]
    result = reply["command"]["payload"]["result"]
    retry = svc.submit(
        DocumentCommand(
            type=command_type, payload=payload, client_id="c1", role="viewer", client_seq=1
        )
    )
    assert retry["command"]["payload"]["result"] == result
    return result


def test_suppressed_reply_on_single_take_names_the_take_and_keeps_non_ascii_text(
    single_take,
) -> None:
    result = _submit(
        single_take,
        "SetTranscriptWordSuppressed",
        {"track_id": "host", "word_index": 0, "suppressed": True},
    )
    assert_wire(
        result,
        {
            "track_id": "host",
            "source_id": "take-a",
            "word_index": 0,
            "suppressed": True,
            "text": "café",
        },
    )
    assert list(result) == ["track_id", "source_id", "word_index", "suppressed", "text"]


def test_suppressed_reply_on_multi_take_lane_echoes_the_addressed_take(multi_take) -> None:
    result = _submit(
        multi_take,
        "SetTranscriptWordSuppressed",
        {"track_id": "host", "word_index": 0, "suppressed": True, "source_id": "take-b"},
    )
    assert_wire(
        result,
        {
            "track_id": "host",
            "source_id": "take-b",
            "word_index": 0,
            "suppressed": True,
            "text": "naïve",
        },
    )


def test_unsuppressing_replies_with_suppressed_false(single_take) -> None:
    payload = {"track_id": "host", "word_index": 1, "suppressed": True}
    _submit(single_take, "SetTranscriptWordSuppressed", payload)
    svc = DocumentSyncService.open(single_take)
    reply = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={**payload, "suppressed": False},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert_wire(
        reply["command"]["payload"]["result"],
        {
            "track_id": "host",
            "source_id": "take-a",
            "word_index": 1,
            "suppressed": False,
            "text": "naïve",
        },
    )


def test_automatic_reply_on_single_take_reports_unlocked_and_still_suppressed(
    single_take,
) -> None:
    _submit(
        single_take,
        "SetTranscriptWordSuppressed",
        {"track_id": "host", "word_index": 0, "suppressed": True},
    )
    svc = DocumentSyncService.open(single_take)
    reply = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordAutomatic",
            payload={"track_id": "host", "word_index": 0},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    result = reply["command"]["payload"]["result"]
    assert_wire(
        result,
        {
            "track_id": "host",
            "source_id": "take-a",
            "word_index": 0,
            "suppressed": True,
            "audibility_locked": False,
            "text": "café",
        },
    )
    assert list(result) == [
        "track_id",
        "source_id",
        "word_index",
        "suppressed",
        "audibility_locked",
        "text",
    ]


def test_automatic_reply_on_multi_take_lane_echoes_the_addressed_take(multi_take) -> None:
    result = _submit(
        multi_take,
        "SetTranscriptWordAutomatic",
        {"track_id": "host", "word_index": 1, "source_id": "take-b"},
    )
    assert_wire(
        result,
        {
            "track_id": "host",
            "source_id": "take-b",
            "word_index": 1,
            "suppressed": False,
            "audibility_locked": False,
            "text": "café",
        },
    )


def test_ignored_reply_counts_every_word_flipped_on_a_single_take(single_take) -> None:
    result = _submit(
        single_take,
        "SetTranscriptWordsIgnored",
        {"track_id": "host", "start_word_index": 0, "end_word_index": 2, "ignored": True},
    )
    assert_wire(
        result,
        {
            "track_id": "host",
            "source_id": "take-a",
            "start_word_index": 0,
            "end_word_index": 2,
            "ignored": True,
            "changed": 3,
        },
    )
    assert list(result) == [
        "track_id",
        "source_id",
        "start_word_index",
        "end_word_index",
        "ignored",
        "changed",
    ]


def test_ignored_reply_reports_zero_changed_when_the_range_is_already_ignored(
    single_take,
) -> None:
    result = _submit(
        single_take,
        "SetTranscriptWordsIgnored",
        {"track_id": "host", "start_word_index": 3, "end_word_index": 3, "ignored": True},
    )
    assert_wire(
        result,
        {
            "track_id": "host",
            "source_id": "take-a",
            "start_word_index": 3,
            "end_word_index": 3,
            "ignored": True,
            "changed": 0,
        },
    )


def test_ignored_reply_on_multi_take_lane_counts_only_words_that_flipped(multi_take) -> None:
    result = _submit(
        multi_take,
        "SetTranscriptWordsIgnored",
        {
            "track_id": "host",
            "start_word_index": 1,
            "end_word_index": 2,
            "ignored": True,
            "source_id": "take-b",
        },
    )
    assert_wire(
        result,
        {
            "track_id": "host",
            "source_id": "take-b",
            "start_word_index": 1,
            "end_word_index": 2,
            "ignored": True,
            "changed": 1,
        },
    )


def test_flag_replies_on_a_word_with_no_take_carry_null_source_id(no_take) -> None:
    svc = DocumentSyncService.open(no_take)
    commands = [
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={"track_id": "host", "word_index": 0, "suppressed": True},
            client_id="c1",
            role="viewer",
            client_seq=1,
        ),
        DocumentCommand(
            type="SetTranscriptWordAutomatic",
            payload={"track_id": "host", "word_index": 0},
            client_id="c1",
            role="viewer",
            client_seq=2,
        ),
        DocumentCommand(
            type="SetTranscriptWordsIgnored",
            payload={
                "track_id": "host",
                "start_word_index": 0,
                "end_word_index": 1,
                "ignored": True,
            },
            client_id="c1",
            role="viewer",
            client_seq=3,
        ),
    ]
    replies = [svc.submit(command) for command in commands]
    assert all(reply["ok"] for reply in replies)
    suppressed, automatic, ignored = (reply["command"]["payload"]["result"] for reply in replies)

    assert_wire(
        suppressed,
        {
            "track_id": "host",
            "source_id": None,
            "word_index": 0,
            "suppressed": True,
            "text": "café",
        },
    )
    assert_wire(
        automatic,
        {
            "track_id": "host",
            "source_id": None,
            "word_index": 0,
            "suppressed": True,
            "audibility_locked": False,
            "text": "café",
        },
    )
    assert_wire(
        ignored,
        {
            "track_id": "host",
            "source_id": None,
            "start_word_index": 0,
            "end_word_index": 1,
            "ignored": True,
            "changed": 2,
        },
    )
