from __future__ import annotations

from typing import Any, Literal

from mcp.server import MCPServer

from podcast_mcp.edits.audio_check_override import audio_check_override
from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.mcp.args import JsonObject, JsonObjectList
from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools.agent_notify import notify_after_mutation
from podcast_mcp.models import EditMode
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    AnalysisService,
    EditService,
    RollBoundaryTarget,
    TimelineService,
    TranscriptService,
    TrimBoundaryTarget,
)
from podcast_mcp.services.document_sync import (
    host_command_result,
    submit_host_command_result,
    submit_host_document_command,
    submit_paste_segment,
    validate_payload,
)
from podcast_mcp.services.jobs import run_audio_edit
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.project_state import REQUEST_RENDER_LOCK_TIMEOUT_SEC
from podcast_mcp.util.tracks import resolve_track


def inspect_clip_bleed_tool(project_path: str, clip_id: str, track_id: str) -> str:
    """Inspect automatic attenuation on one occurrence and return guarded Restore targets."""
    inspection = TimelineService(ProjectWorkspace.open(project_path)).inspect_clip_bleed(
        clip_id, track_id=track_id
    )
    return inspection.model_dump_json()


def restore_clip_bleed_tool(
    project_path: str, target: JsonObject, command_id: str | None = None
) -> str:
    """Save one inspected Restore choice. Reuse command_id when retrying the same submission.

    Does not render audio or restore other occurrences. Changed targets must be inspected again.
    """
    reply = submit_host_document_command(
        project_path,
        "RestoreClipBleed",
        {"target": target},
        client_id="mcp:host",
        command_id=command_id,
    )
    return to_json(host_command_result(reply))


