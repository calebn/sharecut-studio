# Capabilities

Host product capabilities and which adapters exist (Sharecut Studio command / GUI /
keyboard, MCP, CLI, skill). Source of truth:
[`contracts/capabilities.manifest.json`](https://github.com/calebn/sharecut-studio/blob/main/contracts/capabilities.manifest.json).

Schema: [capabilities.manifest.schema.json](../schemas/capabilities.manifest.schema.json).
Contributor recipe:
[`docs/entry-points.md`](https://github.com/calebn/sharecut-studio/blob/main/docs/entry-points.md).

This is **not** the guest share ACL cap set (`play` / `view` / `comment` / …).
Those unlock guest HTTP and [Remote MCP](#/remote-mcp) tools. The **MCP** column
lists **host stdio** tool names. Share agents call guest HTTP /
`guest_submit_document_command` (see [Remote MCP](#/remote-mcp)), not
`split_clip_tool` / `play_audio_tool`. `omit.guest` / the Host-only column is a
documentation annotation, not the runtime share gate.

<!-- capabilities:generated -->

> **Auto-generated** from [`contracts/capabilities.manifest.json`](https://github.com/calebn/sharecut-studio/blob/main/contracts/capabilities.manifest.json). Do not edit by hand — run `make schema-export`.

**118** capabilities · **102** Sharecut Studio commands · **54** keyed · **180** MCP tools · **17** skills on rows (+ **19** hub skills).

Keyboard chords: [UX shortcuts](https://ux.sharecut.studio/#/shortcuts). Document plane: [Document commands](#/document-commands). Guest MCP allowlist: [Remote MCP](#/remote-mcp).

## Sharecut Studio capabilities

Effect `project` changes the saved project, review state, transcripts or artifacts, and needs an MCP or CLI surface (or an owner-approved reason, shown in the CLI column). `session` changes live unsaved state; `view` changes only this client's display.

| Label | Effect | Command | Keyboard | Touch | GUI | MCP | CLI | Skill | Host-only | Presence |
| ----- | ------ | ------- | -------- | ----- | --- | --- | --- | ----- | --------- | -------- |
| Play / pause | session | `transport.togglePlay` | `Space` | — | `transport.play` | `set_session_playing_tool`, `play_audio_tool` | — | `podcast-play-audition` | — | anchor · look |
| Seek playhead | session | `transport.seek` | — (not industry-standard; menu/toolbar or unkeyed) | — | — | `seek_session_tool` | — | — | — | — |
| Stop playback | session | `transport.stop` | `K` | — | `transport.stop` | `stop_session_tool` | — | — | — | anchor · look |
| Audition Full mix / Edited stems / Original | session | `transport.audition` | — (not industry-standard; Full mix/Edited stems/Original toggle) | — | `transport.audition` | — | — | `podcast-play-audition` | — | anchor · hear |
| Follow | session | `presence.follow` | — (not industry-standard; avatar click) | — | `presence.avatarStack` | `get_session_presence_tool` | — | — | — | none · none |
| Stop following | session | `presence.unfollow` | `Escape` | — | `presence.followBanner` | — | — | — | — | none · none |
| Select tool | view | `tool.select` | `V` | — | `toolModeToggle` | — | — | — | — | none · none |
| Blade tool | view | `tool.blade` | `C` | — | `toolModeToggle` | — | — | — | — | none · none |
| Exit comment mode | view | `review.exitCommentMode` | `Escape` | — | — | — | — | — | — | — |
| Clear selection | session | `edit.clearSelection` | `Escape` | — | — | — | — | — | — | — |
| Toggle comment mode | view | `review.toggleCommentMode` | `Mod+Shift+C` | — | `transport.comment` | — | — | — | — | none · none |
| Resolve comment | project | `comment.resolve` | — (Direct comment card gesture and button; no standard shortcut) | `swipe-left` | `mobileShell.gesture.swipeLeftComment` | `resolve_comment_tool` | `podcast comment resolve` | — | yes | none · none |
| Apply tighten hit | project | `tighten.applyHit` | `Enter` | — | `tightenPanel` | `approve_edits_tool` | `podcast edit approve` | `podcast-tighten-dialogue` | — | none · none |
| Skip tighten hit | project | `tighten.skipHit` | `Backspace` | — | `tightenPanel` | `reject_edits_tool` | `podcast edit reject` | `podcast-tighten-dialogue` | — | none · none |
| Apply eligible tighten hits | project | `tighten.applyAllSafe` | `Mod+Shift+Enter` | — | `tightenPanel` | `approve_edits_tool` | `podcast edit approve --all-safe` | `podcast-tighten-dialogue` | — | none · none |
| Preview tighten hit | session | `tighten.previewHit` | `P` | — | `tightenPanel` | — | — | `podcast-tighten-dialogue` | — | none · none |
| Go to tighten hit | session | `tighten.goToHit` | — (pointer/row action; seek+select) | — | `tightenPanel` | — | — | `podcast-tighten-dialogue` | — | time · look |
| Restore layout | view | `layout.default` | `Mod+1` | — | `layoutChip` | — | — | — | — | none · none |
| Maximize timeline | view | `layout.timeline` | `Mod+2` | — | `transport.layout` | — | — | — | — | none · none |
| Maximize transcript | view | `layout.text` | `Mod+3` | — | `transport.menu` | — | — | — | — | none · none |
| Review layout | view | `layout.review` | `Mod+4` | — | `transport.menu` | — | — | — | — | none · none |
| Nudge playhead back | session | `navigation.nudgePlayheadBack` | `ArrowLeft` | — | — | — | — | — | — | — |
| Nudge playhead forward | session | `navigation.nudgePlayheadForward` | `ArrowRight` | — | — | — | — | — | — | — |
| Go to start | session | `navigation.goToStart` | `Home` | — | — | — | — | — | — | — |
| Go to end | session | `navigation.goToEnd` | `End` | — | — | — | — | — | — | — |
| Blade cut | project | `edit.bladeCut` | `Mod+K` | `long-press-empty` | `editingToolRail`, `timeline`, `timeline.createMenu` | `split_clip_tool` | — | — | — | time · none |
| Confirm blade cut | project | `edit.bladeCut.confirm` | — (not industry-standard; menu/toolbar or unkeyed) | — | `bladeConfirmSheet` | `split_clip_tool` | — | — | — | none · none |
| Cancel blade cut | view | `edit.bladeCut.cancel` | — (not industry-standard; menu/toolbar or unkeyed) | — | `bladeConfirmSheet` | — | — | — | — | none · none |
| Delete clip | project | `edit.delete` | `Backspace` | — | `clipInspector` | `delete_clips_tool` | `podcast edit delete-clips` | — | — | none · none |
| Remove track | project | `track.remove` | `Backspace` | — | `trackInspector`, `transport.menu` | `track_remove_tool` | — | — | — | none · none |
| Reorder track | project | `track.reorder` | — (drag headers or move up/down keys) | — | `trackHeader` | `track_reorder_tool` | `podcast episode reorder-track` | — | — | anchor · none |
| Move track up | project | `track.moveUp` | `ArrowUp` | — | `transport.menu` | `track_reorder_tool` | `podcast episode reorder-track` | — | — | none · none |
| Move track down | project | `track.moveDown` | `ArrowDown` | — | `transport.menu` | `track_reorder_tool` | `podcast episode reorder-track` | — | — | none · none |
| Ripple delete clip | project | `edit.rippleDelete` | `Mod+Backspace` | — | `clipInspector` | `ripple_delete_tool`, `delete_clips_tool` | `podcast edit delete-clips --mode ripple` | — | — | none · none |
| Cut anyway | project | `edit.cutSpeech.cutAnyway` | — (not industry-standard; menu/toolbar or unkeyed) | — | `cutSpeechDialog` | `trim_clip_edge_tool`, `delete_clips_tool`, `ripple_delete_tool`, `approve_edits_tool` | `podcast edit trim-clip --yes`, `podcast edit delete-clips --yes`, `podcast edit approve --yes` | — | — | none · none |
| Leave a gap | project | `edit.cutSpeech.leaveGap` | — (not industry-standard; menu/toolbar or unkeyed) | — | `cutSpeechDialog` | `trim_clip_edge_tool`, `delete_clips_tool` | `podcast edit trim-clip --mode gap`, `podcast edit delete-clips --mode gap` | — | — | none · none |
| Cancel cut | view | `edit.cutSpeech.cancel` | — (not industry-standard; menu/toolbar or unkeyed) | — | `cutSpeechDialog` | — | — | — | — | none · none |
| Copy | session | `edit.copy` | `Mod+C` | — | — | `copy_segment_tool` | `podcast edit copy-segment` | — | — | — |
| Cut | project | `edit.cut` | `Mod+X` | — | — | `ripple_delete_tool`, `delete_clips_tool`, `propose_range_cut_tool` | `podcast edit propose-range-cut`, `podcast edit approve`, `podcast edit delete-clips --mode ripple` | — | — | — |
| Paste | project | `edit.paste` | `Mod+V` | — | — | `paste_segment_tool` | `podcast edit paste-segment` | — | — | — |
| Select all tracks | session | `track.selectAll` | `Mod+A` | — | — | — | — | — | — | — |
| Deselect all tracks | session | `track.deselectAll` | `Mod+Shift+A` | — | `trackHeadersWell` | — | — | — | — | none · none |
| Toggle track mute | project | `track.muteToggle` | `M` | — | `trackHeader`, `trackInspector` | `track_set_mute_tool` | `podcast episode set-track-mute` | — | — | anchor · hear |
| Toggle track solo | session | `track.soloToggle` | `S` | — | `trackHeader`, `trackInspector` | — | — | — | — | anchor · hear |
| Clear solo | session | `track.clearSolo` | — (not industry-standard; the Solo on chip clears every solo) | — | `trackHeaders.soloChip`, `mobileShell.statusRow`, `trackMix` | — | — | — | — | none · hear |
| Set track volume | project | `track.setVolume` | — (slider: arrow keys step the focused fader) | — | `trackInspector` | `track_set_volume_tool` | `podcast episode set-track-volume` | — | — | none · none |
| Zoom in | view | `view.zoomIn` | `=` | `pinch` | `transport.menu` | — | — | — | — | none · look |
| Zoom out | view | `view.zoomOut` | `-` | `pinch` | `transport.menu` | — | — | — | — | none · look |
| Fit session width | view | `view.fit` | `\` | — | `transport.fit` | — | — | — | — | none · look |
| Switch editor tab | view | `view.setTab` | — (not industry-standard; tab click) | — | `tabBar` | — | — | — | — | anchor · look |
| Switch phone mode | view | `view.setMobileMode` | — (not industry-standard; tab click) | — | `mobileNav` | — | — | — | — | anchor · look |
| Waveform amplitude zoom in | view | `view.waveformZoomIn` | `ArrowUp` | — | `timeline.waveform`, `transport.viewMenu.waveformAmplitudeIn` | — | — | — | — | time · look |
| Waveform amplitude zoom out | view | `view.waveformZoomOut` | `ArrowDown` | — | `timeline.waveform`, `transport.viewMenu.waveformAmplitudeOut` | — | — | — | — | time · look |
| Fit tracks to window height | view | `view.fitTracksHeight` | — (toggle; View menu checkbox and transport icon) | — | `transport.fitTracksHeight`, `transport.viewMenu.fitTracksHeight` | — | — | — | — | none · none |
| Increase track height | view | `view.trackHeightIncrease` | `Alt+=` | — | `transport.menu` | — | — | — | — | none · none |
| Decrease track height | view | `view.trackHeightDecrease` | `Alt+-` | — | `transport.menu` | — | — | — | — | none · none |
| Undo | project | `history.undo` | `Mod+Z` | `two-finger-tap` | `historyPanel`, `mobileShell.gesture.twoFingerTap` | `history_undo` | `podcast undo` | `podcast-history` | — | none · none |
| Redo | project | `history.redo` | `Mod+Shift+Z` | — | `historyPanel` | `history_redo` | `podcast redo` | `podcast-history` | — | none · none |
| Commands and shortcuts | view | `ui.toggleCommandPalette` | `?` | — | `transport.menu`, `moreHub.searchCommands`, `GesturesSheet` | — | — | — | — | none · none |
| Refresh mix | project | `render.refreshMix` | `Mod+B` | — | `staleRenderPill` | `render_preview` | `podcast render-preview` | `podcast-play-audition` | — | none · none |
| Bounce… | project | `export.bounce` | `Mod+Shift+B` | — | `transport.menu`, `BounceDialog` | `bounce_audio_tool` | `podcast pipeline bounce` | `podcast-bounce-export` | yes | none · none |
| Share… | project | `share.manage` | — (dialog from Menu) | — | `transport.menu`, `ShareDialog` | — | `podcast review share` | — | yes | none · none |
| Create record room | project | `record.createRoom` | — (empty-state action in the Record room panel) | — | `RecordPanel` | `create_record_room_tool` | `podcast review share --kind record` | `podcast-record-session` | yes | none · none |
| Copy guest link | session | `record.copyGuestLink` | — (Start blocker fix in the Record room panel) | — | `RecordPanel` | — | — | — | yes | none · none |
| Start recording | project | `record.start` | — (chords in a later PR) | — | `RecordPanel`, `transport.recChip` | `record_start_tool` | `podcast record start` | `podcast-record-session` | yes | none · none |
| Pause recording | project | `record.pause` | — (chords in a later PR) | — | `RecordPanel`, `transport.recChip` | `record_pause_tool` | `podcast record pause` | `podcast-record-session` | yes | none · none |
| Resume recording | project | `record.resume` | — (chords in a later PR) | — | `RecordPanel`, `transport.recChip` | `record_resume_tool` | `podcast record resume` | `podcast-record-session` | yes | none · none |
| Stop recording | project | `record.stop` | — (chords in a later PR) | — | `RecordPanel`, `transport.recChip` | `record_stop_tool` | `podcast record stop` | `podcast-record-session` | yes | none · none |
| Land recording on timeline | project | `record.land` | — (chords in a later PR) | — | `RecordPanel` | `record_land_tool` | `podcast record land` | `podcast-record-session` | yes | none · none |
| Record panel | view | `record.openPanel` | — (chords in a later PR) | — | `RecordPanel` | `record_state_tool` | `podcast record state` | `podcast-record-session` | yes | none · none |
| Record marker | project | `record.marker` | `M` | — | `LiveComments` | `record_marker_tool` | `podcast record marker` | `podcast-record-session` | yes | none · none |
| Connect agent… | view | `mcp.connect` | — (dialog from Menu) | — | `transport.menu`, `HostMcpDialog` | — | — | — | yes | none · none |
| Export diagnostics… | view | `help.diagnosticsBundle` | — (dialog from Home / Menu) | — | `home.help`, `HelpDialog`, `transport.menu` | — | `podcast doctor --bundle` | — | yes | none · none |
| Export deliverables… | project | `export.deliverables` | `Mod+Shift+E` | — | `transport.menu`, `ExportDialog` | `export_audio_tool` | `podcast pipeline export-audio` | `podcast-master-export` | yes | none · none |
| New project | project | `project.new` | `Mod+N` | — | `transport.menu` | `episode_create` | `podcast episode init` | — | yes | none · none |
| Open project | session | `project.open` | `Mod+O` | — | `transport.menu` | — | — | — | yes | none · none |
| New track | project | `track.add` | `Mod+Shift+T (Shift avoids browser New Tab; Reaper uses Mod+T)` | — | `transport.menu`, `editingToolRail`, `trackLane` | `track_add_empty_tool`, `track_add` | — | — | — | none · none |
| Import audio | project | `media.import` | `Mod+I` | — | `transport.menu`, `editingToolRail`, `drop` | `track_set_media_tool` | — | — | — | none · none |
| Annotate transcript | view | `view.transcriptAnnotate` | — (toolbar toggle; no industry-standard key) | — | `transcript.annotate` | — | — | — | — | none · none |
| Correct transcript | project | `transcript.correctIntent` | — (toolbar toggle; inline correction uses F2) | `double-tap` | `transcript.correct`, `mobileShell.gesture.doubleTapWord`, `transcript.inlineEdit` | `correct_transcript_tool`, `correct_transcript_phrase_tool` | `podcast transcript correct` | — | — | anchor · look |
| Adjust word timing | project | `transcript.adjustTiming` | — (Native range controls and numeric fields in the word inspector) | — | `transcript.wordbar` | `set_word_timing_tool` | `podcast transcript set-word-timing` | — | — | anchor · none |
| Edit focused transcript word | project | `transcript.editWordInline` | `F2` | — | — | `correct_transcript_tool` | `podcast transcript correct` | — | — | anchor · none |
| Select transcript range | view | `transcript.selectIntent` | — (toolbar toggle; no industry-standard key) | — | `transcript.select` | — | — | — | — | anchor · look |
| Ignore / restore transcript words | project | `transcript.ignoreWords` | — (no industry-standard key (#649)) | — | `transcript.ignore`, `transcript.restoreIgnored`, `inspector.word.ignore` | `set_words_ignored_tool` | — | — | — | anchor · look |
| Next low-confidence word | session | `transcript.nextLowConfidence` | — (no industry-standard key (#649); command palette) | — | `transcript.lowConfidenceNext` | — | — | `podcast-transcript-correct` | — | anchor · look |
| Previous low-confidence word | session | `transcript.prevLowConfidence` | — (no industry-standard key (#649); command palette) | — | `transcript.lowConfidencePrev` | — | — | `podcast-transcript-correct` | — | anchor · look |
| Show cut away | view | `view.showCutAway` | — (toolbar toggle; no industry-standard key) | — | `transcript.showCutAway` | — | — | — | — | none · none |
| Trim clip edge | project | `edit.trimClipEdge` | `ArrowLeft` | `long-press-arm-drag`, `hold-nudge` | `timeline.clip.trimHandle` | `trim_clip_edge_tool` | `podcast edit trim-clip` | — | — | time · none |
| Move clips | project | `edit.moveClips` | — (pointer clip-body drag; arrow keys stay playhead nudge) | `long-press-arm-drag` | `timeline.clip.body` | `move_clips_tool` | `podcast edit move-clips` | — | — | time · none |
| Add chapter at playhead | project | `edit.addChapter` | — (no default shortcut; Menu › Markers or the phone More action) | `long-press-empty` | `transport.menu`, `mobileShell.more`, `timeline.createMenu` | `add_chapter_tool` | `podcast edit add-chapter` | — | yes | none · none |
| Add envelope point | project | `envelope.addPoint` | — (touch create menu; the envelope inspector's Add point is the keyboard route) | `long-press-empty` | `timeline.createMenu` | `set_envelope` | — | — | — | time · none |
| Add comment | view | `comment.draftAt` | — (touch create menu; comment mode on the ruler is the pointer route) | `long-press-empty` | `timeline.createMenu` | — | — | — | — | time · none |
| Roll clip join | project | `edit.rollClipJoin` | — (pointer join diamond; no industry-standard key) | `long-press-arm-drag` | `timeline.clip.joinDiamond`, `transcript.editBoundary` | `roll_clip_join_tool` | `podcast edit roll-join` | — | — | time · none |
| Set clip fade | project | `edit.setClipFade` | `ArrowLeft` | `long-press-arm-drag`, `hold-nudge` | `timeline.clip.fadeHandle` | `set_clip_fade_tool` | — | — | — | time · none |
| Set clip join | project | `edit.setClipJoin` | — (inspector select and join badge popover; no industry-standard key) | — | `inspector.clip.joinMode`, `timeline.join.badge` | `set_clip_join_tool` | `podcast edit set-clip-join` | — | — | time · none |
| Find and replace transcript | project | `transcript.findReplace` | — (toolbar and command palette; no shortcut yet) | — | `transcript.findReplace` | `find_replace_transcript_tool` | `podcast transcript find-replace` | — | yes | none · none |
| Play range | session | `range.play` | — (Context action with explicit range selection) | — | `RangeActions` | — | — | — | — | none · none |
| Cut range | project | `range.cut` | — (Context action with explicit range selection) | — | `RangeActions` | `propose_range_cut_tool` | `podcast edit propose-range-cut` | — | — | none · none |
| Mute range | project | `range.mute` | — (Context action with explicit range selection) | — | `RangeActions` | `propose_range_mute_tool` | — | — | — | none · none |
| Comment on range | project | `range.comment` | — (Context action with explicit range selection) | — | `RangeActions` | `add_comment_tool` | `podcast comment add` | — | — | none · none |
| Bounce range | project | `range.bounce` | — (Context action with explicit range selection) | — | `RangeActions` | `bounce_audio_tool` | `podcast pipeline bounce` | — | — | none · none |
| Select a range | view | `range.arm` | — (Context action with explicit range selection) | — | `EditingToolRail`, `transport.menu` | — | — | — | — | none · none |

## Agent workflows

Host/agent capabilities without a Sharecut Studio `command` id (pipeline, transcript, NL, clips, …).

| Label | Effect | MCP | CLI | Skill | Host-only |
| ----- | ------ | --- | --- | ----- | --------- |
| Discard recording take | project | `record_discard_take_tool` | `podcast record discard-take` | `podcast-record-session` | yes |
| Episode / track CRUD | project | `episode_create`, `track_set_meta_tool` | `podcast episode` | `podcast-setup` | yes |
| Transcript layers | project | `transcribe_track`, `get_transcript`, `get_transcript_vocabulary_tool`, `set_transcript_vocabulary_tool`, `export_transcript`, `precorrect_transcript_tool`, +4 | `podcast transcript` | `podcast-transcript-workflow` | yes |
| Edit decisions / NL cuts | project | `build_edit_context`, `search_transcript_tool`, `cut_time_range_tool`, `cut_text_match_tool`, `cut_utterance_tool`, `cut_words_tool`, +14 | `podcast edit` | `podcast-edit-natural-language` | yes |
| Timeline / FX / reconcile | project | `strip_silence_tool`, `ripple_delete_text_tool`, `move_segment_tool`, `move_by_text_tool`, `insert_gap_tool`, `fade_joins_tool`, +42 | `podcast edit` | `podcast-audio-cleanup` | yes |
| Social clips | project | `propose_social_clips_tool`, `list_social_clips_tool`, `approve_social_clips_tool`, `reject_social_clips_tool`, `social_clip_report_tool`, `export_social_clips_tool` | `podcast clips` | `podcast-social-clips` | yes |
| Timeline comments | project | `add_comment_tool`, `list_comments_tool`, `get_comment_tool`, `update_comment_tool`, `resolve_comment_tool`, `add_comment_action_tool`, +3 | `podcast comment` | `podcast-timeline-comments` | — |
| Review versions / share | project | `publish_review_version_tool`, `list_review_versions_tool`, `set_active_review_version_tool`, `create_review_share_tool`, `revoke_record_room_tool` | `podcast review` | `podcast-timeline-comments` | yes |
| Pipeline / master / bounce | project | `pipeline_run`, `pipeline_get_config_tool`, `pipeline_set_config_tool`, `pipeline_analyze_tool`, `set_envelope`, `render_final` | `podcast pipeline` | `podcast-pipeline-run` | yes |
| History | project | `history_list`, `history_status_tool`, `history_goto_tool`, `history_diff_tool`, `history_record` | `podcast history` | `podcast-history` | yes |
| Play / audition | session | `play_transcript_query_tool`, `audition_context_tool`, `play_compose_tool`, `play_ab_tool`, `play_ab_wavs_tool`, `play_pending_preview_tool` | `podcast play` | `podcast-play-audition` | yes |
| DAW session sync | session | `get_session_state_tool`, `set_session_selection_tool`, `set_session_mode_tool`, `set_session_region_tool` | `podcast session` | `podcast-open-gui` | yes |
| Ingest alignment | project | `ingest_import_folder_tool`, `ingest_suggest_alignment_tool`, `ingest_verify_alignment_tool`, `play_compare_tool` | `podcast ingest` | `podcast-align-audio` | yes |
| Align accept gate | project | `align_status_tool`, `align_brief_tool`, `align_done_tool`, `align_waive_tool` | `podcast align` | `podcast-align-audio` | yes |
| Speaker attribution | project | `speaker_doctor_tool`, `speaker_enroll_tool`, `speaker_profiles_tool`, `speaker_score_tool`, `speaker_compare_window_tool`, `speaker_compare_pair_tool`, +5 | `podcast speaker` | `podcast-speaker-attribution` | yes |
| Open Sharecut Studio GUI | session | `open_gui_tool` | `podcast gui` | `podcast-open-gui` | yes |

## Hub skills

Covered without a dedicated capability row (hubs / deprecated aliases):

- `impeccable`
- `podcast-balance-levels`
- `podcast-chapter-markers`
- `podcast-cleanup-transcript`
- `podcast-focus-episode`
- `podcast-inaudible-cuts`
- `podcast-ingest-align`
- `podcast-mix-music`
- `podcast-mute-bleed`
- `podcast-pipeline-tune`
- `podcast-remote-mcp`
- `podcast-tighten-dialogue`
- `podcast-transcript-audition`
- `podcast-transcript-correct`
- `podcast-transcript-precorrect`
- `podcast-transcript-reconcile`
- `podcast-transcript-refine`
- `podcast-vocal-compression`
- `sharecut-poteto`

<!-- /capabilities:generated -->
