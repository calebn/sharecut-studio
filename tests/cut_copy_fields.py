"""Fields of the models a source cut reaches through sections ``_cut_copy`` shares.

Each is read-only on the cut path (tests/test_cut_copy_write_scope.py hashes the input around
every shape of cut). Listing a new field here says the same; a field a cut writes needs a
copy in ``_SECTION_COPIES`` instead.
"""

from __future__ import annotations

SHARED_FIELDS: dict[str, str] = {
    "AppliedEditRecord": (
        "applied_at boundary_mode crossfade_ms cut_confidence decision_ids id operation "
        "params reason source_end source_start timeline_end timeline_start track_ids"
    ),
    "ArchivedTranscriptWord": ("ordinal word"),
    "AutomationEnvelope": ("parameter points track_id"),
    "AutomationPoint": ("id time value"),
    "ChapterMarker": ("image_url time title"),
    "Clip": (
        "bleed_restore fade_in_ms fade_out_ms id join_in_mode mute_regions "
        "off_speaker_mute_regions source_end source_id source_start timeline_start track_id"
    ),
    "ClipBleedRestore": ("regions source_sha256"),
    "ClipMuteRegion": ("end_s fade_in_ms fade_out_ms fill gain_db start_s"),
    "ClipOffSpeakerMuteRegion": ("end_s fade_in_ms fade_out_ms start_s"),
    "CombinedTranscript": ("utterances"),
    "CombinedUtterance": ("end source_id speaker start text track_id"),
    "CommentActionItem": ("completed_at completed_by done id text"),
    "CommentReply": ("author body created_at id"),
    "CutSpeech": ("spans tracks"),
    "CutSpeechTrack": ("sound_spans speaker track_id words"),
    "CutSpeechWord": ("text timeline_end timeline_start"),
    "DocumentSyncSection": ("last_command"),
    "FeedSection": ("first_exported_at guid pins show_id"),
    "Pin": ("basis by value"),
    "ExactRangeTarget": ("clips intervals kind media_seals track_ids"),
    "HistoryEntry": ("created_at id label operation params snapshot_file"),
    "InsertAnchor": ("at_sec kind offset_s side source_id source_sec track_id"),
    "MixSection": ("automation_envelopes processing_chains"),
    "PipelineRun": ("id started_at steps"),
    "PipelineStepLog": ("finished_at message started_at status step"),
    "ProcessingChain": ("effects track_id"),
    "ProcessingEffect": ("bypass effect params"),
    "ProjectHistory": ("cursor entries"),
    "ProxyClipBasis": (
        "origin_track_id source_end source_id source_start timeline_end timeline_start track_id"
    ),
    "ProxyManifestGeneration": ("artifacts occurrences project_basis revision tracks"),
    "ProxyOccurrenceBinding": ("artifact_id output_track_id"),
    "ProxyProjectBasis": ("clips history_head_id render_hashes"),
    "ProxyPublishedArtifact": (
        "bitrate_kbps chunk_count chunk_sec chunk_sha256 codec context_track_id duration_sec "
        "hash input_hash object_store_prefix object_store_uploaded_at overlap_ms"
    ),
    "RangeInterval": ("end start"),
    "RecordSessionRecord": ("number session_id target_kind"),
    "RenderArtifacts": ("mastered premix"),
    "RenderInvalidation": ("at id reason timeline_end timeline_start track_ids"),
    "RenderSection": (
        "artifacts invalidations last_completed_step last_reconciliation_hash pipeline_runs "
        "proxy_manifests reconciliation_stale"
    ),
    "RetainedBleedAlignmentDecision": (
        "bleed_track_id direct_track_id end_s evidence_revision id media_key mode offset_sec "
        "previous_timeline_start provenance source_id start_s timeline_start"
    ),
    "ReviewMixVersion": (
        "audio_relpath created_at duration_sec id label mp3_relpath object_store_key "
        "object_store_uploaded_at sha256 source"
    ),
    "RoomToneFill": ("end_s source_id start_s"),
    "SavedDocumentCommand": (
        "base_server_seq causation_id client_id client_seq command_id payload role type"
    ),
    "SessionSuggestion": (
        "anchor at_sec end_anchor from_sec id kind room_tone selected_take session_id session_number "
        "status takes to_sec track_follows track_ids"
    ),
    "SocialClipCandidate": (
        "approved caption_suggestion end exported_path id reasons review_required score "
        "speaker start title_suggestion track_id transcript_excerpt"
    ),
    "SocialSection": ("clip_candidates"),
    "SoundActionRecord": ("action end_s source_id start_s track_id"),
    "SourceClippingRegion": ("end_s start_s"),
    "SourceRecording": (
        "channels clipping_regions clipping_truncated duration_sec id label offset_sec path "
        "sample_rate speaker"
    ),
    "SourceSpan": ("end_s start_s"),
    "SpeakerIngestAlignment": ("align_method content_align_sec session_start_in_file_sec"),
    "SpeakerSplit": ("backend crosstalk_lane crosstalk_mode id lanes media_path method turns"),
    "SpeakerTurnRecord": ("confidence end_s speakers start_s"),
    "StagedComment": ("author body id recording_ms timeline_offset_s"),
    "StagedRoomTone": ("channels duration_s path sample_rate source_id track_id track_label"),
    "StagedTake": (
        "comments duration_s offset_s segment_index source_id take_index track_id track_label"
    ),
    "TimelineComment": (
        "action_items author body created_at edit_decision_id id replies resolved resolved_at "
        "resolved_by review_version_id timeline_end timeline_spans timeline_start track_ids "
        "updated_at"
    ),
    "Transcript": (
        "alignment_score_method archived_words audio_mtime_ns audio_sha256 audio_size "
        "language silence_filter_fingerprint source_id track_id user_edited "
        "vocabulary_revision word_aligner words"
    ),
    "TranscriptWord": (
        "alignment_score audibility_locked audibility_status confidence dominant_track end "
        "ignored overlong snapped_from speaker_match_score speaker_match_track start "
        "suppressed suspect_hallucination text timing_edited trimmed_from"
    ),
}
