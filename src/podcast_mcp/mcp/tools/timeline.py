from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools.agent_notify import notify_after_mutation
from podcast_mcp.services import EditService, ProjectWorkspace


def strip_silence_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    threshold_db: float = -40.0,
    min_duration_sec: float = 0.5,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Rebuild a track from speech islands between detected silences.

    ``use_inaudible_opt`` is accepted for API compatibility but ignored.
    """
    ws = ProjectWorkspace.open(project_path)
    result = EditService(ws).strip_silence(
        track_id=track_id,
        speaker=speaker,
        threshold_db=threshold_db,
        min_duration_sec=min_duration_sec,
        use_inaudible_opt=use_inaudible_opt,
    )
    return to_json(result)


def ripple_delete_tool(
    project_path: str,
    start: float,
    end: float,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Ripple-delete a timeline range across dialogue tracks.

    Default inaudible opt absorbs trailing quiet air to ~0.4s before the next
    word. For punchline-to-pivot / leave-a-beat handoffs, call
    ``suggest_handoff_cut_tool`` first and pass ``use_inaudible_opt=false`` so
    local snap does not pull mid-silence bounds onto speech.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).ripple_delete(
            start,
            end,
            use_inaudible_opt=use_inaudible_opt,
        )
    )


def ripple_delete_text_tool(
    project_path: str,
    query: str,
    use_inaudible_opt: bool | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).ripple_delete_text(
            query,
            use_inaudible_opt=use_inaudible_opt,
        )
    )


def move_segment_tool(
    project_path: str,
    source_start: float,
    source_end: float,
    insert_at: float,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).move_segment(source_start, source_end, insert_at))


def move_clips_tool(project_path: str, clips_json: str) -> str:
    """Move clips in session time and/or onto another track (no neighbor ripple).

    ``clips_json`` is a JSON array of ``{clip_id, timeline_start, track_id}``.
    Inter-track moves keep the originating media via ``source_id``. Unlike
    ``move_segment_tool``, this does not cut a range on every dialogue lane.
    """
    from podcast_mcp.mcp.tools.agent_document import submit_host_document_command

    raw = json.loads(clips_json)
    if not isinstance(raw, list):
        raise ValueError("clips_json must be a JSON array")
    result = submit_host_document_command(
        project_path,
        "MoveClips",
        {"clips": raw},
    )
    payload = (result.get("command") or {}).get("payload") or {}
    return to_json(payload.get("result") or {"ok": result.get("ok"), "operation": "move_clips"})


def move_by_text_tool(
    project_path: str,
    source_query: str,
    destination_query: str,
    position: str = "after",
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).move_by_text(source_query, destination_query, position))


def insert_gap_tool(
    project_path: str,
    at_time: float,
    duration_sec: float = 1.0,
) -> str:
    """Open pure silence on the timeline (split + shift).

    Do not use to fake a beat after a tight handoff unless the user asks —
    prefer keeping existing room tone via ``suggest_handoff_cut_tool`` bounds.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).insert_gap(at_time, duration_sec))


def fade_joins_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    fade_ms: int | None = None,
    dry_run: bool = False,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).fade_joins(
            track_id=track_id,
            speaker=speaker,
            fade_ms=fade_ms,
            dry_run=dry_run,
        )
    )


def crossfade_joins_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    fade_ms: int | None = None,
    dry_run: bool = False,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).crossfade_joins(
            track_id=track_id,
            speaker=speaker,
            fade_ms=fade_ms,
            dry_run=dry_run,
        )
    )


def set_clip_fade_tool(
    project_path: str,
    clip_id: str,
    fade_in_ms: int,
    fade_out_ms: int,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).set_clip_fade(clip_id, fade_in_ms, fade_out_ms))