def strip_silence_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    over_voice_floor_db: float = 0.0,
    min_duration_sec: float = 0.5,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Rebuild a track from speech islands between detected silences.

    Silence is audio under the track's own audibility floor (its voice floor) plus
    ``over_voice_floor_db``. A track whose voice does not stand out of its room has no
    silence to strip, whatever ``over_voice_floor_db`` is.

    ``use_inaudible_opt`` is accepted for API compatibility but ignored.
    """
    ws = ProjectWorkspace.open(project_path)
    result = AnalysisService(ws).strip_silence(
        track_id=track_id,
        speaker=speaker,
        over_voice_floor_db=over_voice_floor_db,
        min_duration_sec=min_duration_sec,
        use_inaudible_opt=use_inaudible_opt,
    )
    return to_json(result)


def ripple_delete_tool(
    project_path: str,
    start: float,
    end: float,
    use_inaudible_opt: bool | None = None,
    track_ids: list[str] | None = None,
    override_audio_checks: bool = False,
) -> str:
    """Ripple-delete a timeline range across every dialogue track.

    Default inaudible opt absorbs trailing quiet air to ~0.4s before the next
    word. For punchline-to-pivot / leave-a-beat handoffs, call
    ``suggest_handoff_cut_tool`` first and pass ``use_inaudible_opt=false`` so
    local snap does not pull mid-silence bounds onto speech. ``track_ids``
    names the tracks whose speech you mean to cut; speech on any
    other track in the range needs confirmation. Omitted, the cut names no track,
    so speech on every track needs confirmation (a whole-session time cut).
    The automatic audio-quality and cut-position checks run first: a cut that lands
    mid-word, makes an audible join or cuts another track's speech stays unchanged and
    comes back with the finding. When the user wants that exact cut anyway (or names the
    position themselves), repeat with ``override_audio_checks=true``; it keeps the bounds as
    given and records who overrode in History and the edit log.
    """
    if not end > start:
        raise CodedValueError(
            "timeline_end must be after timeline_start. Pick a timeline_end later than timeline_start.",
            code="range_end_before_start",
        )
    result = submit_host_command_result(
        project_path,
        "CutRange",
        {
            "start": start,
            "end": end,
            "mode": EditMode.RIPPLE.value,
            "track_ids": track_ids or [],
            "use_inaudible_opt": False if override_audio_checks else use_inaudible_opt,
            "override_audio_checks": override_audio_checks,
        },
        client_id="mcp:host",
    )
    return to_json(result)


def ripple_delete_text_tool(
    project_path: str,
    query: str,
    use_inaudible_opt: bool | None = None,
    override_audio_checks: bool = False,
) -> str:
    """Ripple-delete the first timeline span matching a transcript text query.

    The matched speaker's words are the cut; other tracks' speech in the span needs
    confirmation.
    The automatic audio checks hold a harsh or other-speaker cut and name the finding;
    ``override_audio_checks=true`` applies it anyway and records the override.
    """
    result = submit_host_command_result(
        project_path,
        "RippleDeleteText",
        {
            "query": query,
            "use_inaudible_opt": False if override_audio_checks else use_inaudible_opt,
            "override_audio_checks": override_audio_checks,
        },
        client_id="mcp:host",
    )
    return to_json(result)


def move_segment_tool(
    project_path: str,
    source_start: float,
    source_end: float,
    insert_at: float,
) -> str:
    """Cut a timeline segment and reinsert it at a new time (ripple move)."""
    return to_json(
        submit_host_command_result(
            project_path,
            "MoveSegment",
            {"source_start": source_start, "source_end": source_end, "insert_at": insert_at},
        )
    )


def move_clips_tool(project_path: str, clips: JsonObjectList) -> str:
    """Move clips in session time and/or onto another track (no neighbor ripple).

    ``clips`` is a list of ``{clip_id, timeline_start, track_id}``.
    Inter-track moves keep the originating media via ``source_id``. Unlike
    ``move_segment_tool``, this does not cut a range on every dialogue lane.
    """
    result = submit_host_document_command(project_path, "MoveClips", {"clips": clips})
    return to_json(
        host_command_result(result) or {"ok": result.get("ok"), "operation": "move_clips"}
    )


def move_by_text_tool(
    project_path: str,
    source_query: str,
    destination_query: str,
    position: str = "after",
) -> str:
    """Move a transcript-matched segment before or after another transcript match."""
    result = submit_host_command_result(
        project_path,
        "MoveByText",
        {
            "source_query": source_query,
            "destination_query": destination_query,
            "position": position,
        },
    )
    return to_json(result)


def insert_gap_tool(
    project_path: str,
    at_time: float,
    duration_sec: float = 1.0,
) -> str:
    """Open pure silence on the timeline (split + shift).

    Do not use to fake a beat after a tight handoff unless the user asks —
    prefer keeping existing room tone via ``suggest_handoff_cut_tool`` bounds.
    """
    result = submit_host_command_result(
        project_path, "InsertGap", {"at_time": at_time, "duration_sec": duration_sec}
    )
    return to_json(result)


def fade_joins_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    fade_ms: int | None = None,
    dry_run: bool = False,
) -> str:
    """Add fades at edit joins on a track; dry_run previews without applying."""
    if dry_run:
        ws = ProjectWorkspace.open(project_path)
        return to_json(
            TimelineService(ws).preview_fade_joins(
                track_id=track_id, speaker=speaker, fade_ms=fade_ms
            )
        )
    return to_json(
        submit_host_command_result(
            project_path,
            "FadeJoins",
            {"track_id": track_id, "speaker": speaker, "fade_ms": fade_ms},
        )
    )


def crossfade_joins_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    fade_ms: int | None = None,
    dry_run: bool = False,
) -> str:
    """Add crossfades at edit joins on a track; dry_run previews without applying."""
    if dry_run:
        ws = ProjectWorkspace.open(project_path)
        return to_json(
            TimelineService(ws).preview_crossfade_joins(
                track_id=track_id, speaker=speaker, fade_ms=fade_ms
            )
        )
    return to_json(
        submit_host_command_result(
            project_path,
            "CrossfadeJoins",
            {"track_id": track_id, "speaker": speaker, "fade_ms": fade_ms},
        )
    )


def set_clip_fade_tool(
    project_path: str,
    clip_id: str,
    fade_in_ms: int,
    fade_out_ms: int,
) -> str:
    """Set the fade-in and fade-out duration of a single clip.

    Dialogue fades cap at ``render.join_fade_max_ms``. Each fade fits in the clip, and
    fade-out is limited to what fade-in leaves.
    """
    ws = ProjectWorkspace.open(project_path)
    clip = next((c for c in ws.project.clips if c.id == clip_id), None)
    if clip is None:
        raise CodedValueError(f"unknown clip_id: {clip_id!r}", code="clip_not_found")
    return to_json(
        submit_host_command_result(
            project_path,
            "SetClipFade",
            {
                "clip_id": clip_id,
                "fade_in_ms": fade_in_ms,
                "fade_out_ms": fade_out_ms,
                "expected": {"fade_in_ms": clip.fade_in_ms, "fade_out_ms": clip.fade_out_ms},
            },
        )
    )


def set_join_mode_tool(
    project_path: str,
    clip_id: str,
    join_in_mode: str,
) -> str:
    """Set join_in_mode on one clip: fade | crossfade | cut (TOOL_TIMEBASE: na).

    Mode only: fades are untouched, so a crossfade with no fades renders as a plain
    join; the result's ``join_crossfade_blocked`` says why. Prefer ``set_clip_join_tool``.
    """
    return to_json(
        submit_host_command_result(
            project_path, "SetJoinMode", {"clip_id": clip_id, "join_in_mode": join_in_mode}
        )
    )


def set_clip_join_tool(
    project_path: str,
    left_clip_id: str,
    right_clip_id: str,
    mode: str,
    length_ms: int | None = None,
) -> str:
    """Set the join between two neighbouring clips: mode plus fades (TOOL_TIMEBASE: na).

    ``mode`` is fade | crossfade | cut. Crossfade sets left fade-out and right fade-in to
    ``length_ms`` (default ``tighten.crossfade_ms``); cut zeroes both fades; fade sets both
    (or keeps them). Prefer this over ``set_join_mode_tool``, which changes the mode only
    and leaves a crossfade with no fades to blend.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "SetClipJoin",
            {
                "left_clip_id": left_clip_id,
                "right_clip_id": right_clip_id,
                "mode": mode,
                "length_ms": length_ms,
            },
        )
    )


