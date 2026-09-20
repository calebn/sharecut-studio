from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.services import EditService
from podcast_mcp.services.play import PlayRequest, PlayService
from podcast_mcp.services.workspace import ProjectWorkspace


def play_audio_tool(
    project_path: str,
    source: str = "processed:host",
    start_sec: float = 0.0,
    end_sec: float = 10.0,
    query: str | None = None,
    match_index: int = 0,
    padding_sec: float = 1.0,
    dry_run: bool = True,
    raw: bool = False,
    rerender: bool = False,
    compare: bool = False,
    follow_transcript: bool = False,
) -> str:
    """Extract and optionally play audio (processed:<id>, track:<id>, premix, export)."""
    ws = ProjectWorkspace.open(project_path)
    result = PlayService(ws).play(
        PlayRequest(
            source=source,
            start_sec=start_sec,
            end_sec=end_sec,
            query=query,
            match_index=match_index,
            padding_sec=padding_sec,
            raw=raw,
            rerender=rerender,
            compare=compare,
            follow_transcript=follow_transcript,
        ),
        dry_run=dry_run,
    )
    payload = {
        "wav": str(result.wav_path),
        "source": result.source_label,
        "tier": result.tier,
        "start_sec": result.start_sec,
        "end_sec": result.end_sec,
        "player": result.player_cmd,
    }
    if result.compare_segments:
        payload["compare_segments"] = result.compare_segments
    return json.dumps(payload, indent=2)


def play_transcript_query_tool(
    project_path: str,
    query: str,
    match_index: int = 0,
    padding_sec: float = 1.5,
    processed: bool = True,
    dry_run: bool = False,
    rerender: bool = False,
) -> str:
    """Search transcript for query and play that span (NL: play where they talk about X)."""
    ws = ProjectWorkspace.open(project_path)
    matches = EditService(ws).search(query)
    if not matches:
        return json.dumps(
            {"ok": False, "query": query, "error": "no transcript matches"},
            indent=2,
        )
    if match_index < 0 or match_index >= len(matches):
        return json.dumps(
            {
                "ok": False,
                "query": query,
                "error": "match_index out of range",
                "match_count": len(matches),
            },
            indent=2,
        )
    m = matches[match_index]
    if m.timeline_start is None or m.timeline_end is None:
        return json.dumps(
            {
                "ok": False,
                "query": query,
                "error": "match falls in removed timeline material",
            },
            indent=2,
        )
    source = f"processed:{m.track_id}" if processed else f"track:{m.track_id}"
    result = PlayService(ws).play(
        PlayRequest(
            source=source,
            start_sec=max(0.0, m.timeline_start - padding_sec),
            end_sec=m.timeline_end + padding_sec,
            raw=not processed,
            rerender=rerender,
        ),
        dry_run=dry_run,
    )
    return json.dumps(
        {
            "ok": True,
            "query": query,
            "match_index": match_index,
            "match_count": len(matches),
            "match": {
                "track_id": m.track_id,
                "start": m.start,
                "end": m.end,
                "timeline_start": m.timeline_start,
                "timeline_end": m.timeline_end,
                "text": m.text,
                "speaker": m.speaker,
            },
            "play": {
                "wav": str(result.wav_path),
                "source": result.source_label,
                "tier": result.tier,
                "start_sec": result.start_sec,
                "end_sec": result.end_sec,
                "player": result.player_cmd,
            },
        },
        indent=2,
    )


def play_compose_tool(
    project_path: str,
    track_ids: list[str],
    start_sec: float,
    end_sec: float,
    tier: str = "processed",
    dry_run: bool = True,
    rerender: bool = False,
) -> str:
    """Mix selected tracks for a timeline window and optionally play (no project mutation).

    ``tier`` is ``processed`` (edits+FX stems) or ``raw`` (source media). Times are
    timeline (session) seconds. Does not change mute/solo/FX on the project.
    """
    ws = ProjectWorkspace.open(project_path)
    result = PlayService(ws).play_compose(
        track_ids,
        start_sec,
        end_sec,
        tier=tier,
        dry_run=dry_run,
        rerender=rerender,
    )
    return json.dumps(
        {
            "wav": str(result.wav_path),
            "source": result.source_label,
            "tier": result.tier,
            "start_sec": result.start_sec,
            "end_sec": result.end_sec,
            "track_ids": list(track_ids),
            "player": result.player_cmd,
        },
        indent=2,
    )


