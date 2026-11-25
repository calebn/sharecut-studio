"""Pin the wire output of word timing (#1811) before any refactor.

``TranscriptService.word_timing_context`` and ``set_word_timing`` must keep their exact
key set, key order, value types, messages and error codes at every edge that carries them:
GUI route, CLI, MCP tool, guest ops, guest GUI route, guest MCP tool and the document-sync
handler with its journal result. Run-dependent values (the 64-hex ``expected_token`` and the
20-hex waveform ``cache_key``, both derived from file revisions) are replaced by placeholders
in the literals and checked for shape and for the exact hash recipe instead.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from dataclasses import asdict
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.transcript_timing import (
    TranscriptTimingChangedError,
    WordTimingMedia,
    WordTimingTarget,
)
from podcast_mcp.gui.schemas import GuestWordTimingContextRequest
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.transcript import set_word_timing_tool
from podcast_mcp.models import Transcript, TranscriptWord
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import guest_word_timing_context
from podcast_mcp.services.document import TranscriptService
from podcast_mcp.services.document_sync import DocumentSyncService, submit_host_document_command
from podcast_mcp.services.document_sync.handlers.transcript import set_transcript_word_timing
from podcast_mcp.services.remote_mcp import tools as remote_tools
from podcast_mcp.services.remote_mcp.context import (
    clear_remote_mcp_context,
    resolve_remote_mcp_context,
    set_remote_mcp_context,
)
from podcast_mcp.util.coded_error import CodedValueError
from test_transcript_timing import workspace

pytestmark = pytest.mark.unscoped_ok

TOKEN = "<TOKEN>"
CACHE_KEY = "<CACHE_KEY>"
ERROR_HEADER = "x-sharecut-error-code"

CONTEXT_KEYS = [
    "target",
    "expected_token",
    "word",
    "neighbors",
    "media",
    "window",
    "warnings",
    "transcript_gate",
]
TARGET_KEYS = ["track_id", "source_id", "word_index"]
WORD_KEYS = [
    "text",
    "start",
    "end",
    "confidence",
    "suppressed",
    "audibility_status",
    "dominant_track",
    "speaker_match_track",
    "speaker_match_score",
    "suspect_hallucination",
    "alignment_score",
    "trimmed_from",
    "snapped_from",
    "timing_edited",
    "overlong",
    "ignored",
    "audibility_locked",
]
NEIGHBOR_KEYS = ["word_index", "text", "start", "end"]
MEDIA_KEYS = ["ref", "duration_sec", "sample_rate", "cache_key"]
WINDOW_KEYS = ["start", "end"]

CHANGED_MSG = "This word changed. Select it again before adjusting timing."
SOURCE_CHANGED_MSG = "This source word changed. Reopen Adjust timing."
STALE_MSG = "The transcript or recording changed. Reopen Adjust timing before saving."
UNAVAILABLE_MSG = "This recording is unavailable. Reopen Adjust timing."
NOT_FINITE_MSG = "Word times must be finite source seconds. Pass finite start and end seconds."
NO_DURATION_MSG = (
    "Recording duration is unavailable. Wait for its waveform, then reopen Adjust timing."
)
INVALID_MSG = "Word timing must have a positive span within this recording."
GUEST_CHANGED_MSG = "This word changed. Select it again before adjusting its timing."
OVERLAP_PREV = "This word overlaps the previous word."
OVERLAP_NEXT = "This word overlaps the next word."

EXTRA = WordTimingTarget("host", "extra", 1)
PRIMARY = WordTimingTarget("host", None, 0)


# --- literal builders ---------------------------------------------------------------------


def word(text="same", start=1.0, end=2.0, **over):
    row = {
        "text": text,
        "start": start,
        "end": end,
        "confidence": None,
        "suppressed": False,
        "audibility_status": None,
        "dominant_track": None,
        "speaker_match_track": None,
        "speaker_match_score": None,
        "suspect_hallucination": False,
        "alignment_score": None,
        "trimmed_from": None,
        "snapped_from": None,
        "timing_edited": False,
        "overlong": False,
        "ignored": False,
        "audibility_locked": False,
    }
    row.update(over)
    assert list(row) == WORD_KEYS
    return row


def row(index, text, start, end):
    return {"word_index": index, "text": text, "start": start, "end": end}


def target_dict(target):
    return {
        "track_id": target.track_id,
        "source_id": target.source_id,
        "word_index": target.word_index,
    }


def literal(target, word_row, neighbors, media, window, warnings=(), gate=False):
    return {
        "target": target_dict(target),
        "expected_token": TOKEN,
        "word": word_row,
        "neighbors": neighbors,
        "media": media,
        "window": window,
        "warnings": list(warnings),
        "transcript_gate": gate,
    }


def media_view(ref, duration=10.0, rate=1000):
    return {"ref": ref, "duration_sec": duration, "sample_rate": rate, "cache_key": CACHE_KEY}


EXTRA_FLAGS = {"suspect_hallucination": True, "alignment_score": 0.3, "ignored": True}
EXTRA_FLAGS["audibility_locked"] = True
EXTRA_ROWS = [row(0, "before", 0.0, 1.0), row(1, "same", 1.0, 2.0), row(2, "after", 2.0, 3.0)]


def extra_literal(**kw):
    base = literal(
        EXTRA,
        word(**EXTRA_FLAGS),
        EXTRA_ROWS,
        media_view("source:extra"),
        {"start": 0.0, "end": 3.0},
    )
    base.update(kw)
    return base


PRIMARY_LITERAL = literal(
    PRIMARY,
    word(),
    [row(0, "same", 1.0, 2.0)],
    media_view("track:host"),
    {"start": 0.0, "end": 3.0},
)

# --- normalising run-dependent hashes -----------------------------------------------------


def norm(ctx):
    """Replace the two run-dependent hashes by placeholders after checking their shape."""
    out = copy.deepcopy(ctx)
    assert re.fullmatch(r"[0-9a-f]{64}", out["expected_token"])
    assert re.fullmatch(r"[0-9a-f]{20}", out["media"]["cache_key"])
    out["expected_token"] = TOKEN
    out["media"]["cache_key"] = CACHE_KEY
    return out


def denorm(expected, ctx):
    out = copy.deepcopy(expected)
    out["expected_token"] = ctx["expected_token"]
    out["media"]["cache_key"] = ctx["media"]["cache_key"]
    return out


def wire(data):
    """JSON text with key order and float/int/bool types kept."""
    return json.dumps(data)


def assert_pinned(ctx, expected):
    assert wire(norm(ctx)) == wire(expected)


def type_names(value):
    if isinstance(value, dict):
        return {k: type_names(v) for k, v in value.items()}
    if isinstance(value, list):
        return [type_names(v) for v in value]
    return type(value).__name__


def put_words(ws, specs, *, duration=10.0, rate=1000):
    ws.project.transcripts[1] = Transcript(
        track_id="host",
        source_id="extra",
        words=[TranscriptWord(text=t, start=s, end=e) for t, s, e in specs],
    )
    ws.project.sources[0].duration_sec = duration
    ws.project.sources[0].sample_rate = rate
    ws.save()


def run(project_path):
    return ProjectWorkspace.open(project_path)


# --- context: keys, order, types ----------------------------------------------------------


def test_context_literal_exact_source_word(minimal_project):
    ws = workspace(minimal_project)
    ctx = TranscriptService(ws).word_timing_context(EXTRA).model_dump()
    assert list(ctx) == CONTEXT_KEYS
    assert list(ctx["target"]) == TARGET_KEYS
    assert list(ctx["word"]) == WORD_KEYS
    assert all(list(r) == NEIGHBOR_KEYS for r in ctx["neighbors"])
    assert list(ctx["media"]) == MEDIA_KEYS
    assert list(ctx["window"]) == WINDOW_KEYS
    assert_pinned(ctx, extra_literal())


def test_context_literal_primary_word(minimal_project):
    ctx = TranscriptService(workspace(minimal_project)).word_timing_context(PRIMARY).model_dump()
    assert_pinned(ctx, PRIMARY_LITERAL)


def test_context_value_types(minimal_project):
    ctx = TranscriptService(workspace(minimal_project)).word_timing_context(EXTRA).model_dump()
    shape = type_names(ctx)
    assert shape["target"] == {"track_id": "str", "source_id": "str", "word_index": "int"}
    assert shape["expected_token"] == "str"
    assert shape["word"]["text"] == "str"
    assert shape["word"]["start"] == shape["word"]["end"] == "float"
    assert shape["word"]["confidence"] == "NoneType"
    assert shape["word"]["alignment_score"] == "float"
    assert {shape["word"][k] for k in WORD_KEYS if isinstance(ctx["word"][k], bool)} == {"bool"}
    assert (
        shape["neighbors"]
        == [{"word_index": "int", "text": "str", "start": "float", "end": "float"}] * 3
    )
    assert shape["media"] == {
        "ref": "str",
        "duration_sec": "float",
        "sample_rate": "int",
        "cache_key": "str",
    }
    assert shape["window"] == {"start": "float", "end": "float"}
    assert shape["warnings"] == []
    assert shape["transcript_gate"] == "bool"


def test_primary_target_source_id_is_none_on_wire(minimal_project):
    ctx = TranscriptService(workspace(minimal_project)).word_timing_context(PRIMARY).model_dump()
    assert ctx["target"] == {"track_id": "host", "source_id": None, "word_index": 0}
    assert type_names(ctx["target"])["source_id"] == "NoneType"


def test_token_is_sha256_of_sorted_body(minimal_project):
    ws = workspace(minimal_project)
    svc = TranscriptService(ws)
    first = svc.word_timing_context(EXTRA).model_dump()
    assert svc.word_timing_context(EXTRA).model_dump() == first
    from podcast_mcp.services.document.transcript_timing import word_timing_media

    media = word_timing_media(ws.project, EXTRA)
    assert isinstance(media, WordTimingMedia)
    body = {
        "target": asdict(EXTRA),
        "words": [w.model_dump(mode="json") for w in ws.project.transcripts[1].words],
        "media": asdict(media),
    }
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, allow_nan=False).encode()).hexdigest()
    assert first["expected_token"] == digest
    assert first["media"] == media.view()
    assert list(asdict(media)) == ["ref", "duration_sec", "sample_rate", "cache_key", "identity"]


# --- neighbors ----------------------------------------------------------------------------


def nine_words():
    return [(f"w{i}", float(i), i + 0.5) for i in range(9)]


@pytest.mark.parametrize(
    ("index", "first", "last"),
    [
        (0, 0, 3),
        (1, 0, 4),
        (2, 0, 5),
        (3, 0, 6),
        (4, 1, 7),
        (5, 2, 8),
        (6, 3, 8),
        (7, 4, 8),
        (8, 5, 8),
    ],
)
def test_neighbors_clip_to_three_each_side(minimal_project, index, first, last):
    ws = workspace(minimal_project)
    put_words(ws, nine_words())
    ctx = (
        TranscriptService(ws)
        .word_timing_context(WordTimingTarget("host", "extra", index))
        .model_dump()
    )
    assert ctx["neighbors"] == [row(i, f"w{i}", float(i), i + 0.5) for i in range(first, last + 1)]
    assert wire(ctx["neighbors"]) == wire(
        [row(i, f"w{i}", float(i), i + 0.5) for i in range(first, last + 1)]
    )
    assert ctx["word"]["text"] == f"w{index}"


def test_neighbors_single_word_transcript_start_and_end(minimal_project):
    ws = workspace(minimal_project)
    put_words(ws, [("only", 4.0, 5.0)])
    ctx = (
        TranscriptService(ws).word_timing_context(EXTRA.__class__("host", "extra", 0)).model_dump()
    )
    assert ctx["neighbors"] == [row(0, "only", 4.0, 5.0)]
    assert ctx["window"] == {"start": 3.0, "end": 6.0}


# --- media duration and window ------------------------------------------------------------


def test_media_duration_none_and_window_unbounded(minimal_project):
    ws = workspace(minimal_project)
    ws.project.sources[0].duration_sec = None
    ws.save()
    ctx = TranscriptService(ws).word_timing_context(EXTRA).model_dump()
    assert_pinned(
        ctx,
        extra_literal(
            media=media_view("source:extra", duration=None, rate=1000),
            window={"start": 0.0, "end": 3.0},
        ),
    )
    assert type_names(ctx["media"])["duration_sec"] == "NoneType"


def test_media_duration_and_rate_none(minimal_project):
    ws = workspace(minimal_project)
    ws.project.sources[0].duration_sec = None
    ws.project.sources[0].sample_rate = None
    ws.save()
    ctx = TranscriptService(ws).word_timing_context(EXTRA).model_dump()
    assert ctx["media"]["duration_sec"] is None
    assert ctx["media"]["sample_rate"] is None
    assert ctx["window"] == {"start": 0.0, "end": 3.0}


@pytest.mark.parametrize(
    ("spec", "duration", "window"),
    [
        (("late", 9.5, 9.9), 10.0, {"start": 8.5, "end": 10.0}),
        (("late", 9.5, 9.9), None, {"start": 8.5, "end": 10.9}),
        (("early", 0.2, 0.4), 10.0, {"start": 0.0, "end": 2.0}),
        (("short", 0.1, 0.2), 0.5, {"start": 0.0, "end": 0.5}),
        (("tail", 9.9, 10.0), 10.0, {"start": 8.9, "end": 10.0}),
    ],
)
def test_window_policy(minimal_project, spec, duration, window):
    ws = workspace(minimal_project)
    put_words(ws, [spec], duration=duration)
    ctx = (
        TranscriptService(ws).word_timing_context(WordTimingTarget("host", "extra", 0)).model_dump()
    )
    assert wire(ctx["window"]) == wire(window)
    assert ctx["media"]["duration_sec"] == duration


def test_transcript_gate_true(minimal_project):
    ws = workspace(minimal_project)
    ws.project.tracks[0].transcript_gate = True
    ws.save()
    ctx = TranscriptService(ws).word_timing_context(EXTRA).model_dump()
    assert ctx["transcript_gate"] is True
    assert_pinned(ctx, extra_literal(transcript_gate=True))


# --- warnings -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("specs", "index", "warnings"),
    [
        ([("a", 0.0, 1.0), ("b", 1.0, 2.0), ("c", 2.0, 3.0)], 1, []),
        ([("a", 0.0, 1.5), ("b", 1.0, 2.0), ("c", 2.0, 3.0)], 1, [OVERLAP_PREV]),
        ([("a", 0.0, 1.0), ("b", 1.0, 2.0), ("c", 1.5, 3.0)], 1, [OVERLAP_NEXT]),
        (
            [("a", 0.0, 1.5), ("b", 1.0, 2.0), ("c", 1.5, 3.0)],
            1,
            [OVERLAP_PREV, OVERLAP_NEXT],
        ),
        ([("a", 0.0, 1.5), ("b", 1.0, 2.0)], 0, [OVERLAP_NEXT]),
        ([("a", 0.0, 1.5), ("b", 1.0, 2.0)], 1, [OVERLAP_PREV]),
        ([("a", 0.0, 0.5), ("b", 1.0, 2.0)], 1, []),
        ([("a", 0.0, 2.5), ("b", 1.0, 2.0)], 0, [OVERLAP_NEXT]),
    ],
)
def test_warning_variants(minimal_project, specs, index, warnings):
    ws = workspace(minimal_project)
    put_words(ws, specs)
    ctx = (
        TranscriptService(ws)
        .word_timing_context(WordTimingTarget("host", "extra", index))
        .model_dump()
    )
    assert wire(ctx["warnings"]) == wire(warnings)
    assert all(type(w) is str for w in ctx["warnings"])


# --- context expectation / lookup errors --------------------------------------------------


@pytest.mark.parametrize(
    "kwargs",
    [
        {"expected_text": "other"},
        {"expected_start": 1.5},
        {"expected_end": 2.5},
        {"expected_text": "same", "expected_start": 1, "expected_end": 3},
    ],
)
def test_expected_mismatch_message(minimal_project, kwargs):
    svc = TranscriptService(workspace(minimal_project))
    with pytest.raises(TranscriptTimingChangedError) as caught:
        svc.word_timing_context(EXTRA, **kwargs)
    assert str(caught.value) == CHANGED_MSG
    assert caught.value.code == "transcript_timing_changed"
    assert isinstance(caught.value, ValueError)


def test_expected_values_that_hold_or_absent_pass(minimal_project):
    svc = TranscriptService(workspace(minimal_project))
    full = svc.word_timing_context(EXTRA).model_dump()
    assert svc.word_timing_context(EXTRA, expected_text="same").model_dump() == full
    assert svc.word_timing_context(EXTRA, expected_start=1, expected_end=2).model_dump() == full
    assert (
        svc.word_timing_context(EXTRA, expected_text="same", expected_start=1.0).model_dump()
        == full
    )


@pytest.mark.parametrize(
    "target",
    [
        WordTimingTarget("host", "alias", 0),
        WordTimingTarget("host", "extra", 3),
        WordTimingTarget("host", "extra", -1),
        WordTimingTarget("nope", None, 0),
        WordTimingTarget("host", "missing", 0),
    ],
)
def test_unknown_target_message(minimal_project, target):
    svc = TranscriptService(workspace(minimal_project))
    with pytest.raises(TranscriptTimingChangedError) as caught:
        svc.word_timing_context(target)
    assert str(caught.value) == SOURCE_CHANGED_MSG
    with pytest.raises(TranscriptTimingChangedError) as caught:
        svc.set_word_timing(target, "t", 1, 2)
    assert str(caught.value) == SOURCE_CHANGED_MSG


def test_context_missing_recording_file_is_file_not_found(minimal_project):
    ws = workspace(minimal_project)
    (ws.project.raw_dir() / "extra.wav").unlink()
    with pytest.raises(FileNotFoundError) as caught:
        TranscriptService(ws).word_timing_context(EXTRA)
    assert str(caught.value) == "The source recording is unavailable."


# --- set_word_timing ----------------------------------------------------------------------


def test_set_changed_true_exact_wire(minimal_project):
    ws = workspace(minimal_project)
    svc = TranscriptService(ws)
    shown = svc.word_timing_context(EXTRA).model_dump()
    result = svc.set_word_timing(EXTRA, shown["expected_token"], 1.25, 2.25).model_dump()
    assert list(result) == ["changed", "context"]
    assert result["changed"] is True
    assert list(result["context"]) == CONTEXT_KEYS
    after = extra_literal(
        word=word(
            start=1.25,
            end=2.25,
            ignored=True,
            audibility_locked=True,
            timing_edited=True,
        ),
        neighbors=[
            row(0, "before", 0.0, 1.0),
            row(1, "same", 1.25, 2.25),
            row(2, "after", 2.0, 3.0),
        ],
        window={"start": 0.25, "end": 3.25},
        warnings=[OVERLAP_NEXT],
    )
    assert_pinned(result["context"], after)
    assert result["context"]["expected_token"] != shown["expected_token"]
    assert svc.word_timing_context(EXTRA).model_dump() == result["context"]


def test_set_changed_false_exact_wire(minimal_project):
    ws = workspace(minimal_project)
    svc = TranscriptService(ws)
    shown = svc.word_timing_context(EXTRA).model_dump()
    result = svc.set_word_timing(EXTRA, shown["expected_token"], 1, 2).model_dump()
    assert list(result) == ["changed", "context"]
    assert result["changed"] is False
    assert result["context"] == shown
    assert wire(result["context"]) == wire(shown)


def test_set_primary_changed_true_clears_automatic_verdict(minimal_project):
    ws = workspace(minimal_project)
    ws.project.transcripts[0].words[0].suppressed = True
    ws.project.transcripts[0].words[0].audibility_status = "foreign_only"
    ws.save()
    svc = TranscriptService(ws)
    shown = svc.word_timing_context(PRIMARY).model_dump()
    assert shown["word"]["suppressed"] is True
    result = svc.set_word_timing(PRIMARY, shown["expected_token"], 0.9, 2.0).model_dump()
    expected = literal(
        PRIMARY,
        word(start=0.9, end=2.0, timing_edited=True),
        [row(0, "same", 0.9, 2.0)],
        media_view("track:host"),
        {"start": 0.0, "end": 3.0},
    )
    assert result["changed"] is True
    assert_pinned(result["context"], expected)


def test_set_result_types(minimal_project):
    svc = TranscriptService(workspace(minimal_project))
    token = svc.word_timing_context(EXTRA).model_dump()["expected_token"]
    result = svc.set_word_timing(EXTRA, token, 1.1, 2.1).model_dump()
    shape = type_names(result)
    assert shape["changed"] == "bool"
    assert shape["context"]["window"] == {"start": "float", "end": "float"}
    assert shape["context"]["warnings"] == ["str"]


def test_set_integer_times_stored_as_given_and_context_float(minimal_project):
    svc = TranscriptService(workspace(minimal_project))
    token = svc.word_timing_context(EXTRA).model_dump()["expected_token"]
    result = svc.set_word_timing(EXTRA, token, 1, 3).model_dump()
    assert result["changed"] is True
    assert wire(result["context"]["word"]["end"]) == "3.0"


# --- set_word_timing errors ---------------------------------------------------------------


def test_stale_token_message_and_precedence(minimal_project):
    ws = workspace(minimal_project)
    svc = TranscriptService(ws)
    bad = "0" * 64
    for start, end in [(1.1, 2.1), (math.nan, 2), (1, math.inf), (-5, 99)]:
        with pytest.raises(TranscriptTimingChangedError) as caught:
            svc.set_word_timing(EXTRA, bad, start, end)
        assert str(caught.value) == STALE_MSG
        assert caught.value.code == "transcript_timing_changed"
    assert not ws.project.transcripts[1].user_edited


def test_stale_token_after_edit(minimal_project):
    ws = workspace(minimal_project)
    svc = TranscriptService(ws)
    old = svc.word_timing_context(EXTRA).model_dump()["expected_token"]
    svc.set_word_timing(EXTRA, old, 1.1, 2.1)
    with pytest.raises(TranscriptTimingChangedError) as caught:
        svc.set_word_timing(EXTRA, old, 1.2, 2.2)
    assert str(caught.value) == STALE_MSG


@pytest.mark.parametrize(
    ("start", "end"),
    [(math.nan, 2.0), (1.0, math.inf), (-math.inf, 2.0), (math.nan, math.nan), (1.0, -math.inf)],
)
def test_word_time_not_finite(minimal_project, start, end):
    ws = workspace(minimal_project)
    svc = TranscriptService(ws)
    token = svc.word_timing_context(EXTRA).model_dump()["expected_token"]
    with pytest.raises(CodedValueError) as caught:
        svc.set_word_timing(EXTRA, token, start, end)
    assert caught.value.code == "word_time_not_finite"
    assert str(caught.value) == NOT_FINITE_MSG
    assert isinstance(caught.value, ValueError)
    assert not ws.project.transcripts[1].user_edited


@pytest.mark.parametrize(
    ("start", "end"), [(-0.1, 2.0), (1.0, 10.5), (2.0, 1.0), (1.0, 1.0), (1.0, 1.0004)]
)
def test_word_timing_invalid(minimal_project, start, end):
    ws = workspace(minimal_project)
    svc = TranscriptService(ws)
    token = svc.word_timing_context(EXTRA).model_dump()["expected_token"]
    with pytest.raises(CodedValueError) as caught:
        svc.set_word_timing(EXTRA, token, start, end)
    assert caught.value.code == "word_timing_invalid"
    assert str(caught.value) == INVALID_MSG


def test_minimum_span_is_one_sample(minimal_project):
    svc = TranscriptService(workspace(minimal_project))
    token = svc.word_timing_context(EXTRA).model_dump()["expected_token"]
    assert svc.set_word_timing(EXTRA, token, 1.0, 1.001).model_dump()["changed"] is True


def test_recording_duration_unavailable_and_precedence(minimal_project):
    ws = workspace(minimal_project)
    ws.project.sources[0].duration_sec = None
    ws.save()
    svc = TranscriptService(ws)
    token = svc.word_timing_context(EXTRA).model_dump()["expected_token"]
    with pytest.raises(CodedValueError) as caught:
        svc.set_word_timing(EXTRA, token, 1.1, 2.1)
    assert caught.value.code == "recording_duration_unavailable"
    assert str(caught.value) == NO_DURATION_MSG
    with pytest.raises(CodedValueError) as caught:
        svc.set_word_timing(EXTRA, token, math.nan, 2.1)
    assert caught.value.code == "word_time_not_finite"


def test_recording_removed_after_context(minimal_project):
    ws = workspace(minimal_project)
    svc = TranscriptService(ws)
    token = svc.word_timing_context(EXTRA).model_dump()["expected_token"]
    (ws.project.raw_dir() / "extra.wav").unlink()
    with pytest.raises(TranscriptTimingChangedError) as caught:
        svc.set_word_timing(EXTRA, token, 1.1, 2.1)
    assert str(caught.value) == UNAVAILABLE_MSG


# --- edge helpers -------------------------------------------------------------------------

GUI_BODY = {
    "target": {"track_id": "host", "source_id": "extra", "word_index": 1},
    "expected_word": {"text": "same", "start": 1, "end": 2},
}


def compact(data):
    """What FastAPI's JSONResponse writes for a dict."""
    return json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()