def trim_clip_edge_tool(
    project_path: str,
    clip_id: str,
    edge: Literal["in", "out"],
    source_sec: float,
    mode: Literal["ripple", "gap"] = "ripple",
    override_audio_checks: bool = False,
) -> str:
    """Move one clip's ``in`` or ``out`` edge to ``source_sec`` (source-media seconds).

    ``mode="ripple"`` moves every dialogue track by the duration change, so speakers
    stay in sync: a track with a clip edge at the same instant (a session-wide cut)
    moves that edge too, and every other track loses or gains the same span.
    ``mode="gap"`` moves only the grabbed edge and leaves silence or fills the gap to
    the neighbouring clip; nothing else moves. Expansion is clamped to unused source
    between the neighbouring clips. The fix for a ``speech_crosses_cut`` hypothesis
    from ``audition_context_tool`` is its ``evidence.fix`` (clip, edge, source_sec,
    mode). Same operation as the DAW trim handle (``TrimClipEdge``); undoable. Follow
    with ``render_preview``.
    The automatic audio checks hold a harsh edge or another speaker's speech and name the
    finding; ``override_audio_checks=true`` moves the edge to exactly ``source_sec`` anyway
    and records the override.
    """
    edit_mode = EditMode(mode)
    ws = ProjectWorkspace.open(project_path)
    with ws.transaction():
        revision = (
            EditService(ws)
            .boundary_context(TrimBoundaryTarget(clip_id=clip_id, edge=edge, mode=edit_mode))
            .token
        )
    return to_json(
        submit_host_command_result(
            project_path,
            "TrimClipEdge",
            {
                "clip_id": clip_id,
                "edge": edge,
                "source_sec": source_sec,
                "mode": edit_mode.value,
                "expected_token": revision,
                "override_audio_checks": override_audio_checks,
            },
            client_id="mcp:host",
        )
    )


def roll_clip_join_tool(
    project_path: str,
    left_clip_id: str,
    right_clip_id: str,
    delta_sec: float,
) -> str:
    """Roll the join between two neighbouring clips by ``delta_sec`` source seconds.

    Positive moves the join later: the left clip gains material and the right clip
    starts later in its source, so the pair keeps its length and later clips stay put.
    Same operation as the Studio roll seam (``RollClipJoin``); undoable. The clips must
    abut (touch within the join tolerance, see ``clips_abut``); across a gap the call is
    refused with ``error_code`` ``roll_needs_abutting_clips`` and nothing changes. Use
    ``trim_clip_edge_tool`` to move one edge and ripple instead.
    """
    ws = ProjectWorkspace.open(project_path)
    token = (
        EditService(ws)
        .boundary_context(
            RollBoundaryTarget(left_clip_id=left_clip_id, right_clip_id=right_clip_id)
        )
        .token
    )
    reply = submit_host_document_command(
        project_path,
        "RollClipJoin",
        {
            "left_clip_id": left_clip_id,
            "right_clip_id": right_clip_id,
            "delta_sec": delta_sec,
            "expected_token": token,
        },
    )
    return to_json(host_command_result(reply))


def shorten_gaps_tool(
    project_path: str,
    max_gap_sec: float = 0.35,
    use_inaudible_opt: bool | None = None,
    override_audio_checks: bool = False,
) -> str:
    """Shorten word gaps longer than max_gap_sec across the timeline.

    Each shortened pause ripples every dialogue track; another speaker talking in a
    pause needs confirmation. A ripple that cuts another track's speech stays unchanged
    until you repeat with ``override_audio_checks=true`` (recorded).
    """
    ws = ProjectWorkspace.open(project_path)
    with audio_check_override("mcp:host", "host_mcp", enabled=override_audio_checks):
        return to_json(
            TimelineService(ws).shorten_word_gaps(
                max_gap_sec,
                use_inaudible_opt=use_inaudible_opt,
            )
        )


def split_clip_tool(
    project_path: str,
    at_time: float,
    track_id: str | None = None,
    speaker: str | None = None,
    track_ids: list[str] | None = None,
) -> str:
    """Split clip(s) at a timeline timecode.

    Pass ``track_ids`` for multi-track blade cuts.
    When omitted, uses ``track_id`` / ``speaker``, or all dialogue tracks.
    Submits ``SplitAtTime`` on the document plane (same path as ShareCut Studio blade).
    """
    from podcast_mcp.util.tracks import dialogue_track_ids

    ws = ProjectWorkspace.open(project_path)
    if track_ids is None:
        if track_id is not None or speaker is not None:
            track_ids = [EditService(ws)._resolve(track_id, speaker)]
        else:
            track_ids = dialogue_track_ids(ws.project)

    result = submit_host_document_command(
        project_path,
        "SplitAtTime",
        {"at_time": float(at_time), "track_ids": track_ids},
    )
    return to_json(host_command_result(result) or {"ok": result.get("ok"), "operation": "split"})


