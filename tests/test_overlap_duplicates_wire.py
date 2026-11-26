"""Pins the exact wire output of overlap_duplicates across the service, CLI and MCP tool."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools import transcript as transcript_tools
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService

runner = CliRunner()

AUDIBILITY_TARGET = "podcast_mcp.engines.overlap_report.compute_word_audibility_map"

PAIR_KEYS = [
    "track_a",
    "source_a",
    "word_index_a",
    "text_a",
    "start_a",
    "end_a",
    "status_a",
    "track_b",
    "source_b",
    "word_index_b",
    "text_b",
    "start_b",
    "end_b",
    "session_start_a",
    "session_start_b",
    "status_b",
    "overlap_sec",
    "text_match",
    "rms_a_db",
    "rms_b_db",
]


def _wire(result):
    return result if isinstance(result, dict) else result.model_dump()


def _row(track, index, status, rms, source=None):
    return {
        "track_id": track,
        "source_id": source,
        "word_index": index,
        "audibility_status": status,
        "own_rms_db": rms,
    }


def _words(spec):
    return [TranscriptWord(text=t, start=s, end=e, confidence=0.9) for t, s, e in spec]


def _project(root: Path, lanes) -> Path:
    proj = load_project(root)
    proj.timeline.tracks = []
    proj.timeline.clips = []
    proj.transcripts = []
    for track_id, takes in lanes:
        proj.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                speaker=track_id,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=10.0),
            )
        )
        for source_id, spec, timeline_start in takes:
            end = max(e for _t, _s, e in spec) + 1.0
            proj.timeline.clips.append(
                Clip(
                    id=f"{track_id}-{source_id or 'main'}",
                    track_id=track_id,
                    source_id=source_id,
                    source_start=0.0,
                    source_end=end,
                    timeline_start=timeline_start,
                )
            )
            proj.transcripts.append(
                Transcript(track_id=track_id, source_id=source_id, words=_words(spec))
            )
    save_project(proj, root)
    return root


def _call_service(project: Path, rows, **kwargs):
    ws = ProjectWorkspace.open(project)
    with patch(AUDIBILITY_TARGET, return_value=rows):
        return AnalysisService(ws).overlap_duplicates(**kwargs)


def _service_text(project: Path, rows, **kwargs) -> str:
    return json.dumps(_wire(_call_service(project, rows, **kwargs)), indent=2)


def _cli_text(project: Path, rows, *extra: str) -> str:
    with patch(AUDIBILITY_TARGET, return_value=rows):
        result = runner.invoke(
            app, ["edit", "overlap-duplicates", "--project", str(project), *extra]
        )
    assert result.exit_code == 0, result.output
    return result.stdout.strip()


def _mcp_text(project: Path, rows, **kwargs) -> str:
    with patch(AUDIBILITY_TARGET, return_value=rows):
        return transcript_tools.overlap_duplicates_tool(str(project), **kwargs)


def _all_surfaces(project: Path, rows, **kwargs) -> list[str]:
    extra = []
    if "start_sec" in kwargs:
        extra += ["--start", str(kwargs["start_sec"])]
    if "end_sec" in kwargs:
        extra += ["--end", str(kwargs["end_sec"])]
    return [
        _service_text(project, rows, **kwargs),
        _cli_text(project, rows, *extra),
        _mcp_text(project, rows, **kwargs),
    ]


def _scenario_empty(root: Path):
    lanes = [
        ("host", [(None, [("hello", 0.0, 1.0)], 0.0)]),
        ("guest", [(None, [("world", 5.0, 6.0)], 0.0)]),
    ]
    return _project(root, lanes), []


def _scenario_match(root: Path):
    lanes = [
        ("host", [(None, [("Hello,", 0.0, 1.0)], 0.0)]),
        ("guest", [(None, [("hello", 0.5, 1.5)], 0.0)]),
    ]
    rows = [_row("host", 0, "audible", -21.5), _row("guest", 0, "bleed", -48.25)]
    return _project(root, lanes), rows


def _scenario_nomatch(root: Path):
    lanes = [
        ("host", [(None, [("hello", 2.0, 3.0)], 0.0)]),
        ("guest", [(None, [("world", 2.25, 2.5)], 0.0)]),
    ]
    rows = [_row("host", 0, "audible", -20.0), _row("guest", 0, "audible", -22.0)]
    return _project(root, lanes), rows


def _scenario_several(root: Path):
    lanes = [
        ("host", [(None, [("beta", 1.0, 2.0), ("alpha", 3.0, 4.0), ("yes", 6.0, 7.0)], 0.0)]),
        ("guest", [(None, [("gamma", 1.5, 2.5), ("alpha", 3.5, 4.5), ("yes", 6.0, 7.0)], 0.0)]),
        ("extra", [(None, [("yes", 6.0, 7.0)], 0.0)]),
    ]
    rows = [
        _row("host", 0, "audible", -19.0),
        _row("guest", 0, "inaudible", -60.0),
        _row("host", 1, "audible", -18.5),
        _row("guest", 1, "bleed", -45.0),
    ]
    return _project(root, lanes), rows


def _scenario_take(root: Path):
    lanes = [
        (
            "host",
            [
                (None, [("one", 0.0, 1.0)], 0.0),
                ("take2", [("again", 0.0, 1.0)], 20.0),
            ],
        ),
        ("guest", [(None, [("one", 0.5, 1.5), ("again", 20.5, 21.5)], 0.0)]),
    ]
    rows = [
        _row("host", 0, "audible", -17.0),
        _row("host", 0, "audible", -16.0, source="take2"),
        _row("guest", 1, "bleed", -50.0),
    ]
    return _project(root, lanes), rows


def _scenario_unicode(root: Path):
    lanes = [
        ("host", [(None, [("café", 0.0, 1.0), ("\u2014", 2.0, 3.0)], 0.0)]),
        ("guest", [(None, [("café", 0.5, 1.5), ("\u2014", 2.5, 3.5)], 0.0)]),
    ]
    rows = [_row("host", 0, "audible", -21.5), _row("guest", 0, "bleed", -48.25)]
    return _project(root, lanes), rows


EMPTY = """\
{
  "pair_count": 0,
  "text_match_count": 0,
  "pairs": []
}
"""

MATCH = """\
{
  "pair_count": 1,
  "text_match_count": 1,
  "pairs": [
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 0,
      "text_a": "hello",
      "start_a": 0.5,
      "end_a": 1.5,
      "status_a": "bleed",
      "track_b": "host",
      "source_b": null,
      "word_index_b": 0,
      "text_b": "Hello,",
      "start_b": 0.0,
      "end_b": 1.0,
      "session_start_a": 0.5,
      "session_start_b": 0.0,
      "status_b": "audible",
      "overlap_sec": 0.5,
      "text_match": true,
      "rms_a_db": -48.25,
      "rms_b_db": -21.5
    }
  ]
}
"""

NOMATCH = """\
{
  "pair_count": 1,
  "text_match_count": 0,
  "pairs": [
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 0,
      "text_a": "world",
      "start_a": 2.25,
      "end_a": 2.5,
      "status_a": "audible",
      "track_b": "host",
      "source_b": null,
      "word_index_b": 0,
      "text_b": "hello",
      "start_b": 2.0,
      "end_b": 3.0,
      "session_start_a": 2.25,
      "session_start_b": 2.0,
      "status_b": "audible",
      "overlap_sec": 0.25,
      "text_match": false,
      "rms_a_db": -22.0,
      "rms_b_db": -20.0
    }
  ]
}
"""

SEVERAL = """\
{
  "pair_count": 5,
  "text_match_count": 4,
  "pairs": [
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 0,
      "text_a": "gamma",
      "start_a": 1.5,
      "end_a": 2.5,
      "status_a": "inaudible",
      "track_b": "host",
      "source_b": null,
      "word_index_b": 0,
      "text_b": "beta",
      "start_b": 1.0,
      "end_b": 2.0,
      "session_start_a": 1.5,
      "session_start_b": 1.0,
      "status_b": "audible",
      "overlap_sec": 0.5,
      "text_match": false,
      "rms_a_db": -60.0,
      "rms_b_db": -19.0
    },
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 1,
      "text_a": "alpha",
      "start_a": 3.5,
      "end_a": 4.5,
      "status_a": "bleed",
      "track_b": "host",
      "source_b": null,
      "word_index_b": 1,
      "text_b": "alpha",
      "start_b": 3.0,
      "end_b": 4.0,
      "session_start_a": 3.5,
      "session_start_b": 3.0,
      "status_b": "audible",
      "overlap_sec": 0.5,
      "text_match": true,
      "rms_a_db": -45.0,
      "rms_b_db": -18.5
    },
    {
      "track_a": "extra",
      "source_a": null,
      "word_index_a": 0,
      "text_a": "yes",
      "start_a": 6.0,
      "end_a": 7.0,
      "status_a": null,
      "track_b": "guest",
      "source_b": null,
      "word_index_b": 2,
      "text_b": "yes",
      "start_b": 6.0,
      "end_b": 7.0,
      "session_start_a": 6.0,
      "session_start_b": 6.0,
      "status_b": null,
      "overlap_sec": 1.0,
      "text_match": true,
      "rms_a_db": null,
      "rms_b_db": null
    },
    {
      "track_a": "extra",
      "source_a": null,
      "word_index_a": 0,
      "text_a": "yes",
      "start_a": 6.0,
      "end_a": 7.0,
      "status_a": null,
      "track_b": "host",
      "source_b": null,
      "word_index_b": 2,
      "text_b": "yes",
      "start_b": 6.0,
      "end_b": 7.0,
      "session_start_a": 6.0,
      "session_start_b": 6.0,
      "status_b": null,
      "overlap_sec": 1.0,
      "text_match": true,
      "rms_a_db": null,
      "rms_b_db": null
    },
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 2,
      "text_a": "yes",
      "start_a": 6.0,
      "end_a": 7.0,
      "status_a": null,
      "track_b": "host",
      "source_b": null,
      "word_index_b": 2,
      "text_b": "yes",
      "start_b": 6.0,
      "end_b": 7.0,
      "session_start_a": 6.0,
      "session_start_b": 6.0,
      "status_b": null,
      "overlap_sec": 1.0,
      "text_match": true,
      "rms_a_db": null,
      "rms_b_db": null
    }
  ]
}
"""

WINDOW = """\
{
  "pair_count": 1,
  "text_match_count": 1,
  "pairs": [
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 1,
      "text_a": "alpha",
      "start_a": 3.5,
      "end_a": 4.5,
      "status_a": "bleed",
      "track_b": "host",
      "source_b": null,
      "word_index_b": 1,
      "text_b": "alpha",
      "start_b": 3.0,
      "end_b": 4.0,
      "session_start_a": 3.5,
      "session_start_b": 3.0,
      "status_b": "audible",
      "overlap_sec": 0.5,
      "text_match": true,
      "rms_a_db": -45.0,
      "rms_b_db": -18.5
    }
  ]
}
"""

TAKE = """\
{
  "pair_count": 2,
  "text_match_count": 2,
  "pairs": [
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 0,
      "text_a": "one",
      "start_a": 0.5,
      "end_a": 1.5,
      "status_a": null,
      "track_b": "host",
      "source_b": null,
      "word_index_b": 0,
      "text_b": "one",
      "start_b": 0.0,
      "end_b": 1.0,
      "session_start_a": 0.5,
      "session_start_b": 0.0,
      "status_b": "audible",
      "overlap_sec": 0.5,
      "text_match": true,
      "rms_a_db": null,
      "rms_b_db": -17.0
    },
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 1,
      "text_a": "again",
      "start_a": 20.5,
      "end_a": 21.5,
      "status_a": "bleed",
      "track_b": "host",
      "source_b": "take2",
      "word_index_b": 0,
      "text_b": "again",
      "start_b": 0.0,
      "end_b": 1.0,
      "session_start_a": 20.5,
      "session_start_b": 20.0,
      "status_b": "audible",
      "overlap_sec": 0.5,
      "text_match": true,
      "rms_a_db": -50.0,
      "rms_b_db": -16.0
    }
  ]
}
"""


UNICODE = """\
{
  "pair_count": 2,
  "text_match_count": 1,
  "pairs": [
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 0,
      "text_a": "caf\\u00e9",
      "start_a": 0.5,
      "end_a": 1.5,
      "status_a": "bleed",
      "track_b": "host",
      "source_b": null,
      "word_index_b": 0,
      "text_b": "caf\\u00e9",
      "start_b": 0.0,
      "end_b": 1.0,
      "session_start_a": 0.5,
      "session_start_b": 0.0,
      "status_b": "audible",
      "overlap_sec": 0.5,
      "text_match": true,
      "rms_a_db": -48.25,
      "rms_b_db": -21.5
    },
    {
      "track_a": "guest",
      "source_a": null,
      "word_index_a": 1,
      "text_a": "\\u2014",
      "start_a": 2.5,
      "end_a": 3.5,
      "status_a": null,
      "track_b": "host",
      "source_b": null,
      "word_index_b": 1,
      "text_b": "\\u2014",
      "start_b": 2.0,
      "end_b": 3.0,
      "session_start_a": 2.5,
      "session_start_b": 2.0,
      "status_b": null,
      "overlap_sec": 0.5,
      "text_match": false,
      "rms_a_db": null,
      "rms_b_db": null
    }
  ]
}
"""


SCENARIOS = {
    "empty": (_scenario_empty, {}, EMPTY),
    "match": (_scenario_match, {}, MATCH),
    "nomatch": (_scenario_nomatch, {}, NOMATCH),
    "several": (_scenario_several, {}, SEVERAL),
    "window": (_scenario_several, {"start_sec": 3.0, "end_sec": 6.0}, WINDOW),
    "take": (_scenario_take, {}, TAKE),
    "unicode": (_scenario_unicode, {}, UNICODE),
}


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_service_wire_text_is_pinned(minimal_project, name):
    build, kwargs, expected = SCENARIOS[name]
    project, rows = build(minimal_project)
    assert _service_text(project, rows, **kwargs) == expected.rstrip("\n")


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_cli_and_mcp_match_the_pinned_text(minimal_project, name):
    build, kwargs, expected = SCENARIOS[name]
    project, rows = build(minimal_project)
    texts = _all_surfaces(project, rows, **kwargs)
    assert texts == [expected.rstrip("\n")] * 3


def test_report_and_pair_key_order(minimal_project):
    project, rows = _scenario_several(minimal_project)
    wire = _wire(_call_service(project, rows))
    assert list(wire) == ["pair_count", "text_match_count", "pairs"]
    assert wire["pair_count"] == 5
    assert wire["text_match_count"] == 4
    for pair in wire["pairs"]:
        assert list(pair) == PAIR_KEYS


def test_sort_order_is_session_start_then_track(minimal_project):
    project, rows = _scenario_several(minimal_project)
    pairs = _wire(_call_service(project, rows))["pairs"]
    assert [(p["session_start_a"], p["track_a"], p["track_b"]) for p in pairs] == [
        (1.5, "guest", "host"),
        (3.5, "guest", "host"),
        (6.0, "extra", "guest"),
        (6.0, "extra", "host"),
        (6.0, "guest", "host"),
    ]


def test_integral_floats_stay_floats_on_the_wire(minimal_project):
    project, rows = _scenario_several(minimal_project)
    wire = _wire(_call_service(project, rows))
    last = wire["pairs"][-1]
    for field in ("start_a", "end_a", "start_b", "end_b", "session_start_a", "overlap_sec"):
        assert type(last[field]) is float
    text = _mcp_text(project, rows)
    assert '"overlap_sec": 1.0,' in text
    assert '"end_a": 7.0,' in text


def test_missing_audibility_rows_serialise_as_null(minimal_project):
    project, rows = _scenario_several(minimal_project)
    last = _wire(_call_service(project, rows))["pairs"][-1]
    assert (last["status_a"], last["status_b"], last["rms_a_db"], last["rms_b_db"]) == (
        None,
        None,
        None,
        None,
    )


def test_second_take_names_its_source(minimal_project):
    project, rows = _scenario_take(minimal_project)
    pairs = _wire(_call_service(project, rows))["pairs"]
    assert [(p["source_a"], p["source_b"]) for p in pairs] == [(None, None), (None, "take2")]
    assert [p["session_start_b"] for p in pairs] == [0.0, 20.0]