def set_join_mode_tool(
    project_path: str,
    clip_id: str,
    join_in_mode: str,
) -> str:
    """Set join_in_mode on one clip: fade | crossfade | cut (TOOL_TIMEBASE: na)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).set_join_mode(clip_id, join_in_mode))


def shorten_gaps_tool(
    project_path: str,
    max_gap_sec: float = 0.35,
    use_inaudible_opt: bool | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).shorten_word_gaps(
            max_gap_sec,
            use_inaudible_opt=use_inaudible_opt,
        )
    )


def split_clip_tool(
    project_path: str,
    at_time: float,
    track_id: str | None = None,
    speaker: str | None = None,
    track_ids_json: str | None = None,
) -> str:
    """Split clip(s) at a timeline timecode.

    Pass ``track_ids_json`` as a JSON array for multi-track blade cuts.
    When omitted, uses ``track_id`` / ``speaker``, or all dialogue tracks.
    Submits ``SplitAtTime`` on the document plane (same path as Sharecut Studio blade).
    """
    import json

    from podcast_mcp.mcp.tools.agent_document import submit_host_document_command
    from podcast_mcp.util.tracks import dialogue_track_ids

    ws = ProjectWorkspace.open(project_path)
    track_ids: list[str] | None = None
    if track_ids_json:
        raw = json.loads(track_ids_json)
        if not isinstance(raw, list):
            raise ValueError("track_ids_json must be a JSON array of track ids")
        track_ids = [str(t) for t in raw]
    elif track_id is not None or speaker is not None:
        track_ids = [EditService(ws)._resolve(track_id, speaker)]
    else:
        track_ids = dialogue_track_ids(ws.project)

    result = submit_host_document_command(
        project_path,
        "SplitAtTime",
        {"at_time": float(at_time), "track_ids": track_ids},
    )
    payload = (result.get("command") or {}).get("payload") or {}
    return to_json(payload.get("result") or {"ok": result.get("ok"), "operation": "split"})


def duplicate_segment_tool(
    project_path: str,
    source_start: float,
    source_end: float,
    insert_at: float,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).duplicate_segment(source_start, source_end, insert_at))


def list_clips_tool(project_path: str, track_id: str | None = None) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).list_clips(track_id))


def list_applied_edits_tool(
    project_path: str,
    track_id: str | None = None,
    timeline_start: float | None = None,
    timeline_end: float | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).list_applied_edits(
            track_id=track_id,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
        )
    )


def render_status_tool(project_path: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).render_status())


def fill_with_room_tone_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).fill_room_tone(track_id=track_id, speaker=speaker))


def add_chapter_tool(project_path: str, at_time: float, title: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).add_chapter(at_time, title))


def remove_chapter_tool(project_path: str, title: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).remove_chapter(title))


def list_chapters_tool(project_path: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).list_chapters())


def check_loudness_tool(project_path: str, audio_path: str | None = None) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).check_loudness(audio_path))


def correct_transcript_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    new_text: str,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    EditService(ws).correct_word(track_id, word_index, new_text)
    return to_json({"track_id": track_id, "word_index": word_index, "text": new_text})


def correct_transcript_phrase_tool(
    project_path: str,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    new_text: str,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    EditService(ws).correct_phrase(track_id, start_word_index, end_word_index, new_text)
    return to_json(
        {
            "track_id": track_id,
            "start_word_index": start_word_index,
            "end_word_index": end_word_index,
            "text": new_text,
        }
    )


def set_word_suppressed_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    suppressed: bool,
) -> str:
    """Toggle suppressed on one per-track word (TOOL_TIMEBASE: source)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).set_word_suppressed(track_id, word_index, suppressed))


def apply_transcript_cleanup_tool(
    project_path: str,
    track_id: str,
    corrections_json: str,
) -> str:
    """Batch word + phrase fixes in one undoable history step.

    JSON: ``{"words": [{word_index, text}], "phrases": [{start_word_index, end_word_index, text}]}``
    """
    ws = ProjectWorkspace.open(project_path)
    payload = json.loads(corrections_json)
    words = payload.get("words")
    phrases = payload.get("phrases")
    n = EditService(ws).apply_transcript_cleanup(track_id, words=words, phrases=phrases)
    return to_json({"track_id": track_id, "applied": n})


def low_confidence_words_tool(project_path: str, threshold: float = 0.7) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).low_confidence_words(threshold))


def verify_transcript_tool(
    project_path: str,
    track_id: str,
    corrections_json: str,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    corrections = json.loads(corrections_json)
    n = EditService(ws).verify_transcript(track_id, corrections)
    return to_json({"verified": n})


def add_effect_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    preset: str | None = None,
    effect: str | None = None,
    params_json: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    params = json.loads(params_json) if params_json else None
    return to_json(
        EditService(ws).add_effect(
            track_id=track_id,
            speaker=speaker,
            preset=preset,
            effect=effect,
            params=params,
        )
    )


def remove_effect_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    effect: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).remove_effect(track_id=track_id, speaker=speaker, effect=effect))


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
        EditService(ws).set_effect_bypass(
            track_id=track_id,
            speaker=speaker,
            effect_index=effect_index,
            bypass=bypass,
        )
    )