def delete_clips_tool(
    project_path: str,
    clip_ids: list[str],
    mode: Literal["ripple", "gap"] = "gap",
    override_audio_checks: bool = False,
) -> str:
    """Delete whole clips by id, as the Studio clip Delete and Ripple delete do.

    ``clip_ids`` lists the clips to delete (see ``list_clips_tool``).
    ``mode="gap"`` leaves silence where each clip was and moves nothing else;
    ``mode="ripple"`` closes the clips' spans on every dialogue track, so speakers stay
    in sync. A ripple that would cut speech outside the deleted clips (another track's,
    or an unselected clip's on the same track) changes nothing and returns
    ``needs_confirmation``; repeat with ``override_audio_checks=true`` to apply it
    anyway (recorded). Submits ``DeleteClip`` on the document plane; undoable.
    For a time range across tracks use ``ripple_delete_tool``.
    """
    payload: dict = {
        "clip_ids": clip_ids,
        "mode": EditMode(mode).value,
        "override_audio_checks": override_audio_checks,
    }
    return to_json(
        host_command_result(
            submit_host_document_command(project_path, "DeleteClip", payload, client_id="mcp:host")
        )
    )


def duplicate_segment_tool(
    project_path: str,
    source_start: float,
    source_end: float,
    insert_at: float,
) -> str:
    """Duplicate a timeline segment at a new time."""
    return to_json(
        submit_host_command_result(
            project_path,
            "DuplicateSegment",
            {"source_start": source_start, "source_end": source_end, "insert_at": insert_at},
        )
    )


def copy_segment_tool(
    project_path: str,
    start: float,
    end: float,
    track_ids: list[str] | None = None,
) -> str:
    """Copy ``[start, end)`` timeline seconds the way Studio Copy / Cut fill the clipboard.

    Read-only. Returns ``{duration, extracts}``: the clips of every track in range, or
    only ``track_ids``. Pass it to ``paste_segment_tool``, which takes
    the edit mode. To cut and paste, copy first, then cut (``propose_range_cut_tool``, or
    ``delete_clips_tool`` with its ``mode``).
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(TimelineService(ws).copy_segment(start, end, track_ids))


def paste_segment_tool(
    project_path: str,
    insert_at: float,
    clipboard: JsonObject,
    mode: Literal["ripple", "gap"] = "ripple",
) -> str:
    """Paste a ``copy_segment_tool`` clipboard at ``insert_at`` timeline seconds (Studio Paste).

    ``mode="ripple"`` opens ``duration`` of time on every dialogue track at
    ``insert_at``, then places each extract on its own track. ``mode="gap"`` pastes
    over: it replaces ``[insert_at, insert_at + duration)`` on the pasted tracks only,
    and nothing moves. The same clipboard can be pasted again. A clipboard naming an
    unknown track or source, or an impossible range, is rejected with a ``paste_*``
    code. Submits ``PasteSegment`` on the document plane; undoable.
    """
    return to_json(submit_paste_segment(project_path, insert_at, clipboard, mode=EditMode(mode)))


def list_clips_tool(project_path: str, track_id: str | None = None) -> str:
    """List clips in timeline order for one track or all tracks when track_id is omitted."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TimelineService(ws).list_clips(track_id))


def list_applied_edits_tool(
    project_path: str,
    track_id: str | None = None,
    timeline_start: float | None = None,
    timeline_end: float | None = None,
) -> str:
    """List applied edits in a timeline window."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).list_applied_edits(
            track_id=track_id,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
        )
    )


def render_status_tool(project_path: str) -> str:
    """Report stem freshness and whether dialogue balance measurements are stale."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).render_status())


def fill_with_room_tone_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """Fill a track's silences with its own room tone.

    With ``start_sec`` and ``end_sec`` (timeline seconds, plus ``track_id``) only the
    clip-free time inside that range is filled; clips are never touched.
    """
    if start_sec is not None or end_sec is not None:
        if track_id is None or start_sec is None or end_sec is None:
            raise CodedValueError(
                "a range fill needs track_id, start_sec and end_sec", code="range_incomplete"
            )
        return to_json(
            submit_host_command_result(
                project_path,
                "FillRoomTone",
                {"track_id": track_id, "start_sec": start_sec, "end_sec": end_sec},
            )
        )
    ws = ProjectWorkspace.open(project_path)
    return to_json(TimelineService(ws).fill_room_tone(track_id=track_id, speaker=speaker))


