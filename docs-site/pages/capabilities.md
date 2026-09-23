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

**94** capabilities · **78** Sharecut Studio commands · **49** keyed · **160** MCP tools · **16** skills on rows (+ **17** hub skills).

Keyboard chords: [UX shortcuts](https://ux.sharecut.studio/#/shortcuts). Document plane: [Document commands](#/document-commands). Guest MCP allowlist: [Remote MCP](#/remote-mcp).

## Sharecut Studio capabilities

| Label | Command | Keyboard | GUI | MCP | CLI | Skill | Host-only | Presence |
| ----- | ------- | -------- | --- | --- | --- | ----- | --------- | -------- |
| Play / pause | `transport.togglePlay` | `Space` | `transport.play` | `set_session_playing_tool`, `play_audio_tool` | — | `podcast-play-audition` | — | anchor · look |
| Seek playhead | `transport.seek` | — (not industry-standard; menu/toolbar or unkeyed) | — | `seek_session_tool` | — | — | — | — |
| Stop playback | `transport.stop` | `K` | `transport.stop` | `stop_session_tool` | — | — | — | anchor · look |
| Audition Mix / FX / Raw | `transport.audition` | — (not industry-standard; Mix/FX/Raw toggle) | `transport.audition` | — | — | `podcast-play-audition` | — | anchor · hear |
| Follow | `presence.follow` | — (not industry-standard; avatar click) | `presence.avatarStack` | `get_session_presence_tool` | — | — | — | none · none |
| Stop following | `presence.unfollow` | `Escape` | `presence.followBanner` | — | — | — | — | none · none |
| Select tool | `tool.select` | `V` | `toolModeToggle` | — | — | — | — | none · none |
| Blade tool | `tool.blade` | `C` | `toolModeToggle` | — | — | — | — | none · none |
| Exit comment mode | `review.exitCommentMode` | `Escape` | — | — | — | — | — | — |
| Clear selection | `edit.clearSelection` | `Escape` | — | — | — | — | — | — |
| Toggle comment mode | `review.toggleCommentMode` | `Mod+Shift+C` | `transport.comment` | — | — | — | — | none · none |
| Apply tighten hit | `tighten.applyHit` | `Enter` | `tightenPanel` | — | — | `podcast-tighten-dialogue` | — | none · none |
| Skip tighten hit | `tighten.skipHit` | `Backspace` | `tightenPanel` | — | — | `podcast-tighten-dialogue` | — | none · none |
| Apply eligible tighten hits | `tighten.applyAllSafe` | `Mod+Shift+Enter` | `tightenPanel` | — | — | `podcast-tighten-dialogue` | — | none · none |
| Preview tighten hit | `tighten.previewHit` | `P` | `tightenPanel` | — | — | `podcast-tighten-dialogue` | — | none · none |
| Go to tighten hit | `tighten.goToHit` | — (pointer/row action; seek+select) | `tightenPanel` | — | — | `podcast-tighten-dialogue` | — | time · look |
| Focus: default layout | `focus.default` | `1` | `focusToggle` | — | — | — | — | none · none |
| Focus: timeline | `focus.timeline` | `2` | `focusToggle` | — | — | — | — | none · none |
| Focus: text | `focus.text` | `3` | `focusToggle` | — | — | — | — | none · none |
| Focus: review | `focus.review` | `4` | `focusToggle` | — | — | — | — | none · none |
| Cycle focus mode | `focus.cycle` | — (not industry-standard; menu/toolbar or unkeyed) | `transport.menu` | — | — | — | — | none · none |
| Nudge playhead back | `navigation.nudgePlayheadBack` | `ArrowLeft` | — | — | — | — | — | — |
| Nudge playhead forward | `navigation.nudgePlayheadForward` | `ArrowRight` | — | — | — | — | — | — |
| Go to start | `navigation.goToStart` | `Home` | — | — | — | — | — | — |
| Go to end | `navigation.goToEnd` | `End` | — | — | — | — | — | — |
| Blade cut | `edit.bladeCut` | `Mod+K` | `editingToolRail`, `timeline` | `split_clip_tool` | — | — | — | time · none |
| Confirm blade cut | `edit.bladeCut.confirm` | — (not industry-standard; menu/toolbar or unkeyed) | `bladeConfirmSheet` | — | — | — | — | none · none |
| Cancel blade cut | `edit.bladeCut.cancel` | — (not industry-standard; menu/toolbar or unkeyed) | `bladeConfirmSheet` | — | — | — | — | none · none |
| Delete clip | `edit.delete` | `Backspace` | `clipInspector` | — | — | — | — | none · none |
| Remove track | `track.remove` | `Backspace` | `trackInspector`, `transport.menu` | `track_remove_tool` | — | — | — | none · none |
| Reorder track | `track.reorder` | — (drag headers or move up/down keys) | `trackHeader` | `track_reorder_tool` | — | — | — | anchor · none |
| Move track up | `track.moveUp` | `ArrowUp` | `transport.menu` | — | — | — | — | none · none |
| Move track down | `track.moveDown` | `ArrowDown` | `transport.menu` | — | — | — | — | none · none |
| Ripple delete clip | `edit.rippleDelete` | `Mod+Backspace` | `clipInspector` | `ripple_delete_tool` | — | — | — | none · none |
| Copy | `edit.copy` | `Mod+C` | — | — | — | — | — | — |
| Cut | `edit.cut` | `Mod+X` | — | — | — | — | — | — |
| Paste | `edit.paste` | `Mod+V` | — | — | — | — | — | — |
| Select all tracks | `track.selectAll` | `Mod+A` | — | — | — | — | — | — |
| Deselect all tracks | `track.deselectAll` | `Mod+Shift+A` | `trackHeadersWell` | — | — | — | — | none · none |
| Toggle track mute | `track.muteToggle` | `M` | `trackHeader` | — | — | — | — | anchor · hear |
| Toggle track solo | `track.soloToggle` | `S` | `trackHeader` | — | — | — | — | anchor · hear |
| Zoom in | `view.zoomIn` | `=` | `transport.menu` | — | — | — | — | none · look |
| Zoom out | `view.zoomOut` | `-` | `transport.menu` | — | — | — | — | none · look |
| Fit session in view | `view.fit` | `\` | `transport.fit` | — | — | — | — | none · look |
| Switch editor tab | `view.setTab` | — (not industry-standard; tab click) | `tabBar` | — | — | — | — | anchor · look |
| Switch phone mode | `view.setMobileMode` | — (not industry-standard; tab click) | `mobileNav` | — | — | — | — | anchor · look |
| Waveform amplitude zoom in | `view.waveformZoomIn` | `ArrowUp` | `timeline.waveform` | — | — | — | — | time · look |
| Waveform amplitude zoom out | `view.waveformZoomOut` | `ArrowDown` | `timeline.waveform` | — | — | — | — | time · look |
| Undo | `history.undo` | `Mod+Z` | `historyPanel`, `mobileShell.gesture.twoFingerTap` | `history_undo` | `podcast undo` | `podcast-history` | — | none · none |
| Redo | `history.redo` | `Mod+Shift+Z` | `historyPanel` | `history_redo` | `podcast redo` | `podcast-history` | — | none · none |
| Command cheatsheet | `ui.toggleCommandPalette` | `?` | `transport.menu` | — | — | — | — | none · none |
| Refresh mix | `render.refreshMix` | `Mod+B` | `staleRenderPill` | `render_preview` | `podcast render-preview` | `podcast-play-audition` | — | none · none |
| Bounce… | `export.bounce` | `Mod+Shift+B` | `transport.menu`, `BounceDialog` | `bounce_audio_tool` | `podcast pipeline bounce` | `podcast-bounce-export` | yes | none · none |
| Share… | `share.manage` | — (dialog from Menu) | `transport.menu`, `ShareDialog` | — | `podcast review share` | — | yes | none · none |
| Start recording | `record.start` | — (chords in a later PR) | `RecordPanel`, `transport.recChip` | `record_start_tool` | `podcast record start` | `podcast-record-session` | yes | none · none |
| Pause recording | `record.pause` | — (chords in a later PR) | `RecordPanel`, `transport.recChip` | `record_pause_tool` | `podcast record pause` | `podcast-record-session` | yes | none · none |
| Resume recording | `record.resume` | — (chords in a later PR) | `RecordPanel`, `transport.recChip` | `record_resume_tool` | `podcast record resume` | `podcast-record-session` | yes | none · none |
| Stop recording | `record.stop` | — (chords in a later PR) | `RecordPanel`, `transport.recChip` | `record_stop_tool` | `podcast record stop` | `podcast-record-session` | yes | none · none |
| Land recording on timeline | `record.land` | — (chords in a later PR) | `RecordPanel` | `record_land_tool` | `podcast record land` | `podcast-record-session` | yes | none · none |
| Record panel | `record.openPanel` | — (chords in a later PR) | `RecordPanel` | `record_state_tool` | `podcast record state` | `podcast-record-session` | yes | none · none |
| Record marker | `record.marker` | `M` | `LiveComments` | — | — | `podcast-record-session` | yes | none · none |
| Connect agent… | `mcp.connect` | — (dialog from Menu) | `transport.menu`, `HostMcpDialog` | — | — | — | yes | none · none |
| Help… | `help.diagnosticsBundle` | — (dialog from Home / Menu) | `home.help`, `HelpDialog`, `transport.menu` | — | `podcast doctor --bundle` | — | yes | none · none |
| Export deliverables | `export.deliverables` | `Mod+Shift+E` | `transport.menu` | `export_audio_tool` | `podcast pipeline export-audio` | `podcast-master-export` | yes | none · none |
| New project | `project.new` | `Mod+N` | `transport.menu` | — | — | — | yes | none · none |
| Open project | `project.open` | `Mod+O` | `transport.menu` | — | — | — | yes | none · none |
| New track | `track.add` | `Mod+Shift+T (Shift avoids browser New Tab; Reaper uses Mod+T)` | `transport.menu`, `editingToolRail`, `trackLane` | `track_add_empty_tool`, `track_add` | — | — | — | none · none |
| Import audio | `media.import` | `Mod+I` | `transport.menu`, `editingToolRail`, `drop` | `track_set_media_tool` | — | — | — | none · none |
| Annotate transcript | `view.transcriptAnnotate` | — (toolbar toggle; no industry-standard key) | `transcript.annotate` | — | — | — | — | none · none |
| Correct transcript | `transcript.correctIntent` | — (toolbar toggle; no industry-standard key) | `transcript.correct`, `mobileShell.gesture.doubleTapWord` | — | — | — | — | anchor · look |
| Select transcript range | `transcript.selectIntent` | — (toolbar toggle; no industry-standard key) | `transcript.select` | — | — | — | — | anchor · look |
| Show cut away | `view.showCutAway` | — (toolbar toggle; no industry-standard key) | `transcript.showCutAway` | — | — | — | — | none · none |
| Trim clip edge | `edit.trimClipEdge` | — (pointer trim handle; no industry-standard key) | `timeline.clip.trimHandle` | — | — | — | — | time · none |
| Move clips | `edit.moveClips` | — (pointer clip-body drag; arrow keys stay playhead nudge) | `timeline.clip.body` | `move_clips_tool` | `podcast edit move-clips` | — | — | time · none |
| Roll clip join | `edit.rollClipJoin` | — (pointer join diamond; no industry-standard key) | `timeline.clip.joinDiamond`, `transcript.editBoundary` | — | — | — | — | time · none |
| Set clip fade | `edit.setClipFade` | — (pointer fade handle; no industry-standard key) | `timeline.clip.fadeHandle` | — | — | — | — | time · none |
| Edit boundary | `view.focusEditBoundary` | — (inline glyph; no industry-standard key) | — | — | — | — | — | — |
| Cut-away word | `view.focusCutAwayWord` | — (inline chip; no industry-standard key) | `transcript.cutAwayWord` | — | — | — | — | anchor · look |

## Agent workflows

Host/agent capabilities without a Sharecut Studio `command` id (pipeline, transcript, NL, clips, …).

| Label | MCP | CLI | Skill | Host-only |
| ----- | --- | --- | ----- | --------- |
| Discard recording take | `record_discard_take_tool` | `podcast record discard-take` | `podcast-record-session` | yes |
| Episode / track CRUD | `episode_create`, `track_set_meta_tool` | `podcast episode / podcast track` | `podcast-setup` | yes |
| Transcript layers | `transcribe_track`, `get_transcript`, `export_transcript`, `precorrect_transcript_tool`, `transcript_refine_status_tool`, `transcript_refine_brief_tool`, +2 | `podcast transcript` | `podcast-transcript-workflow` | yes |
| Edit decisions / NL cuts | `build_edit_context`, `search_transcript_tool`, `cut_time_range_tool`, `cut_text_match_tool`, `cut_utterance_tool`, `cut_words_tool`, +14 | `podcast edit` | `podcast-edit-natural-language` | yes |
| Timeline / FX / reconcile | `strip_silence_tool`, `ripple_delete_text_tool`, `move_segment_tool`, `move_by_text_tool`, `insert_gap_tool`, `fade_joins_tool`, +38 | `podcast edit` | `podcast-audio-cleanup` | yes |
| Social clips | `propose_social_clips_tool`, `list_social_clips_tool`, `approve_social_clips_tool`, `reject_social_clips_tool`, `social_clip_report_tool`, `export_social_clips_tool` | `podcast clips` | `podcast-social-clips` | yes |
| Timeline comments | `add_comment_tool`, `list_comments_tool`, `get_comment_tool`, `update_comment_tool`, `resolve_comment_tool`, `add_comment_action_tool`, +3 | `podcast comment` | `podcast-timeline-comments` | — |
| Review versions / share | `publish_review_version_tool`, `list_review_versions_tool`, `set_active_review_version_tool`, `create_review_share_tool`, `create_record_room_tool`, `revoke_record_room_tool` | `podcast review` | `podcast-timeline-comments` | yes |
| Pipeline / master / bounce | `pipeline_run`, `pipeline_get_config_tool`, `pipeline_set_config_tool`, `pipeline_analyze_tool`, `set_envelope`, `render_final` | `podcast pipeline` | `podcast-pipeline-run` | yes |
| History | `history_list`, `history_status_tool`, `history_goto_tool`, `history_diff_tool`, `history_record` | `podcast history` | `podcast-history` | yes |
| Play / audition | `play_transcript_query_tool`, `audition_context_tool`, `play_compose_tool`, `play_ab_tool`, `play_ab_wavs_tool`, `play_pending_preview_tool` | `podcast play` | `podcast-play-audition` | yes |
| DAW session sync | `get_session_state_tool`, `set_session_selection_tool`, `set_session_mode_tool`, `set_session_region_tool` | `podcast session` | `podcast-open-gui` | yes |
| Ingest alignment | `ingest_import_folder_tool`, `ingest_suggest_alignment_tool`, `ingest_verify_alignment_tool`, `play_compare_tool` | `podcast ingest` | `podcast-align-audio` | yes |
| Align accept gate | `align_status_tool`, `align_brief_tool`, `align_done_tool`, `align_waive_tool` | `podcast align` | `podcast-align-audio` | yes |
| Speaker attribution | `speaker_doctor_tool`, `speaker_enroll_tool`, `speaker_profiles_tool`, `speaker_score_tool`, `speaker_compare_window_tool`, `speaker_compare_pair_tool`, +4 | `podcast speaker` | `podcast-speaker-attribution` | yes |
| Open Sharecut Studio GUI | `open_gui_tool` | `podcast gui` | `podcast-open-gui` | yes |

## Hub skills

Covered without a dedicated capability row (hubs / deprecated aliases):

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

<!-- /capabilities:generated -->