def list_effects_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).list_effects(track_id=track_id, speaker=speaker))


def analyze_cleanup_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).analyze_cleanup(track_id=track_id, speaker=speaker))


def audio_diagnostics_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).audio_diagnostics(
            track_id=track_id, speaker=speaker, start_sec=start_sec, end_sec=end_sec
        )
    )


def recommend_fades_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).recommend_fades(track_id=track_id, speaker=speaker))


def apply_fade_recommendations_tool(
    project_path: str,
    recommendations_json: str,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    recs = json.loads(recommendations_json)
    if not isinstance(recs, list):
        raise ValueError("recommendations_json must be a JSON array")
    return to_json(EditService(ws).apply_fade_recommendations(recs))


def low_audibility_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).low_audibility_words(track_id=track_id, speaker=speaker))


def apply_low_audibility_suppression_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    words_json: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    words = json.loads(words_json) if words_json else None
    if words is not None and not isinstance(words, list):
        raise ValueError("words_json must be a JSON array")
    return to_json(
        EditService(ws).suppress_low_audibility(
            track_id=track_id, speaker=speaker, words_json=words
        )
    )


def gate_overreach_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).gate_overreach(track_id=track_id, speaker=speaker))


def audibility_map_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).audibility_map(track_id=track_id, speaker=speaker))


def flagged_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).flagged_words(track_id=track_id, speaker=speaker))


def reconciliation_status_tool(project_path: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).reconciliation_status())


def reconcile_transcript_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    dry_run: bool | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).reconcile_transcript(
            track_id=track_id,
            speaker=speaker,
            dry_run=dry_run,
            start_sec=start_sec,
            end_sec=end_sec,
        )
    )


def bleed_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).list_bleed_words(
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
    words_json: str | None = None,
    exclude_words_json: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    apply: bool = True,
    dry_run: bool = False,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    words = json.loads(words_json) if words_json else None
    exclude = json.loads(exclude_words_json) if exclude_words_json else None
    if words is not None and not isinstance(words, list):
        raise ValueError("words_json must be a JSON array")
    if exclude is not None and not isinstance(exclude, list):
        raise ValueError("exclude_words_json must be a JSON array")
    return to_json(
        EditService(ws).suppress_bleed(
            track_id=track_id,
            speaker=speaker,
            words_json=words,
            exclude_words_json=exclude,
            start_sec=start_sec,
            end_sec=end_sec,
            apply=apply and not dry_run,
        )
    )


def overlap_duplicates_tool(
    project_path: str,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(EditService(ws).overlap_duplicates(start_sec=start_sec, end_sec=end_sec))


def apply_transcript_gate_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    apply: bool = True,
    dry_run: bool = False,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        EditService(ws).apply_bleed_mute(
            track_id=track_id,
            speaker=speaker,
            start_sec=start_sec,
            end_sec=end_sec,
            apply=apply and not dry_run,
        )
    )


def register(mcp: MCPServer) -> None:
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
        shorten_gaps_tool,
        split_clip_tool,
        duplicate_segment_tool,
        fill_with_room_tone_tool,
        add_chapter_tool,
        remove_chapter_tool,
        correct_transcript_tool,
        correct_transcript_phrase_tool,
        set_word_suppressed_tool,
        apply_transcript_cleanup_tool,
        verify_transcript_tool,
        add_effect_tool,
        remove_effect_tool,
        set_effect_bypass_tool,
        apply_fade_recommendations_tool,
        apply_low_audibility_suppression_tool,
        reconcile_transcript_tool,
        apply_bleed_suppression_tool,
        apply_transcript_gate_tool,
    }
    mutating.discard(split_clip_tool)  # uses DocumentSyncService.submit
    mutating.discard(move_clips_tool)
    for fn in (
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
        shorten_gaps_tool,
        split_clip_tool,
        duplicate_segment_tool,
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
    ):
        mcp.tool()(notify_after_mutation(fn) if fn in mutating else fn)