def add_chapter_tool(project_path: str, at_time: float, title: str) -> str:
    """Add a chapter marker at a timeline time."""
    return to_json(
        submit_host_command_result(project_path, "AddChapter", {"time": at_time, "title": title})
    )


def remove_chapter_tool(project_path: str, title: str) -> str:
    """Remove a chapter marker by title."""
    ws = ProjectWorkspace.open(project_path)
    times = [c.time for c in ws.project.chapters if c.title == title]
    for time in times:
        submit_host_command_result(project_path, "DeleteChapter", {"time": time, "title": title})
    return to_json({"removed": bool(times), "title": title})


def list_chapters_tool(project_path: str) -> str:
    """List chapter markers in timeline order."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TimelineService(ws).list_chapters())


def check_loudness_tool(project_path: str, audio_path: str | None = None) -> str:
    """Measure LUFS and report artifact and dialogue-balance staleness without refreshing.

    ``pass`` judges loudness; ``stale`` and ``stale_reason`` judge known project
    artifact age. ``balance`` reports per-dialogue-track measurement freshness for
    tracked project audio. An explicit unrelated file has ``stale=None``.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).check_loudness(audio_path))


def correct_transcript_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    new_text: str,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Fix the text of one transcript word without changing its timing.

    Pass ``expected_text`` (the word text you read) to refuse the fix if the word at
    ``word_index`` changed meanwhile (for example a GUI edit shifted indices); omit to skip.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "CorrectTranscriptWord",
            {
                "track_id": track_id,
                "source_id": source_id,
                "word_index": word_index,
                "text": new_text,
                "expected_text": expected_text,
            },
        )
    )


def correct_transcript_phrase_tool(
    project_path: str,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    new_text: str,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Replace a word range's text with corrected phrase text.

    Pass ``expected_text`` (the space-joined words you read for this range) to refuse the fix
    if those words changed meanwhile; omit to skip.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "CorrectTranscriptPhrase",
            {
                "track_id": track_id,
                "source_id": source_id,
                "start_word_index": start_word_index,
                "end_word_index": end_word_index,
                "text": new_text,
                "expected_text": expected_text,
            },
        )
    )


def set_word_suppressed_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    suppressed: bool,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Toggle suppressed on one per-track word (TOOL_TIMEBASE: source).

    Pass ``expected_text`` (the word text you read) to refuse the toggle if the word at
    ``word_index`` changed meanwhile; omit to skip.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "SetTranscriptWordSuppressed",
            {
                "track_id": track_id,
                "source_id": source_id,
                "word_index": word_index,
                "suppressed": suppressed,
                "expected_text": expected_text,
            },
        )
    )


def set_word_automatic_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Clear one word's suppression lock; ``suppressed`` waits for the next reconcile (#824).

    A word set directly by ``set_word_suppressed_tool``, an explicit-list suppress-bleed /
    low-audibility apply, or Studio's Suppress toggle stays ``audibility_locked`` until this
    call. It does not itself change ``suppressed`` — run ``reconcile_transcript_tool`` after
    to get the computed target. Pass ``expected_text`` (the word text you read) to refuse the
    unlock if the word at ``word_index`` changed meanwhile; omit to skip. TOOL_TIMEBASE: source.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "SetTranscriptWordAutomatic",
            {
                "track_id": track_id,
                "source_id": source_id,
                "word_index": word_index,
                "expected_text": expected_text,
            },
        )
    )


def set_word_timing_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    start: float,
    end: float,
    source_id: str | None = None,
    expected_text: str | None = None,
) -> str:
    """Set one transcript word's start and end in source seconds (Studio Adjust word timing).

    ``word_index`` indexes the track's transcript, or the ``source_id`` recording's
    transcript when given. Pass ``expected_text`` to refuse the change if the word was
    edited meanwhile. Bounds are checked against the recording; a word that overlaps
    its neighbours comes back in ``context.warnings``. Submits
    ``SetTranscriptWordTiming``; undoable.
    """
    target = WordTimingTarget(track_id=track_id, source_id=source_id, word_index=word_index)
    ws = ProjectWorkspace.open(project_path)
    context = TranscriptService(ws).word_timing_context(target, expected_text=expected_text)
    reply = submit_host_document_command(
        project_path,
        "SetTranscriptWordTiming",
        {
            "target": context["target"],
            "expected_token": context["expected_token"],
            "start": start,
            "end": end,
        },
    )
    return to_json(host_command_result(reply))


