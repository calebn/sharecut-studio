from __future__ import annotations

import sys

from mcp.server import MCPServer

from podcast_mcp import __version__
from podcast_mcp.mcp.tools import register_all
from podcast_mcp.util.progress_install import install_mcp_progress

mcp = MCPServer("podcast-mcp", version=__version__)
install_mcp_progress(mcp)
register_all(mcp)

_HELP_TEXT = f"""podcast-mcp {__version__}

Sharecut Studio MCP server. Runs on stdio by default so any MCP
harness (Claude Code, Claude Desktop, Cursor, Cline, Windsurf, ...)
can launch it with zero configuration:

    {{\"mcpServers\": {{\"podcast\": {{\"command\": \"podcast-mcp\"}}}}}}

Options:
  -h, --help       Show this help and exit.
  -V, --version    Print the version and exit.

For co-editing with the DAW open, the GUI also serves MCP over
Streamable HTTP at http://127.0.0.1:8765/mcp (Menu > Connect agent...).
Docs: https://docs.sharecut.studio/#/mcp-setup"""

# Re-export handlers for tests and direct invocation
from podcast_mcp.mcp.tools.align import (  # noqa: E402, F401
    align_brief_tool,
    align_done_tool,
    align_status_tool,
    align_waive_tool,
)
from podcast_mcp.mcp.tools.clips import (  # noqa: E402, F401
    approve_social_clips_tool,
    export_social_clips_tool,
    list_social_clips_tool,
    propose_social_clips_tool,
    reject_social_clips_tool,
    social_clip_report_tool,
)
from podcast_mcp.mcp.tools.comments import (  # noqa: E402, F401
    add_comment_action_tool,
    add_comment_reply_tool,
    add_comment_tool,
    delete_comment_tool,
    get_comment_tool,
    list_comments_tool,
    resolve_comment_tool,
    set_comment_action_done_tool,
    update_comment_tool,
)
from podcast_mcp.mcp.tools.edits import (  # noqa: E402, F401
    apply_edit_plan_tool,
    apply_edits,
    approve_edits_tool,
    build_edit_context,
    cut_text_match_tool,
    cut_time_range_tool,
    cut_utterance_tool,
    cut_words_tool,
    edit_impact_report_tool,
    join_label_tool,
    join_qa_sweep_tool,
    join_quality_tool,
    list_edit_decisions_tool,
    preview_inaudible_cut_tool,
    propose_edits,
    reject_edits_tool,
    revert_applied_edit_tool,
    search_transcript_tool,
    suggest_handoff_cut_tool,
    update_pending_edit_tool,
)
from podcast_mcp.mcp.tools.episode import (  # noqa: E402, F401
    episode_create,
    track_add,
    track_add_empty_tool,
    track_remove_tool,
    track_reorder_tool,
    track_set_media_tool,
    track_set_meta_tool,
)
from podcast_mcp.mcp.tools.gui import open_gui_tool  # noqa: E402, F401
from podcast_mcp.mcp.tools.history import (  # noqa: E402, F401
    history_diff_tool,
    history_goto_tool,
    history_list,
    history_record,
    history_redo,
    history_status_tool,
    history_undo,
)
from podcast_mcp.mcp.tools.ingest import (  # noqa: E402, F401
    ingest_import_folder_tool,
    ingest_suggest_alignment_tool,
    ingest_verify_alignment_tool,
    play_compare_tool,
)
from podcast_mcp.mcp.tools.pipeline import (  # noqa: E402, F401
    bounce_audio_tool,
    export_audio_tool,
    pipeline_analyze_tool,
    pipeline_get_config_tool,
    pipeline_run,
    pipeline_set_config_tool,
    render_final,
    render_preview,
    set_envelope,
)
from podcast_mcp.mcp.tools.play import (  # noqa: E402, F401
    audition_context_tool,
    play_ab_tool,
    play_ab_wavs_tool,
    play_audio_tool,
    play_compose_tool,
    play_pending_preview_tool,
    play_transcript_query_tool,
)
from podcast_mcp.mcp.tools.record import (  # noqa: E402, F401
    record_discard_take_tool,
    record_land_tool,
    record_pause_tool,
    record_resume_tool,
    record_start_tool,
    record_state_tool,
    record_stop_tool,
)
from podcast_mcp.mcp.tools.review import (  # noqa: E402, F401
    create_record_room_tool,
    create_review_share_tool,
    list_review_versions_tool,
    publish_review_version_tool,
    revoke_record_room_tool,
    set_active_review_version_tool,
)
from podcast_mcp.mcp.tools.session import (  # noqa: E402, F401
    get_session_presence_tool,
    get_session_state_tool,
    seek_session_tool,
    set_session_mode_tool,
    set_session_playing_tool,
    set_session_region_tool,
    set_session_selection_tool,
    stop_session_tool,
)
from podcast_mcp.mcp.tools.timeline import (  # noqa: E402, F401
    add_chapter_tool,
    add_effect_tool,
    analyze_cleanup_tool,
    apply_fade_recommendations_tool,
    apply_low_audibility_suppression_tool,
    apply_transcript_cleanup_tool,
    audio_diagnostics_tool,
    check_loudness_tool,
    correct_transcript_phrase_tool,
    correct_transcript_tool,
    crossfade_joins_tool,
    duplicate_segment_tool,
    fade_joins_tool,
    fill_with_room_tone_tool,
    gate_overreach_tool,
    insert_gap_tool,
    list_applied_edits_tool,
    list_chapters_tool,
    list_clips_tool,
    list_effects_tool,
    low_audibility_words_tool,
    low_confidence_words_tool,
    move_by_text_tool,
    move_clips_tool,
    move_segment_tool,
    recommend_fades_tool,
    remove_chapter_tool,
    remove_effect_tool,
    render_status_tool,
    ripple_delete_text_tool,
    ripple_delete_tool,
    set_clip_fade_tool,
    set_effect_bypass_tool,
    set_join_mode_tool,
    set_word_suppressed_tool,
    shorten_gaps_tool,
    split_clip_tool,
    strip_silence_tool,
    verify_transcript_tool,
)
from podcast_mcp.mcp.tools.transcript import (  # noqa: E402, F401
    export_transcript,
    get_transcript,
    precorrect_transcript_tool,
    transcribe_track,
    transcript_refine_brief_tool,
    transcript_refine_done_tool,
    transcript_refine_status_tool,
    transcript_refine_waive_tool,
)


def main() -> None:
    if any(arg in ("-h", "--help") for arg in sys.argv[1:]):
        print(_HELP_TEXT)
        return
    if any(arg in ("-V", "--version") for arg in sys.argv[1:]):
        print(f"podcast-mcp {__version__}")
        return
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
