from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import load_project
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.util.coded_error import CodedValueError
from test_shorten_gaps_tool_pin import (
    _HELD_WORDS,
    _HOST_GAP,
    _OVERRIDE,
    _SHORTENED,
    _entries,
    _history,
    _journal,
    _path,
    _registered,
    _run,
    _spans,
)
from test_shorten_gaps_tool_pin import (
    _config as _config,
)

_MANY_PAUSES = ([(float(i), i + 0.2) for i in range(6)], [(5.5, 5.6)])


def _rows(path: str) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


def test_no_registered_call_adds_an_external_mutate_row(tmp_path):
    for name, words in (("a", _HOST_GAP), ("b", _HELD_WORDS)):
        path = _path(tmp_path, words, name)
        _registered({"project_path": path, "use_inaudible_opt": False})
        _registered({"project_path": path, "max_gap_sec": 5.0})
        assert "ExternalMutate" not in _journal(path)
        assert set(_journal(path)) == {"ShortenWordGaps"}


def test_a_direct_call_journals_one_row_with_the_payload_and_the_reply(tmp_path):
    path = _path(tmp_path)
    reply = _run(path, use_inaudible_opt=False)
    (row,) = _rows(path)
    assert row["type"] == "ShortenWordGaps"
    stored = row["payload"]
    assert stored["max_gap_sec"] == 0.35
    assert stored["use_inaudible_opt"] is False
    assert stored["override_audio_checks"] is False
    assert stored["result"] == reply


def test_each_call_adds_exactly_one_row(tmp_path):
    path = _path(tmp_path)
    _run(path, 5.0)
    _run(path, use_inaudible_opt=False)
    _run(path, use_inaudible_opt=False)
    assert _journal(path) == ["ShortenWordGaps"] * 3


@pytest.mark.parametrize("bad", ["abc", None, math.nan, math.inf, -math.inf])
def test_a_bad_max_gap_is_a_coded_invalid_payload_and_writes_no_row(tmp_path, bad):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        mcp_timeline.shorten_gaps_tool(path, bad)
    assert raised.value.code == "invalid_payload"
    assert "max_gap_sec" in str(raised.value)
    assert Path(path).read_bytes() == before
    assert _journal(path) == []
    assert _history(path)["total"] == 0


def test_a_missing_project_writes_no_row_and_stays_project_not_found(tmp_path):
    missing = str(tmp_path / "nope")
    with pytest.raises(FileNotFoundError) as raised:
        mcp_timeline.shorten_gaps_tool(missing)
    assert raised.value.code == "project_not_found"


def test_the_payload_defaults():
    assert validate_payload("ShortenWordGaps", {}) == {
        "max_gap_sec": 0.35,
        "use_inaudible_opt": None,
        "override_audio_checks": False,
    }


def test_a_numeric_string_and_an_int_are_coerced_to_floats(tmp_path):
    path = _path(tmp_path, name="a")
    reply = _run(path, "0.25", use_inaudible_opt=False)
    assert reply["max_gap_sec"] == 0.25
    assert isinstance(reply["max_gap_sec"], float)
    whole = _run(_path(tmp_path, name="b"), 0, use_inaudible_opt=False)
    assert isinstance(whole["max_gap_sec"], float)


def test_the_override_actor_stays_the_mcp_host_in_history_and_the_edit_log(tmp_path):
    path = _path(tmp_path, _HELD_WORDS)
    _run(path, use_inaudible_opt=False, override_audio_checks=True)
    assert _entries(path)[1]["params"]["audio_check_override"] == _OVERRIDE
    (record,) = load_project(Path(path)).editorial.edit_log
    assert record.params["audio_check_override"] == _OVERRIDE
    assert _spans(path, "host") == [pytest.approx(row) for row in _SHORTENED]
    (row,) = _rows(path)
    assert row["payload"]["override_audio_checks"] is True
    assert "audio_check_override" not in row["payload"]


def test_the_journal_row_of_a_many_pause_project_stays_small(tmp_path):
    path = _path(tmp_path, _MANY_PAUSES)
    reply = _run(path, use_inaudible_opt=False)
    assert reply["span_count"] >= 5
    (row,) = _rows(path)
    assert len(json.dumps(row)) < 20_000