def find_replace_transcript_tool(
    project_path: str,
    search: str,
    replacement: str,
    match_case: bool = False,
    dry_run: bool = False,
) -> str:
    """Replace a literal word or phrase everywhere in the transcript (Studio Find and replace).

    Matches whole words across every track and recording; punctuation around a word is
    kept. ``dry_run`` returns the preview (``matches``, ``count``, ``skipped_words``)
    and changes nothing. Otherwise every previewed match is replaced through
    ``ReplaceTranscriptMatches`` in one undo step, and ``replaced`` gives the count.
    For one word use ``correct_transcript_tool``.
    """
    ws = ProjectWorkspace.open(project_path)
    preview = TranscriptService(ws).preview_transcript_replacement(
        search, replacement, match_case=match_case
    )
    if dry_run:
        return to_json(preview)
    reply = submit_host_document_command(
        project_path,
        "ReplaceTranscriptMatches",
        {
            "search": search,
            "replacement": replacement,
            "match_case": match_case,
            "preview_token": preview["preview_token"],
        },
    )
    return to_json({**preview, **host_command_result(reply)})


def set_words_ignored_tool(
    project_path: str,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    ignored: bool,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Strike through and mute (or restore) a word range at render, without a cut.

    Text-and-audio hide (#633): unlike suppress, the words stay in the combined
    transcript; only their audio is muted, computed at render time and never
    written to ``Clip.mute_regions``. TOOL_TIMEBASE: source.

    Pass ``expected_text`` (the space-joined words you read for this range) to refuse the
    toggle if those words changed meanwhile; omit to skip.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "SetTranscriptWordsIgnored",
            {
                "track_id": track_id,
                "source_id": source_id,
                "start_word_index": start_word_index,
                "end_word_index": end_word_index,
                "ignored": ignored,
                "expected_text": expected_text,
            },
        )
    )


def apply_transcript_cleanup_tool(
    project_path: str,
    track_id: str,
    corrections: JsonObject,
) -> str:
    """Batch word + phrase fixes in one undoable history step.

    ``corrections``: ``{"words": [{word_index, text}], "phrases": [{start_word_index, end_word_index, text}]}``
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "ApplyTranscriptCleanup",
            {
                "track_id": track_id,
                "words": corrections.get("words"),
                "phrases": corrections.get("phrases"),
            },
        )
    )


def low_confidence_words_tool(project_path: str, threshold: float = 0.7) -> str:
    """List words below a confidence threshold for human review."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptService(ws).low_confidence_words(threshold))


def verify_transcript_tool(
    project_path: str,
    track_id: str,
    corrections: JsonObjectList,
) -> str:
    """Apply bulk corrections and mark words verified on a track's transcript."""
    return to_json(
        submit_host_command_result(
            project_path,
            "VerifyTranscript",
            {"track_id": track_id, "corrections": corrections},
        )
    )


def add_effect_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    preset: str | None = None,
    effect: str | None = None,
    params: JsonObject | None = None,
) -> str:
    """Add an effect (or preset) to a track or speaker's effect chain."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        submit_host_command_result(
            project_path,
            "AddEffect",
            {
                "track_id": resolve_track(ws.project, track_id=track_id, speaker=speaker),
                "preset": preset,
                "effect": effect,
                "params": params,
            },
        )
    )


def remove_effect_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    effect: str | None = None,
) -> str:
    """Remove an effect from a track or speaker's effect chain."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        submit_host_command_result(
            project_path,
            "RemoveEffect",
            {
                "track_id": resolve_track(ws.project, track_id=track_id, speaker=speaker),
                "effect": effect,
            },
        )
    )


def set_effect_bypass_tool(
    project_path: str,
    effect_index: int,
    bypass: bool,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Toggle bypass on one chain effect by index (TOOL_TIMEBASE: na)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        submit_host_command_result(
            project_path,
            "SetEffectBypass",
            {
                "track_id": resolve_track(ws.project, track_id=track_id, speaker=speaker),
                "effect_index": effect_index,
                "bypass": bypass,
            },
        )
    )


def list_effects_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """List the effect chain for a track or speaker."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).list_effects(track_id=track_id, speaker=speaker))


def analyze_cleanup_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Analyze a track for cleanup opportunities (silence, clicks, hum)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).analyze_cleanup(track_id=track_id, speaker=speaker))


def audio_diagnostics_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """Run audio diagnostics (clipping, hum, level) on a time window."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        AnalysisService(ws).audio_diagnostics(
            track_id=track_id, speaker=speaker, start_sec=start_sec, end_sec=end_sec
        )
    )


def recommend_fades_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Recommend fades at joins to hide edit artifacts."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).recommend_fades(track_id=track_id, speaker=speaker))


def apply_fade_recommendations_tool(
    project_path: str,
    recommendations: JsonObjectList,
) -> str:
    """Apply a list of fade recommendations (from ``recommend_fades_tool``) to the project."""
    return to_json(
        submit_host_command_result(
            project_path, "ApplyFadeRecommendationList", {"recommendations": recommendations}
        )
    )