def audition_context_tool(
    project_path: str,
    start_sec: float,
    end_sec: float,
    skew_warn_sec: float = 0.05,
    detail: str = "summary",
) -> str:
    """Caption each dialogue track in a timeline window + clip-skew / render freshness.

    ``detail``: ``summary`` (default) includes comments, active effects, edits, and
    windowed hum/clip hypotheses; ``full`` expands edit/comment payloads;
    ``visual`` adds waveform/spectrogram PNGs (slower). Returns
    ``audition_context.v2`` (typed hypotheses, suggested_listen, explicit clocks).
    Times are timeline (session) seconds. Does not play audio.
    """
    ws = ProjectWorkspace.open(project_path)
    return json.dumps(
        PlayService(ws).audition_context(
            start_sec,
            end_sec,
            skew_warn_sec=skew_warn_sec,
            detail=detail,
        ),
        indent=2,
    )


def play_ab_tool(
    project_path: str,
    before_index: int,
    after_index: int,
    source: str = "premix",
    start_sec: float = 0.0,
    end_sec: float = 10.0,
    gap_sec: float = 0.4,
    rerender: bool = False,
    dry_run: bool = False,
) -> str:
    """Extract the same range at two history indices, then play A→gap→B once.

    Prefer this over history_goto → play → goto → play for before/after probes.
    Leaves the history cursor on ``after_index``. Default gap is 0.4s.
    """
    ws = ProjectWorkspace.open(project_path)
    result = PlayService(ws).play_history_ab(
        before_index,
        after_index,
        PlayRequest(
            source=source,
            start_sec=start_sec,
            end_sec=end_sec,
            rerender=rerender,
        ),
        gap_sec=gap_sec,
        dry_run=dry_run,
    )
    payload = {
        "wav": str(result.wav_path),
        "source": result.source_label,
        "tier": result.tier,
        "start_sec": result.start_sec,
        "end_sec": result.end_sec,
        "gap_sec": gap_sec,
        "before_index": before_index,
        "after_index": after_index,
        "player": result.player_cmd,
    }
    if result.compare_segments:
        payload["compare_segments"] = result.compare_segments
    return json.dumps(payload, indent=2)


def play_ab_wavs_tool(
    project_path: str,
    wav_a: str,
    wav_b: str,
    gap_sec: float = 0.4,
    dry_run: bool = False,
) -> str:
    """Play two existing WAVs back-to-back with a short silence gap (one concat)."""
    ws = ProjectWorkspace.open(project_path)
    result = PlayService(ws).play_ab_wavs(
        wav_a,
        wav_b,
        gap_sec=gap_sec,
        dry_run=dry_run,
    )
    payload = {
        "wav": str(result.wav_path),
        "source": result.source_label,
        "tier": result.tier,
        "gap_sec": gap_sec,
        "player": result.player_cmd,
    }
    if result.compare_segments:
        payload["compare_segments"] = result.compare_segments
    return json.dumps(payload, indent=2)


def play_pending_preview_tool(
    project_path: str,
    edit_id: str,
    mode: str = "suggested",
    pad_sec: float = 0.5,
    gap_sec: float = 0.4,
    source: str = "premix",
    dry_run: bool = False,
    rerender: bool = False,
) -> str:
    """Hear Current vs Suggested (skip-span) vs A/B for a pending session remove.

    Suggested concatenates pad-before + pad-after so the cut is gone. Splits and
    track-scope punches are not skippable. Does not mutate the project.
    """
    ws = ProjectWorkspace.open(project_path)
    result = PlayService(ws).play_pending_preview(
        edit_id,
        mode=mode,
        pad_sec=pad_sec,
        gap_sec=gap_sec,
        source=source,
        dry_run=dry_run,
        rerender=rerender,
    )
    payload = {
        "wav": str(result.wav_path),
        "source": result.source_label,
        "tier": result.tier,
        "start_sec": result.start_sec,
        "end_sec": result.end_sec,
        "mode": mode,
        "edit_id": edit_id,
        "player": result.player_cmd,
    }
    if result.compare_segments:
        payload["compare_segments"] = result.compare_segments
    return json.dumps(payload, indent=2)


def register(mcp: MCPServer) -> None:
    mcp.tool()(play_audio_tool)
    mcp.tool()(play_transcript_query_tool)
    mcp.tool()(audition_context_tool)
    mcp.tool()(play_compose_tool)
    mcp.tool()(play_ab_tool)
    mcp.tool()(play_ab_wavs_tool)
    mcp.tool()(play_pending_preview_tool)
