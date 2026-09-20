"""Conformance tests: every time-bearing MCP tool is documented in TOOL_TIMEBASE."""

from __future__ import annotations

import inspect

import pytest

from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_timeline_overlap_to_source,
    timebase_qc_report,
)
from podcast_mcp.export.transcript import utterances_to_srt
from podcast_mcp.mcp.tools import (
    clips,
    edits,
    episode,
    history,
    ingest,
    pipeline,
    play,
    speaker,
    timeline,
    transcript,
)
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    MediaAsset,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.tool_timebase import TIME_PARAM_NAMES, TOOL_TIMEBASE

_TOOL_MODULES = (
    episode,
    transcript,
    edits,
    timeline,
    clips,
    pipeline,
    history,
    play,
    ingest,
    speaker,
)


def _registered_tool_functions():
    for mod in _TOOL_MODULES:
        reg = getattr(mod, "register", None)
        if reg is None:
            continue
        src = inspect.getsource(reg)
        if "for fn in (" not in src:
            continue
        block = src.split("for fn in (", 1)[1].split("):", 1)[0]
        for name in block.replace("\n", " ").split(","):
            name = name.strip()
            if not name:
                continue
            fn = getattr(mod, name, None)
            if callable(fn):
                yield fn


def test_mcp_time_param_tools_in_registry() -> None:
    missing: list[str] = []
    for fn in _registered_tool_functions():
        params = set(inspect.signature(fn).parameters)
        if not params & TIME_PARAM_NAMES:
            continue
        if fn.__name__ not in TOOL_TIMEBASE:
            missing.append(fn.__name__)
    assert not missing, "Add these tools to util/tool_timebase.py TOOL_TIMEBASE:\n" + "\n".join(
        f"  {n}" for n in sorted(missing)
    )


def _compressed_project(tmp_path) -> EpisodeProject:
    p = EpisodeProject.create("conformance", str(tmp_path / "ws"))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=200.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=60.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=90.0,
            source_end=200.0,
            timeline_start=60.0,
        ),
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=10.0, end=12.0),
                TranscriptWord(text="after", start=100.0, end=102.0),
            ],
        )
    ]
    p.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", text="before", start=10.0, end=12.0),
            CombinedUtterance(
                track_id="host", speaker="Host", text="after", start=100.0, end=102.0
            ),
        ]
    )
    return p


def test_clip_overlap_helper_matches_session_timeline(tmp_path) -> None:
    p = _compressed_project(tmp_path)
    clip = p.clips[1]
    bounds = clip_timeline_overlap_to_source(clip, 65.0, 75.0)
    assert bounds == pytest.approx((95.0, 105.0))

    st = SessionTimeline(p)
    assert st.source_to_timeline("host", SourceSec(100.0)) == pytest.approx(70.0)


def test_export_srt_uses_timeline_on_compressed_project(tmp_path) -> None:
    p = _compressed_project(tmp_path)
    srt = utterances_to_srt(p)
    assert "00:01:10,000 --> 00:01:12,000" in srt
    assert "00:00:10,000 --> 00:00:12,000" in srt


def test_timebase_qc_flags_drift(tmp_path) -> None:
    p = _compressed_project(tmp_path)
    report = timebase_qc_report(p)
    assert report["tracks"]["host"]["max_drift_sec"] == pytest.approx(30.0)
    assert report["ok"] is True  # drift alone is a warning, not a hard fail
    assert any("drift" in w for w in report["warnings"])
    assert report["issues"] == []