def low_audibility_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """List words too quiet to hear relative to the mix."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).low_audibility_words(track_id=track_id, speaker=speaker))


def apply_low_audibility_suppression_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    words: JsonObjectList | None = None,
) -> str:
    """Suppress low-audibility transcript words, optionally only ``words``; leaves audio unchanged."""
    return to_json(
        submit_host_command_result(
            project_path,
            "SuppressLowAudibility",
            {"track_id": track_id, "speaker": speaker, "words": words},
        )
    )


def gate_overreach_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Report where noise gating muted speech on a track."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).gate_overreach(track_id=track_id, speaker=speaker))


def audibility_map_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Return per-word audibility scores for a track or speaker."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).audibility_map(track_id=track_id, speaker=speaker))


def flagged_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """List words flagged for review (suppressed, low-audibility, or bleed)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).flagged_words(track_id=track_id, speaker=speaker))


def reconciliation_status_tool(project_path: str) -> str:
    """Report transcript/timeline reconciliation status (stale vs current)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).reconciliation_status())


def reconcile_transcript_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    dry_run: bool | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """Re-run transcript/timeline reconciliation; dry_run previews without applying."""
    if dry_run is True:
        ws = ProjectWorkspace.open(project_path)
        return to_json(
            AnalysisService(ws).preview_reconcile_transcript(
                track_id=track_id, speaker=speaker, start_sec=start_sec, end_sec=end_sec
            )
        )
    return to_json(
        submit_host_command_result(
            project_path,
            "ReconcileTranscript",
            {
                "track_id": track_id,
                "speaker": speaker,
                "dry_run": dry_run,
                "start_sec": start_sec,
                "end_sec": end_sec,
            },
        )
    )


def bleed_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """List words contaminated by another speaker's microphone bleed."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        AnalysisService(ws).list_bleed_words(
            track_id=track_id,
            speaker=speaker,
            start_sec=start_sec,
            end_sec=end_sec,
        )
    )


def apply_bleed_suppression_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    words: JsonObjectList | None = None,
    exclude_words: JsonObjectList | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    apply: bool = True,
    dry_run: bool = False,
) -> str:
    """Suppress mic-bleed words (dry_run previews without applying)."""
    payload = {
        "track_id": track_id,
        "speaker": speaker,
        "words": words,
        "exclude_words": exclude_words,
        "start_sec": start_sec,
        "end_sec": end_sec,
    }
    if not (apply and not dry_run):
        checked = validate_payload("SuppressBleed", payload)
        ws = ProjectWorkspace.open(project_path)
        return to_json(
            AnalysisService(ws).preview_suppress_bleed(
                track_id=track_id,
                speaker=speaker,
                word_keys=checked["words"],
                exclude_word_keys=checked["exclude_words"],
                start_sec=start_sec,
                end_sec=end_sec,
            )
        )
    return to_json(submit_host_command_result(project_path, "SuppressBleed", payload))


def mute_off_speaker_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    apply: bool = True,
    dry_run: bool = False,
) -> str:
    """Mute a track wherever another speaker is talking and its own speaker is not.

    Use after transcript reconcile on a call recording whose track still carries another
    person's voice. A stretch is muted when another dialogue track has words there, this
    track has none, and this track holds nothing louder than a copy of that speaker.
    Each stretch is a visible muted region in Studio (Restore brings it back); History
    undoes the whole command. Preview with ``dry_run=true``.
    """
    ws = ProjectWorkspace.open(project_path)
    if not apply or dry_run:
        return to_json(
            AnalysisService(ws).preview_off_speaker_mute(track_id=track_id, speaker=speaker)
        )
    return to_json(
        run_audio_edit(
            ws,
            "mute_off_speaker",
            {"track_id": track_id, "speaker": speaker},
            lock_timeout=REQUEST_RENDER_LOCK_TIMEOUT_SEC,
        )
    )


def overlap_duplicates_tool(
    project_path: str,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """Find duplicate words across tracks in an overlap window."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).overlap_duplicates(start_sec=start_sec, end_sec=end_sec))


def apply_transcript_gate_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    apply: bool = True,
    dry_run: bool = False,
    align_retained_bleed: bool = True,
    override_placement_lock: bool = False,
) -> str:
    """Apply an acoustic bleed plan to fresh dialogue stems and persist its source scope.

    Retained speech and unresolved audio stay open. Later renders reuse the plan's
    policy and scope. Supported local retained-bleed alignment runs by default and
    respects saved timing choices. Alignment can trigger normal transcript reconciliation.
    """
    ws = ProjectWorkspace.open(project_path)
    params: dict[str, Any] = {
        "track_id": track_id,
        "speaker": speaker,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "align_retained_bleed": align_retained_bleed,
        "override_placement_lock": override_placement_lock,
    }
    if not apply or dry_run:
        return to_json(AnalysisService(ws).preview_bleed_mute(**params))
    return to_json(
        run_audio_edit(ws, "apply_bleed_mute", params, lock_timeout=REQUEST_RENDER_LOCK_TIMEOUT_SEC)
    )


def align_retained_bleed_tool(
    project_path: str,
    track_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    apply: bool = True,
    override_placement_lock: bool = False,
) -> str:
    """Align supported complete direct phrases locally while keeping uncertain audio intact.

    Preview with apply=False. Saved manual/declined decisions take priority.
    Legacy placement overrides require an explicit timeline window.
    """
    ws = ProjectWorkspace.open(project_path)
    params: dict[str, Any] = {
        "track_id": track_id,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "override_placement_lock": override_placement_lock,
    }
    if not apply:
        return to_json(AnalysisService(ws).preview_retained_bleed_alignment(**params))
    return to_json(
        run_audio_edit(
            ws, "align_retained_bleed", params, lock_timeout=REQUEST_RENDER_LOCK_TIMEOUT_SEC
        )
    )


def set_retained_bleed_alignment_mode_tool(
    project_path: str,
    decision_id: str,
    mode: Literal["auto", "manual", "declined"],
    track_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    override_placement_lock: bool = False,
) -> str:
    """Save a timing choice for an applied decision or a proposal from the same window.

    Manual and declined choices prevent later automatic correction; auto resets that choice.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "SetBleedAlignmentMode",
            {
                "decision_id": decision_id,
                "mode": mode,
                "track_id": track_id,
                "start_sec": start_sec,
                "end_sec": end_sec,
                "override_placement_lock": override_placement_lock,
            },
        )
    )