@pytest.fixture
def rig(minimal_project):
    ws = workspace(minimal_project)
    return SimpleNamespace(ws=ws, path=minimal_project, client=TestClient(create_app()))


# --- GUI route ----------------------------------------------------------------------------


def test_gui_route_json_body_byte_equal(rig):
    res = rig.client.post(
        "/api/transcript/word-timing-context", json={**GUI_BODY, "path": str(rig.path)}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/json"
    ctx = res.json()
    assert res.content == compact(denorm(extra_literal(), ctx))
    assert res.content == compact(
        TranscriptService(run(rig.path)).word_timing_context(EXTRA).model_dump()
    )


def test_gui_route_primary_body(rig):
    body = {
        "path": str(rig.path),
        "target": {"track_id": "host", "source_id": None, "word_index": 0},
        "expected_word": {"text": "same", "start": 1, "end": 2},
    }
    res = rig.client.post("/api/transcript/word-timing-context", json=body)
    assert res.content == compact(denorm(PRIMARY_LITERAL, res.json()))


@pytest.mark.parametrize(
    ("patch", "status", "code", "detail"),
    [
        (
            {"expected_word": {"text": "x", "start": 1, "end": 2}},
            409,
            "transcript_timing_changed",
            CHANGED_MSG,
        ),
        (
            {"target": {"track_id": "host", "source_id": "extra", "word_index": 99}},
            409,
            "transcript_timing_changed",
            SOURCE_CHANGED_MSG,
        ),
        (
            {"target": {"track_id": "host", "source_id": "alias", "word_index": 0}},
            409,
            "transcript_timing_changed",
            SOURCE_CHANGED_MSG,
        ),
    ],
)
def test_gui_route_errors(rig, patch, status, code, detail):
    res = rig.client.post(
        "/api/transcript/word-timing-context", json={**GUI_BODY, **patch, "path": str(rig.path)}
    )
    assert res.status_code == status
    assert res.headers[ERROR_HEADER] == code
    assert res.content == compact({"detail": detail})


def test_gui_route_missing_recording_is_404(rig):
    (rig.ws.project.raw_dir() / "extra.wav").unlink()
    res = rig.client.post(
        "/api/transcript/word-timing-context", json={**GUI_BODY, "path": str(rig.path)}
    )
    assert res.status_code == 404
    assert res.headers[ERROR_HEADER] == "word_not_found"
    assert res.content == compact({"detail": "The source recording is unavailable."})


# --- CLI ----------------------------------------------------------------------------------


def cli_args(path, *extra):
    return [
        "transcript",
        "set-word-timing",
        "--project",
        str(path),
        "--track",
        "host",
        "--source",
        "extra",
        "--word-index",
        "1",
        *extra,
    ]


AFTER_WORD = word(start=1.25, end=2.25, ignored=True, audibility_locked=True, timing_edited=True)
AFTER_ROWS = [row(0, "before", 0.0, 1.0), row(1, "same", 1.25, 2.25), row(2, "after", 2.0, 3.0)]


def after_literal(changed=True):
    return {
        "changed": changed,
        "context": extra_literal(
            word=AFTER_WORD,
            neighbors=AFTER_ROWS,
            window={"start": 0.25, "end": 3.25},
            warnings=[OVERLAP_NEXT],
        ),
    }


def denorm_result(expected, result):
    return {
        "changed": expected["changed"],
        "context": denorm(expected["context"], result["context"]),
    }


def test_cli_changed_true_then_false(rig, monkeypatch):
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    first = CliRunner().invoke(
        cli_app, cli_args(rig.path, "--start", "1.25", "--end", "2.25", "--expected-text", "same")
    )
    assert first.exit_code == 0, first.output
    got = json.loads(first.stdout)
    assert list(got) == ["changed", "context"]
    assert first.stdout == json.dumps(denorm_result(after_literal(), got), indent=2) + "\n"
    assert norm(got["context"]) == after_literal()["context"]
    second = CliRunner().invoke(cli_app, cli_args(rig.path, "--start", "1.25", "--end", "2.25"))
    again = json.loads(second.stdout)
    assert second.stdout == json.dumps(denorm_result(after_literal(False), again), indent=2) + "\n"


def test_cli_stale_expected_text(rig, monkeypatch):
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    res = CliRunner().invoke(
        cli_app, cli_args(rig.path, "--start", "1.25", "--end", "2.25", "--expected-text", "zzz")
    )
    assert res.exit_code == 1
    assert res.output == (
        f"Error: {CHANGED_MSG} (code transcript_timing_changed) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert not run(rig.path).project.transcripts[1].user_edited


# --- MCP tool -----------------------------------------------------------------------------


def test_mcp_tool_changed_true_then_false(rig):
    first = set_word_timing_tool(str(rig.path), "host", 1, 1.25, 2.25, "extra", "same")
    got = json.loads(first)
    assert first == json.dumps(denorm_result(after_literal(), got), indent=2)
    second = set_word_timing_tool(str(rig.path), "host", 1, 1.25, 2.25, "extra")
    again = json.loads(second)
    assert second == json.dumps(denorm_result(after_literal(False), again), indent=2)


def test_mcp_tool_primary_without_expected_text(rig):
    out = json.loads(set_word_timing_tool(str(rig.path), "host", 0, 1, 2))
    assert out["changed"] is False
    assert norm(out["context"]) == PRIMARY_LITERAL


def test_mcp_tool_stale_expected_text_raises(rig):
    with pytest.raises(TranscriptTimingChangedError) as caught:
        set_word_timing_tool(str(rig.path), "host", 1, 1.25, 2.25, "extra", "zzz")
    assert str(caught.value) == CHANGED_MSG


# --- document-sync handler and journal ----------------------------------------------------


def test_handler_result_equals_service_wire(rig):
    token = TranscriptService(rig.ws).word_timing_context(EXTRA).model_dump()["expected_token"]
    payload = {"target": target_dict(EXTRA), "expected_token": token, "start": 1.25, "end": 2.25}
    result = set_transcript_word_timing(rig.ws, payload)
    assert list(result) == ["changed", "context"]
    assert result["changed"] is True
    assert wire(denorm_result(after_literal(), result)) == wire(result)
    again = set_transcript_word_timing(
        rig.ws, {**payload, "expected_token": result["context"]["expected_token"]}
    )
    assert wire(denorm_result(after_literal(False), again)) == wire(again)


def test_journal_result_for_set_word_timing(rig):
    token = TranscriptService(rig.ws).word_timing_context(EXTRA).model_dump()["expected_token"]
    reply = submit_host_document_command(
        rig.path,
        "SetTranscriptWordTiming",
        {"target": target_dict(EXTRA), "expected_token": token, "start": 1.25, "end": 2.25},
        client_id="pin",
    )
    rows = DocumentSyncService.open(rig.path).store.commands_after(0)
    assert [r["type"] for r in rows] == ["SetTranscriptWordTiming"]
    payload = rows[0]["payload"]
    assert list(payload) == ["target", "expected_token", "start", "end", "result"]
    assert payload["target"] == target_dict(EXTRA)
    assert payload["expected_token"] == token
    assert (payload["start"], payload["end"]) == (1.25, 2.25)
    result = payload["result"]
    assert wire(result) == wire(denorm_result(after_literal(), result))
    assert reply["command"]["payload"]["result"] == result


def test_journal_noop_result(rig):
    token = TranscriptService(rig.ws).word_timing_context(EXTRA).model_dump()["expected_token"]
    reply = submit_host_document_command(
        rig.path,
        "SetTranscriptWordTiming",
        {"target": target_dict(EXTRA), "expected_token": token, "start": 1.0, "end": 2.0},
        client_id="pin",
    )
    result = reply["command"]["payload"]["result"]
    assert result["changed"] is False
    assert norm(result["context"]) == extra_literal()


# --- guest edges --------------------------------------------------------------------------

GUEST_BODY = GUI_BODY


@pytest.fixture
def guest(rig, published_share):
    _, _, share = published_share()
    return SimpleNamespace(
        rig=rig,
        token=share["token"],
        url=lambda t: f"/api/review/{t}/daw/transcript/word-timing-context",
    )


def test_guest_ops_equals_host_service(rig):
    ws = run(rig.path)
    got = guest_word_timing_context(
        ws,
        target=target_dict(EXTRA),
        expected_text="same",
        expected_start=1,
        expected_end=2,
    )
    assert wire(got) == wire(TranscriptService(ws).word_timing_context(EXTRA).model_dump())
    assert_pinned(got, extra_literal())


@pytest.mark.parametrize(
    ("text", "start", "end"), [("x", 1, 2), ("same", 1.5, 2), ("same", 1, 2.5)]
)
def test_guest_ops_stale_expectation_refusal(rig, text, start, end):
    from podcast_mcp.services.collaboration.guest_project_ops import GuestRefusal

    with pytest.raises(GuestRefusal) as caught:
        guest_word_timing_context(
            run(rig.path),
            target=target_dict(EXTRA),
            expected_text=text,
            expected_start=start,
            expected_end=end,
        )
    assert caught.value.code == "transcript_timing_changed"
    assert caught.value.status == 409
    assert str(caught.value) == GUEST_CHANGED_MSG


def test_guest_gui_route_json_body_byte_equal(guest):
    client = guest.rig.client
    res = client.post(guest.url(guest.token), json=GUEST_BODY)
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/json"
    assert res.content == compact(denorm(extra_literal(), res.json()))
    host = client.post(
        "/api/transcript/word-timing-context", json={**GUI_BODY, "path": str(guest.rig.path)}
    )
    assert res.content == host.content


def test_guest_gui_route_refusals(guest):
    client = guest.rig.client
    stale = {**GUEST_BODY, "expected_word": {"text": "x", "start": 1, "end": 2}}
    res = client.post(guest.url(guest.token), json=stale)
    assert res.status_code == 409
    assert res.headers[ERROR_HEADER] == "transcript_timing_changed"
    assert res.content == compact({"detail": GUEST_CHANGED_MSG})
    gone = {**GUEST_BODY, "target": {"track_id": "host", "source_id": "alias", "word_index": 0}}
    res = client.post(guest.url(guest.token), json=gone)
    assert res.status_code == 409
    assert res.content == compact({"detail": GUEST_CHANGED_MSG})


def mcp_request(text="same", start=1, end=2):
    return GuestWordTimingContextRequest(
        target={"track_id": "host", "source_id": "extra", "word_index": 1},
        expected_word={"text": text, "start": start, "end": end},
    )


def test_guest_mcp_tool_matches_host_wire(guest):
    set_remote_mcp_context(resolve_remote_mcp_context(guest.token))
    try:
        got = remote_tools.guest_transcript_word_timing_context(mcp_request())
        assert list(got) == CONTEXT_KEYS
        assert_pinned(got, extra_literal())
        assert wire(got) == wire(
            TranscriptService(run(guest.rig.path)).word_timing_context(EXTRA).model_dump()
        )
        from podcast_mcp.services.collaboration.guest_project_ops import GuestRefusal

        with pytest.raises(GuestRefusal) as caught:
            remote_tools.guest_transcript_word_timing_context(mcp_request(text="x"))
        assert caught.value.code == "transcript_timing_changed"
        assert str(caught.value) == GUEST_CHANGED_MSG
    finally:
        clear_remote_mcp_context()


def test_every_edge_shares_one_key_order(guest):
    host = TranscriptService(run(guest.rig.path)).word_timing_context(EXTRA).model_dump()
    gui = guest.rig.client.post(
        "/api/transcript/word-timing-context", json={**GUI_BODY, "path": str(guest.rig.path)}
    ).json()
    shared = guest.rig.client.post(guest.url(guest.token), json=GUEST_BODY).json()
    for ctx in (host, gui, shared):
        assert list(ctx) == CONTEXT_KEYS
        assert list(ctx["word"]) == WORD_KEYS
        assert list(ctx["media"]) == MEDIA_KEYS
