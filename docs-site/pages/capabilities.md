# Capabilities

Host product capabilities and which adapters exist (ShareCut Studio command / GUI /
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

**156** capabilities · **121** ShareCut Studio commands · **65** keyed · **218** MCP tools · **17** skills on rows (+ **19** hub skills).

Keyboard chords: [UX shortcuts](https://ux.sharecut.studio/#/shortcuts). Document plane: [Document commands](#/document-commands). Guest MCP allowlist: [Remote MCP](#/remote-mcp).

## ShareCut Studio capabilities

Effect `project` changes the saved project, review state, transcripts or artifacts, and needs an MCP or CLI surface (or an owner-approved reason, shown in the CLI column). `session` changes live unsaved state; `view` changes only this client's display.

| Label | Effect | Command | Keyboard | Touch | GUI | MCP | CLI | Skill | Host-only | Presence |
| ----- | ------ | ------- | -------- | ----- | --- | --- | --- | ----- | --------- | -------- |
| Play / pause | session | `transport.togglePlay` | `Space` | — | `transport.play` | `set_session_playing_tool`, `play_audio_tool` | — | `podcast-play-audition` | — | anchor · look |
| Seek playhead | session | `transport.seek` | — (not industry-standard; menu/toolbar or unkeyed) | — | — | `seek_session_tool` | — | — | — | — |
| Pause and return | session | `transport.stop` | `K` | — | — | `stop_session_tool` | — | — | — | anchor · look |
| Jump back | session | `transport.shuttleBack` | `J` | — | — | `seek_session_tool` | `podcast session seek` | — | — | anchor · look |
| Speed up (1×/2×/4×) | session | `transport.shuttleForward` | `L` | — | — | `set_session_playing_tool` | — | — | — | anchor · look |
| Audition Full mix / Edited stems / Original | session | `transport.audition` | — (not industry-standard; Full mix/Edited stems/Original toggle) | — | `transport.audition` | — | — | `podcast-play-audition` | — | anchor · hear |
| Hear the original while held | session | `transport.hearOriginal` | `A` | — | — | — | — | — | — | none · none |
| Follow | session | `presence.follow` | — (not industry-standard; avatar click) | — | `presence.avatarStack` | `get_session_presence_tool` | — | — | — | none · none |
| Go to where they are | session | `presence.goTo` | — (not industry-standard; avatar menu) | — | `presence.goTo` | — | — (viewer navigation: an agent has no viewport to move) | — | — | none · none |
| Stop following | session | `presence.unfollow` | `Escape` | — | `presence.followPill` | — | — | — | — | none · none |
| Clear selection | session | `edit.clearSelection` | `Escape` | — | — | — | — | — | — | — |
| Next occurrence | session | `edit.nextOccurrence` | `Tab` | — | — | — | — | — | — | — |
| Create here | view | `create.menu` | `Shift+F10` | — | — | — | — | — | — | — |
| Resolve comment | project | `comment.resolve` | — (Direct comment card button; no standard shortcut) | — | — | `resolve_comment_tool` | `podcast comment resolve` | — | yes | none · none |
| Nudge playhead back | session | `navigation.nudgePlayheadBack` | `ArrowLeft` | — | — | — | — | — | — | — |
| Nudge playhead forward | session | `navigation.nudgePlayheadForward` | `ArrowRight` | — | — | — | — | — | — | — |
| Go to start | session | `navigation.goToStart` | `Home` | — | — | — | — | — | — | — |
| Go to end | session | `navigation.goToEnd` | `End` | — | — | — | — | — | — | — |
| Split at playhead | project | `edit.bladeCut` | `Mod+K` | `long-press-empty` | `timeline`, `timeline.createMenu` | `split_clip_tool` | `podcast doc submit` | — | — | time · none |
| Cut selection | project | `edit.delete` | `Backspace` | — | `clipInspector`, `actionBar` | `delete_clips_tool` | `podcast edit delete-clips` | — | — | none · none |
| Remove track | project | `track.remove` | `Backspace` | — | `trackInspector` | `track_remove_tool` | `podcast doc submit` | — | — | none · none |
| Split speakers… | project | `track.splitSpeakers` | — (opens Prepare at the track's split prompt, which asks for the speaker count; reached from the track inspector and the command palette) | — | `SourceCard`, `trackInspector` | `speaker_split_tool` | `podcast speaker split` | `podcast-speaker-attribution` | — | none · none |
| Extract room tone | project | `track.extractRoomTone` | — (Host action in the track inspector; also the command palette, MCP and CLI) | — | `trackInspector` | `extract_room_tone_bed_tool` | `podcast track room-tone extract` | `podcast-audio-cleanup` | — | none · none |
| Remove extracted room tone | project | `track.clearRoomTone` | — (Host action in the track inspector; also the command palette, MCP and CLI) | — | `trackInspector` | `clear_extracted_room_tone_bed_tool` | `podcast track room-tone clear` | `podcast-audio-cleanup` | — | none · none |
| Reorder track | project | `track.reorder` | — (drag headers or move up/down keys) | — | `trackHeader`, `SourceCard` | `track_reorder_tool` | `podcast episode reorder-track` | — | — | anchor · none |
| Move track up | project | `track.moveUp` | `ArrowUp` | — | `trackInspector` | `track_reorder_tool` | `podcast episode reorder-track` | — | — | none · none |
| Move track down | project | `track.moveDown` | `ArrowDown` | — | `trackInspector` | `track_reorder_tool` | `podcast episode reorder-track` | — | — | none · none |
| Ripple delete clip | project | `edit.rippleDelete` | `Mod+Backspace` | — | `clipInspector` | `ripple_delete_tool`, `delete_clips_tool` | `podcast edit delete-clips --mode ripple` | — | — | none · none |
| Copy | session | `edit.copy` | `Mod+C` | — | — | `copy_segment_tool` | `podcast edit copy-segment` | — | — | — |
| Cut | project | `edit.cut` | `Mod+X` | — | — | `ripple_delete_tool`, `delete_clips_tool`, `propose_range_cut_tool` | `podcast edit propose-range-cut`, `podcast edit approve`, `podcast edit delete-clips --mode ripple` | — | — | — |
| Paste | project | `edit.paste` | `Mod+V` | `long-press-empty` | `timeline.createMenu` | `paste_segment_tool` | `podcast edit paste-segment` | — | — | none · none |
| Select all tracks | session | `track.selectAll` | `Mod+A` | — | — | — | — | — | — | — |
| Deselect all tracks | session | `track.deselectAll` | `Mod+Shift+A` | — | `trackHeadersWell` | — | — | — | — | none · none |
| Toggle track mute | project | `track.muteToggle` | — (M is edit.mute, which mutes the targeted track when nothing else is selected) | — | `trackHeader`, `trackInspector` | `track_set_mute_tool` | `podcast episode set-track-mute` | — | — | anchor · hear |
| Toggle track solo | session | `track.soloToggle` | `Shift+S` | — | `trackHeader`, `trackInspector` | — | — | — | — | anchor · hear |
| Clear solo | session | `track.clearSolo` | — (not industry-standard; the Solo on chip clears every solo) | — | `trackHeaders.soloChip`, `trackMix` | — | — | — | — | none · hear |
| Set track volume | project | `track.setVolume` | — (slider: arrow keys step the focused fader) | — | `trackInspector` | `track_set_volume_tool` | `podcast episode set-track-volume` | — | — | none · none |
| Zoom in | view | `view.zoomIn` | `=` | `pinch` | `editCorner` | — | — | — | — | none · look |
| Zoom out | view | `view.zoomOut` | `-` | `pinch` | `editCorner` | — | — | — | — | none · look |
| Zoom to selection | view | `view.zoomToSelection` | `Z` | — | — | — | — | — | — | none · look |
| Fit session width | view | `view.fit` | `\` | — | `editCorner` | — | — | — | — | none · look |
| Go to Record | view | `stage.record` | `Mod+1` | — | `stageBar`, `editPlusMenu` | — | — | — | — | none · look |
| Go to Prepare | view | `stage.prepare` | `Mod+2` | — | `stageBar` | — | — | — | — | none · look |
| Go to Edit | view | `stage.edit` | `Mod+3` | — | `stageBar` | — | — | — | — | none · look |
| Go to Review | view | `stage.review` | `Mod+4` | — | `stageBar` | — | — | — | — | none · look |
| Go to Deliver | view | `stage.deliver` | `Mod+5` | — | `stageBar` | — | — | — | — | none · look |
| Take the hand-off | view | `stage.handoff` | `Mod+Enter` | — | `stageHandoff` | — | — | — | — | none · look |
| Open history | view | `edit.history` | — (Reached from the palette and by right-click or long-press on Undo or Redo) | — | `historyPanel` | — | — | — | — | none · none |
| Show or hide Script | view | `view.toggleScript` | `T` | — | `editCorner` | — | — | — | — | none · none |
| Script focus | view | `view.scriptFocus` | `Shift+T` | — | — | — | — | — | — | none · none |
| Waveform amplitude zoom in | view | `view.waveformZoomIn` | `Shift+ArrowUp` | — | `viewPopover` | — | — | — | — | time · look |
| Waveform amplitude zoom out | view | `view.waveformZoomOut` | `Shift+ArrowDown` | — | `viewPopover` | — | — | — | — | time · look |
| Fit tracks to window height | view | `view.fitTracksHeight` | — (toggle; the palette and agents (Alt+= and Alt+- step the height)) | — | — | — | — | — | — | none · none |
| Snap to cut points | view | `view.toggleSnap` | — (Toggle in the corner for touch; Alt inverts it for one drag on a keyboard) | — | `editCorner` | — | — | — | — | none · none |
| Increase track height | view | `view.trackHeightIncrease` | `Alt+=` | — | — | — | — | — | — | none · none |
| Decrease track height | view | `view.trackHeightDecrease` | `Alt+-` | — | — | — | — | — | — | none · none |
| Undo | project | `history.undo` | `Mod+Z` | `two-finger-tap` | `historyPanel`, `transcript.findReplace`, `transcript.wordbar` | `history_undo` | `podcast undo` | `podcast-history` | — | none · none |
| Redo | project | `history.redo` | `Mod+Shift+Z` | — | `historyPanel` | `history_redo` | `podcast redo` | `podcast-history` | — | none · none |
| Commands and shortcuts | view | `ui.toggleCommandPalette` | `?` | — | `home.help` | — | — | — | — | none · none |
| Refresh mix | project | `render.refreshMix` | — (Mod+B belongs to the browser (bookmarks, bold); Refresh mix is in the palette and the mix ring) | — | `deliverShare` | `render_preview` | `podcast render-preview` | `podcast-play-audition` | — | none · none |
| Export full mix | project | `export.bounce` | — (Palette only: exports the whole episode's audible tracks in place (export/bounces/); the action bar's Export button does the same for the whole episode with nothing selected, and for the selected tracks or a range) | — | `actionBar` | `bounce_audio_tool` | `podcast pipeline bounce` | `podcast-bounce-export` | yes | none · none |
| Share… | project | `share.manage` | — (Invite, or Menu) | — | `inviteSheet` | — | `podcast review share` | — | yes | none · none |
| Create record room | project | `record.createRoom` | — (empty-state action on the Record stage) | — | `RecordStage` | `create_record_room_tool` | `podcast review share --kind record` | `podcast-record-session` | yes | none · none |
| Copy guest link | session | `record.copyGuestLink` | — (Palette command; the Invite sheet also has a Copy guest link button) | — | — | — | — | — | yes | none · none |
| Start recording | project | `record.start` | — (chords in a later PR) | — | `RecordStage` | `record_start_tool` | `podcast record start` | `podcast-record-session` | yes | none · none |
| Capture room tone | project | `record.roomTone` | — (chords in a later PR) | — | `RecordStage` | `record_room_tone_tool` | `podcast record room-tone` | `podcast-record-session` | yes | none · none |
| Set session target | project | `record.setTarget` | — (Reached from the command palette and the session target chip in the Record room) | — | — | `record_target_tool` | `podcast record target` | `podcast-record-session` | yes | none · none |
| Pause recording | project | `record.pause` | — (chords in a later PR) | — | `RecordStage` | `record_pause_tool` | `podcast record pause` | `podcast-record-session` | yes | none · none |
| Resume recording | project | `record.resume` | — (chords in a later PR) | — | `RecordStage` | `record_resume_tool` | `podcast record resume` | `podcast-record-session` | yes | none · none |
| Stop recording | project | `record.stop` | — (chords in a later PR) | — | `RecordStage` | `record_stop_tool` | `podcast record stop` | `podcast-record-session` | yes | none · none |
| Land recording on timeline | project | `record.land` | — (chords in a later PR) | — | `RecordStage` | `record_land_tool` | `podcast record land` | `podcast-record-session` | yes | none · none |
| Record marker | project | `record.marker` | `C` | — | `RecordStage` | `record_marker_tool` | `podcast record marker` | `podcast-record-session` | yes | none · none |
| Mute your mic in the room | view | `room.mute` | `M` | — | `RecordStage` | — | — | — | yes | none · none |
| Record | view | `room.take` | `R` | — | `RecordStage` | — | — | — | yes | none · none |
| Stop take | view | `room.stop` | `R` | — | `RecordStage` | — | — | — | yes | none · none |
| Pause or resume take | view | `room.pause` | `P` | — | `RecordStage` | — | — | — | yes | none · none |
| Connect agent… | view | `mcp.connect` | — (dialog from Menu) | — | `HostMcpDialog` | — | — | — | yes | none · none |
| Report a problem… | view | `help.diagnosticsBundle` | — (dialog from Home / Menu) | — | `HelpDialog` | — | `podcast doctor --bundle` | — | yes | none · none |
| Guides | view | `help.guides` | — (palette Help group) | — | — | — | — | — | — | none · none |
| Manage models… | view | `models.open` | — (sheet from Home / palette) | — | `home.models`, `ModelsSheet`, `SettingsSheet` | `model_download`, `model_download_status` | `podcast setup` | — | yes | none · none |
| Settings… | view | `settings.open` | — (sheet from the app menu; native Cmd+, (macOS) / Ctrl+, (Linux) in the desktop app menu) | — | `SettingsSheet` | — | — | — | yes | none · none |
| Export deliverables… | project | `export.deliverables` | `Mod+E` | — | `deliverStage` | `export_audio_tool`, `bounce_audio_tool` | `podcast pipeline export-audio` | `podcast-master-export` | yes | none · none |
| Export transcript… | project | `export.transcript` | — (Deliver page action, reached from the command palette) | — | `deliverTranscript` | `export_transcript`, `list_exported_transcripts` | `podcast transcript export` | `podcast-transcript-workflow` | yes | none · none |
| New project… | project | `project.new` | — (Mod+N opens a browser window; New project is in the palette and on Home) | — | — | `episode_create` | `podcast episode init` | — | yes | none · none |
| Open project… | session | `project.open` | — (Mod+O is All projects (project.home); open from the palette or Home) | — | — | — | — | — | yes | none · none |
| All projects | session | `project.home` | `Mod+O` | — | `projectMenu` | — | — | — | yes | none · none |
| New track | project | `track.add` | — (Mod+Shift+T reopens a closed browser tab; New track is in the palette and the + menu) | — | `trackLane`, `editPlusMenu` | `track_add_empty_tool`, `track_add` | `podcast doc submit` | — | — | none · none |
| Import audio… | project | `media.import` | `Mod+I` | — | `drop`, `editPlusMenu`, `SourceCard` | `track_set_media_tool` | — | — | — | none · none |
| Adjust word timing | project | `transcript.adjustTiming` | — (Start and End Scrub fields and waveform handles in the word inspector) | — | `transcript.wordbar` | `set_word_timing_tool` | `podcast transcript set-word-timing` | — | — | anchor · none |
| Edit focused transcript word | project | `transcript.editWordInline` | `F2` | `double-tap` | — | `correct_transcript_tool` | `podcast transcript correct` | — | — | anchor · none |
| Extend transcript range | view | `transcript.extendRange` | — (Shift+Arrow and the selection handles extend the range; no industry-standard key) | `long-press-arm-drag` | — | — | — | — | — | anchor · look |
| Ignore / restore transcript words | project | `transcript.ignoreWords` | — (no industry-standard key (#649)) | — | `transcript.ignore` | `set_words_ignored_tool` | `podcast doc submit` | — | — | anchor · look |
| Show cut away | view | `view.showCutAway` | — (toolbar toggle; no industry-standard key) | — | `transcript.showCutAway` | — | — | — | — | none · none |
| Trim clip edge | project | `edit.trimClipEdge` | `ArrowLeft` | `long-press-arm-drag`, `hold-nudge` | `timeline.clip.trimHandle` | `trim_clip_edge_tool` | `podcast edit trim-clip` | — | — | time · none |
| Move clips | project | `edit.moveClips` | — (Clip inspector Start and Track fields or pointer clip-body drag; arrow keys stay playhead nudge) | `long-press-arm-drag` | `timeline.clip.body`, `clipInspector` | `move_clips_tool` | `podcast edit move-clips` | — | — | time · none |
| Add chapter at playhead | project | `edit.addChapter` | `Shift+C` | `long-press-empty` | `timeline.createMenu`, `editPlusMenu`, `actionBar` | `add_chapter_tool` | `podcast edit add-chapter` | — | yes | none · none |
| Add envelope point | project | `envelope.addPoint` | — (create menu; Shift+F10 or the Menu key on a lane opens it from the keyboard) | `long-press-empty` | `timeline.createMenu` | `set_envelope` | `podcast edit list-envelope`, `podcast doc submit` | — | — | time · none |
| Record here | view | `record.here` | — (not industry-standard; the Create menu and the Action bar verb) | `long-press-empty` | `timeline.createMenu` | — | — | — | — | time · look |
| Add comment | view | `comment.draftAt` | `C` | `long-press-empty` | `timeline.createMenu`, `actionBar` | — | — | — | — | time · none |
| Restore original audio | project | `edit.restoreClipBleed` | — (Select a region in the Auto reduction inspector, then Keep on the Action bar) | — | `restoreClipBleed` | `restore_clip_bleed_tool` | `podcast edit restore-clip-bleed` | — | yes | none · none |
| Roll clip join | project | `edit.rollClipJoin` | — (pointer Seam diamond or Seam pill; Alt+Arrow on the focused Seam, no industry-standard key) | `long-press-arm-drag` | `timeline.clip.joinDiamond`, `transcript.seam` | `roll_clip_join_tool` | `podcast edit roll-join` | — | — | time · none |
| Set clip fade | project | `edit.setClipFade` | `ArrowLeft` | `long-press-arm-drag`, `hold-nudge` | `timeline.clip.fadeHandle`, `inspector.clip.fadeCurve` | `set_clip_fade_tool` | `podcast edit set-clip-fade` | — | — | time · none |
| Set clip gain | project | `edit.setClipGain` | — (level in dB, set from the clip Inspector or the agent) | — | `inspector.clip.gain` | `set_clip_gain_tool`, `set_clips_gain_tool` | `podcast doc submit` | — | — | none · none |
| Set clip join | project | `edit.setClipJoin` | — (clip inspector join type and the Seam action bar; no industry-standard key) | — | `inspector.clip.joinType` | `set_clip_join_tool` | `podcast edit set-clip-join` | — | — | time · none |
| Find and replace transcript | project | `transcript.findReplace` | — (toolbar and command palette; no shortcut yet) | — | `transcript.findReplace` | `find_replace_transcript_tool` | `podcast transcript find-replace` | — | yes | none · none |
| Play range | session | `range.play` | — (Context action with explicit range selection) | — | `actionBar` | — | — | — | — | none · none |
| Cut selected range | project | `range.cut` | — (Context action with explicit range selection) | — | `actionBar` | `propose_range_cut_tool` | `podcast edit propose-range-cut` | — | — | none · none |
| Mute selected range | project | `range.mute` | — (Context action with explicit range selection) | — | `actionBar` | `propose_range_mute_tool` | — | — | — | none · none |
| Fill range with room tone | project | `range.fillRoomTone` | — (Context action with explicit range selection) | — | `actionBar` | `fill_with_room_tone_tool` | `podcast doc submit` | — | — | none · none |
| Move to speaker | project | `range.moveSpeakerLane` | — (Context action with explicit range selection on one split lane) | — | `actionBar` | `speaker_move_lane_span_tool` | `podcast speaker move-lane-span` | `podcast-speaker-attribution` | — | none · none |
| Comment on range | project | `range.comment` | — (Context action with explicit range selection) | — | `actionBar` | `add_comment_tool` | `podcast comment add` | — | — | none · none |
| Export selected range | project | `range.bounce` | — (Context action with explicit range selection) | — | `actionBar` | `bounce_audio_tool` | `podcast pipeline bounce` | — | — | none · none |
| Select a range | view | `range.arm` | — (Context action with explicit range selection) | — | `editCorner` | — | — | — | — | none · none |
| Split | project | `edit.split` | `S` | — | `actionBar` | `split_clip_tool` | `podcast doc submit` | — | — | time · none |
| Hear | session | `edit.hear` | `Shift+Space` | — | `actionBar` | — | — | — | — | none · none |
| Hear before | session | `edit.hearBefore` | `A` | — | `actionBar` | — | — | — | — | none · none |
| Hear after | session | `edit.hearAfter` | `B` | — | `actionBar` | — | — | — | — | none · none |
| Keep | project | `edit.keep` | `X` | — | `actionBar` | — | — (Keep rejects a pending suggestion, and on a cut it opens History where Undo brings the cut back; the verb is a GUI shortcut to the existing History and review commands) | — | — | none · none |
| Inspect | session | `edit.inspect` | `I` | — | `actionBar` | — | — | — | — | none · none |
| More | session | `edit.more` | `.` | — | `actionBar` | — | — | — | — | none · none |
| Mute | project | `edit.mute` | `M` | — | `actionBar` | `propose_range_mute_tool`, `track_set_mute_tool` | `podcast episode set-track-mute` | — | — | anchor · hear |

## Agent workflows

Host/agent capabilities without a ShareCut Studio `command` id (pipeline, transcript, NL, clips, …).

| Label | Effect | MCP | CLI | Skill | Host-only |
| ----- | ------ | --- | --- | ----- | --------- |
| Apply suggested actions | project | `apply_suggested_actions_tool` | `podcast edit apply-suggested` | `podcast-tighten-dialogue` | yes |
| Discard recording take | project | `record_discard_take_tool` | `podcast record discard-take` | `podcast-record-session` | yes |
| Show who lands on which track | session | `record_tracks_tool` | `podcast record tracks` | `podcast-record-session` | yes |
| Move a person to a track | project | `record_assign_track_tool` | `podcast record assign-track` | `podcast-record-session` | yes |
| List staged sessions | project | `list_session_suggestions_tool` | `podcast review session-suggestions` | `podcast-record-session` | yes |
| Accept staged session | project | `accept_session_suggestion_tool` | `podcast review accept-session-suggestion` | `podcast-record-session` | yes |
| Hear staged session | session | `hear_session_suggestion_tool` | `podcast review preview-session-suggestion` | `podcast-record-session` | yes |
| List staged session takes | project | `list_session_takes_tool` | `podcast review session-takes` | `podcast-record-session` | yes |
| Choose staged session take | project | `select_session_take_tool` | `podcast review select-session-take` | `podcast-record-session` | yes |
| Skip staged session | project | `skip_session_suggestion_tool` | `podcast review skip-session-suggestion` | `podcast-record-session` | yes |
| Record room state | view | `record_state_tool` | `podcast record state` | `podcast-record-session` | yes |
| Download exported files | view | — | — | — | — |
| Episode / track CRUD | project | `episode_create`, `track_set_meta_tool` | `podcast episode` | `podcast-setup` | yes |
| Transcript layers | project | `transcribe_track`, `get_transcript`, `get_transcript_vocabulary_tool`, `set_transcript_vocabulary_tool`, `precorrect_transcript_tool`, `transcript_refine_status_tool`, +3 | `podcast transcript` | `podcast-transcript-workflow` | yes |
| Edit decisions / NL cuts | project | `build_edit_context`, `search_transcript_tool`, `cut_time_range_tool`, `cut_text_match_tool`, `cut_utterance_tool`, `cut_words_tool`, +14 | `podcast edit`, `podcast edit applied`, `podcast edit restore-edit` | `podcast-edit-natural-language` | yes |
| Timeline / FX / reconcile | project | `strip_silence_tool`, `ripple_delete_text_tool`, `move_segment_tool`, `move_by_text_tool`, `insert_gap_tool`, `fade_joins_tool`, +49 | `podcast edit` | `podcast-audio-cleanup` | yes |
| Social clips | project | `propose_social_clips_tool`, `list_social_clips_tool`, `approve_social_clips_tool`, `reject_social_clips_tool`, `social_clip_report_tool`, `export_social_clips_tool` | `podcast clips` | `podcast-social-clips` | yes |
| Timeline comments | project | `add_comment_tool`, `list_comments_tool`, `get_comment_tool`, `update_comment_tool`, `resolve_comment_tool`, `add_comment_action_tool`, +3 | `podcast comment` | `podcast-timeline-comments` | — |
| Review versions / share | project | `publish_review_version_tool`, `list_review_versions_tool`, `set_active_review_version_tool`, `create_review_share_tool`, `revoke_record_room_tool` | `podcast review` | `podcast-timeline-comments` | yes |
| Pipeline / master / bounce | project | `pipeline_run`, `pipeline_get_config_tool`, `pipeline_set_config_tool`, `pipeline_analyze_tool`, `set_envelope`, `render_final` | `podcast pipeline` | `podcast-pipeline-run` | yes |
| History | project | `history_list`, `history_status_tool`, `history_goto_tool`, `history_diff_tool`, `history_record` | `podcast history` | `podcast-history` | yes |
| Play / audition | session | `play_transcript_query_tool`, `audition_context_tool`, `play_compose_tool`, `play_ab_tool`, `play_ab_wavs_tool`, `play_pending_preview_tool` | `podcast play` | `podcast-play-audition` | yes |
| DAW session sync | session | `get_session_state_tool`, `set_session_selection_tool`, `set_session_mode_tool`, `set_session_region_tool` | `podcast session` | `podcast-open-gui` | yes |
| Ingest alignment | project | `ingest_import_folder_tool`, `ingest_suggest_alignment_tool`, `ingest_verify_alignment_tool`, `play_compare_tool` | `podcast ingest` | `podcast-align-audio` | yes |
| Align accept gate | project | `align_status_tool`, `align_brief_tool`, `align_done_tool`, `align_waive_tool` | `podcast align` | `podcast-align-audio` | yes |
| Speaker attribution | project | `speaker_doctor_tool`, `speaker_enroll_tool`, `speaker_profiles_tool`, `speaker_score_tool`, `speaker_compare_window_tool`, `speaker_compare_pair_tool`, +6 | `podcast speaker` | `podcast-speaker-attribution` | yes |
| Open ShareCut Studio GUI | session | `open_gui_tool` | `podcast gui` | `podcast-open-gui` | yes |
| Segment library | project | `segment_list_tool`, `segment_show_tool`, `segment_save_tool`, `segment_insert_tool` | `podcast segment` | — | yes |
| Kits | project | `kit_list_tool`, `kit_show_tool`, `kit_save_tool`, `kit_apply_tool` | `podcast kit` | — | yes |
| Generic document commands | project | `document_command_schema_tool`, `submit_document_command_tool` | `podcast doc` | — | yes |
| Correct transcript | project | `correct_transcript_tool`, `correct_transcript_phrase_tool` | `podcast transcript correct` | — | — |
| Set longest automatic join fade | project | `set_join_fade_limit_tool` | `podcast episode set-join-fade-limit` | — | — |
| Read podcast listing | view | `feed_read` | `podcast feed show` | `podcast-rss-feed` | — |
| Edit podcast listing | project | `feed_set`, `feed_unset` | `podcast feed set` | `podcast-rss-feed` | — |
| Write podcast feed file | project | `feed_write` | `podcast feed write` | `podcast-rss-feed` | — |

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