def register(mcp: MCPServer) -> None:
    """Register timeline tools on the MCP server."""
    mutating = {
        strip_silence_tool,
        ripple_delete_tool,
        ripple_delete_text_tool,
        move_segment_tool,
        move_by_text_tool,
        insert_gap_tool,
        fade_joins_tool,
        crossfade_joins_tool,
        set_clip_fade_tool,
        set_join_mode_tool,
        set_clip_join_tool,
        trim_clip_edge_tool,
        shorten_gaps_tool,
        split_clip_tool,
        duplicate_segment_tool,
        fill_with_room_tone_tool,
        add_chapter_tool,
        remove_chapter_tool,
        correct_transcript_tool,
        correct_transcript_phrase_tool,
        set_word_suppressed_tool,
        set_word_automatic_tool,
        set_words_ignored_tool,
        apply_transcript_cleanup_tool,
        verify_transcript_tool,
        add_effect_tool,
        remove_effect_tool,
        set_effect_bypass_tool,
        apply_fade_recommendations_tool,
        apply_low_audibility_suppression_tool,
        reconcile_transcript_tool,
        apply_bleed_suppression_tool,
        set_retained_bleed_alignment_mode_tool,
    }
    mutating.discard(split_clip_tool)  # uses DocumentSyncService.submit
    mutating.discard(move_clips_tool)
    mutating.discard(fade_joins_tool)
    mutating.discard(crossfade_joins_tool)
    mutating.discard(apply_fade_recommendations_tool)
    mutating.discard(ripple_delete_text_tool)
    for fn in (
        inspect_clip_bleed_tool,
        restore_clip_bleed_tool,
        strip_silence_tool,
        ripple_delete_tool,
        ripple_delete_text_tool,
        move_segment_tool,
        move_clips_tool,
        move_by_text_tool,
        insert_gap_tool,
        fade_joins_tool,
        crossfade_joins_tool,
        set_clip_fade_tool,
        set_join_mode_tool,
        set_clip_join_tool,
        trim_clip_edge_tool,
        roll_clip_join_tool,
        shorten_gaps_tool,
        split_clip_tool,
        delete_clips_tool,
        duplicate_segment_tool,
        copy_segment_tool,
        paste_segment_tool,
        list_clips_tool,
        list_applied_edits_tool,
        render_status_tool,
        fill_with_room_tone_tool,
        add_chapter_tool,
        remove_chapter_tool,
        list_chapters_tool,
        check_loudness_tool,
        correct_transcript_tool,
        correct_transcript_phrase_tool,
        set_word_suppressed_tool,
        set_word_automatic_tool,
        set_words_ignored_tool,
        set_word_timing_tool,
        find_replace_transcript_tool,
        apply_transcript_cleanup_tool,
        low_confidence_words_tool,
        verify_transcript_tool,
        add_effect_tool,
        remove_effect_tool,
        set_effect_bypass_tool,
        list_effects_tool,
        analyze_cleanup_tool,
        audio_diagnostics_tool,
        recommend_fades_tool,
        apply_fade_recommendations_tool,
        low_audibility_words_tool,
        apply_low_audibility_suppression_tool,
        gate_overreach_tool,
        audibility_map_tool,
        flagged_words_tool,
        reconciliation_status_tool,
        reconcile_transcript_tool,
        bleed_words_tool,
        apply_bleed_suppression_tool,
        overlap_duplicates_tool,
        apply_transcript_gate_tool,
        mute_off_speaker_tool,
        align_retained_bleed_tool,
        set_retained_bleed_alignment_mode_tool,
    ):
        mcp.tool()(notify_after_mutation(fn) if fn in mutating else fn)
