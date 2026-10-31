/** Generated from contracts/capabilities.manifest.json — do not edit by hand. */

export type CapabilityCopy = {
  label: string;
  tooltip?: string;
  tooltip_pressed?: string;
  toggle?: boolean;
};

export const CAPABILITY_COPY: Record<string, CapabilityCopy> = {
  "daw.transport.togglePlay": {
    label: "Play / pause",
    tooltip: "Play / pause",
  },
  "daw.transport.seek": {
    label: "Seek playhead",
  },
  "daw.transport.stop": {
    label: "Stop playback",
    tooltip: "Stop and return to where playback started",
  },
  "daw.transport.audition": {
    label: "Audition Full mix / Edited stems / Original",
    tooltip: "Audition Full mix, Edited stems, or Original",
  },
  "daw.presence.follow": {
    label: "Follow",
    tooltip: "Follow this person",
  },
  "daw.presence.unfollow": {
    label: "Stop following",
    tooltip: "Stop following",
  },
  "daw.edit.clearSelection": {
    label: "Clear selection",
    tooltip: "Clear selection",
  },
  "daw.create.menu": {
    label: "Create here",
    tooltip:
      "Open the create menu over the focused timeline target, else at the playhead on the selected track",
  },
  "daw.review.resolveComment": {
    label: "Resolve comment",
    tooltip: "Resolve this comment",
  },
  "daw.review.applySuggestedActions": {
    label: "Apply suggested actions",
    tooltip:
      "Give a list of sounds each its own suggested action in one undo step",
  },
  "daw.navigation.nudgePlayheadBack": {
    label: "Nudge playhead back",
  },
  "daw.navigation.nudgePlayheadForward": {
    label: "Nudge playhead forward",
  },
  "daw.navigation.goToStart": {
    label: "Go to start",
    tooltip: "Go to start",
  },
  "daw.navigation.goToEnd": {
    label: "Go to end",
    tooltip: "Go to end",
  },
  "daw.edit.bladeCut": {
    label: "Split at playhead",
    tooltip: "Split at the playhead, or Alt-click at the pointer",
  },
  "daw.edit.delete": {
    label: "Cut selection",
    tooltip: "Cut the selection",
  },
  "daw.track.remove": {
    label: "Remove track",
    tooltip: "Remove track",
  },
  "daw.track.splitSpeakers": {
    label: "Split speakers…",
    tooltip: "Split this track into one track per speaker",
  },
  "daw.track.reorder": {
    label: "Reorder track",
    tooltip: "Reorder track",
  },
  "daw.track.moveUp": {
    label: "Move track up",
    tooltip: "Move track up",
  },
  "daw.track.moveDown": {
    label: "Move track down",
    tooltip: "Move track down",
  },
  "daw.edit.rippleDelete": {
    label: "Ripple delete clip",
    tooltip: "Ripple delete clip",
  },
  "daw.edit.copy": {
    label: "Copy",
  },
  "daw.edit.cut": {
    label: "Cut",
  },
  "daw.edit.paste": {
    label: "Paste",
  },
  "daw.track.selectAll": {
    label: "Select all tracks",
    tooltip: "Select all tracks",
  },
  "daw.track.deselectAll": {
    label: "Deselect all tracks",
    tooltip: "Deselect all tracks",
  },
  "daw.track.muteToggle": {
    label: "Toggle track mute",
    tooltip: "Toggle track mute",
  },
  "daw.track.soloToggle": {
    label: "Toggle track solo",
    tooltip: "Toggle track solo",
  },
  "daw.track.clearSolo": {
    label: "Clear solo",
    tooltip:
      "Other tracks are silent for you only. Clear solo plays every track again",
  },
  "daw.track.setVolume": {
    label: "Set track volume",
    tooltip: "Set track volume",
  },
  "daw.view.zoomIn": {
    label: "Zoom in",
    tooltip: "Zoom in",
  },
  "daw.view.zoomOut": {
    label: "Zoom out",
    tooltip: "Zoom out",
  },
  "daw.view.fit": {
    label: "Fit session width",
    tooltip: "Fit session width",
  },
  "daw.stage.record": {
    label: "Go to Record",
    tooltip: "Go to Record",
  },
  "daw.stage.prepare": {
    label: "Go to Prepare",
    tooltip: "Go to Prepare",
  },
  "daw.stage.edit": {
    label: "Go to Edit",
    tooltip: "Go to Edit",
  },
  "daw.stage.review": {
    label: "Go to Review",
    tooltip: "Go to Review",
  },
  "daw.stage.deliver": {
    label: "Go to Deliver",
    tooltip: "Go to Deliver",
  },
  "daw.edit.history": {
    label: "Open history",
    tooltip: "Open history",
  },
  "daw.view.toggleScript": {
    label: "Show or hide Script",
    tooltip: "Show or hide Script",
  },
  "daw.view.scriptFocus": {
    label: "Script focus",
    tooltip: "Script focus",
  },
  "daw.view.waveformZoomIn": {
    label: "Waveform amplitude zoom in",
    tooltip: "Waveform amplitude zoom in",
  },
  "daw.view.waveformZoomOut": {
    label: "Waveform amplitude zoom out",
    tooltip: "Waveform amplitude zoom out",
  },
  "daw.view.fitTracksHeight": {
    label: "Fit tracks to window height",
    tooltip: "Fit tracks to window height",
    tooltip_pressed: "Use a fixed track height",
    toggle: true,
  },
  "daw.view.trackHeightIncrease": {
    label: "Increase track height",
    tooltip: "Increase track height",
  },
  "daw.view.trackHeightDecrease": {
    label: "Decrease track height",
    tooltip: "Decrease track height",
  },
  "daw.history.undo": {
    label: "Undo",
    tooltip: "Undo",
  },
  "daw.history.redo": {
    label: "Redo",
    tooltip: "Redo",
  },
  "daw.ui.toggleCommandPalette": {
    label: "Commands and shortcuts",
    tooltip: "Commands and shortcuts",
  },
  "daw.render.refreshMix": {
    label: "Refresh mix",
    tooltip: "Refresh mix",
  },
  "daw.export.bounce": {
    label: "Bounce…",
    tooltip: "Bounce…",
  },
  "daw.share.manage": {
    label: "Share…",
    tooltip: "Share…",
  },
  "daw.record.createRoom": {
    label: "Create record room",
    tooltip: "Create record room",
  },
  "daw.record.copyGuestLink": {
    label: "Copy guest link",
    tooltip: "Copy guest link",
  },
  "daw.record.start": {
    label: "Start recording",
    tooltip: "Start recording",
  },
  "daw.record.roomTone": {
    label: "Capture room tone",
    tooltip: "Capture room tone",
  },
  "daw.record.setTarget": {
    label: "Set session target",
    tooltip: "Set where this session lands",
  },
  "daw.record.pause": {
    label: "Pause recording",
    tooltip: "Pause recording",
  },
  "daw.record.resume": {
    label: "Resume recording",
    tooltip: "Resume recording",
  },
  "daw.record.stop": {
    label: "Stop recording",
    tooltip: "Stop recording",
  },
  "daw.record.land": {
    label: "Land recording on timeline",
    tooltip: "Land recording on timeline",
  },
  "daw.record.discardTake": {
    label: "Discard recording take",
    tooltip: "Discard recording take",
  },
  "daw.record.listTracks": {
    label: "Show who lands on which track",
    tooltip:
      "Show which track each person is matched to: matched, new or ambiguous",
  },
  "daw.record.assignTrack": {
    label: "Move a person to a track",
    tooltip:
      "Put a person on a different existing track or a new one before Accept",
  },
  "daw.review.listSessionSuggestions": {
    label: "List staged sessions",
    tooltip: "List recorded sessions staged for insert or replace",
  },
  "daw.review.acceptSessionSuggestion": {
    label: "Accept staged session",
    tooltip: "Place a staged recorded session on the timeline",
  },
  "daw.review.hearSessionSuggestion": {
    label: "Hear staged session",
    tooltip: "Hear a staged recorded session before and after it is placed",
  },
  "daw.review.listSessionTakes": {
    label: "List staged session takes",
    tooltip: "List the takes of a staged recorded session",
  },
  "daw.review.selectSessionTake": {
    label: "Choose staged session take",
    tooltip: "Choose which take of a staged recorded session is placed",
  },
  "daw.review.skipSessionSuggestion": {
    label: "Skip staged session",
    tooltip: "Skip a staged recorded session",
  },
  "daw.record.state": {
    label: "Record room state",
    tooltip: "Record room state",
  },
  "daw.record.marker": {
    label: "Record marker",
    tooltip: "Record marker",
  },
  "daw.mcp.connect": {
    label: "Connect agent…",
    tooltip: "Connect agent…",
  },
  "daw.help.diagnosticsBundle": {
    label: "Export diagnostics…",
    tooltip: "Create a sanitized diagnostics bundle",
  },
  "daw.models.open": {
    label: "Manage models…",
    tooltip: "See every model and download the ones you want",
  },
  "daw.export.deliverables": {
    label: "Export deliverables…",
    tooltip: "Export deliverables…",
  },
  "daw.export.files": {
    label: "Download exported files",
    tooltip:
      "Download or reveal a file an export wrote: audio, transcript, chapters or the feed file",
  },
  "daw.export.transcript": {
    label: "Export transcript…",
    tooltip: "Export transcript…",
  },
  "daw.project.new": {
    label: "New project…",
    tooltip: "New project…",
  },
  "daw.project.open": {
    label: "Open project…",
    tooltip: "Open project…",
  },
  "daw.project.home": {
    label: "All projects",
    tooltip: "All projects",
  },
  "daw.track.add": {
    label: "New track",
    tooltip: "New track",
  },
  "daw.media.import": {
    label: "Import audio…",
    tooltip: "Import audio…",
  },
  "agent.episode": {
    label: "Episode / track CRUD",
  },
  "agent.transcript": {
    label: "Transcript layers",
  },
  "agent.edits": {
    label: "Edit decisions / NL cuts",
  },
  "agent.timeline": {
    label: "Timeline / FX / reconcile",
  },
  "agent.social_clips": {
    label: "Social clips",
  },
  "agent.comments": {
    label: "Timeline comments",
  },
  "agent.review": {
    label: "Review versions / share",
  },
  "agent.pipeline": {
    label: "Pipeline / master / bounce",
  },
  "agent.history": {
    label: "History",
  },
  "agent.play": {
    label: "Play / audition",
  },
  "agent.session": {
    label: "DAW session sync",
  },
  "agent.ingest": {
    label: "Ingest alignment",
  },
  "agent.align-accept": {
    label: "Align accept gate",
  },
  "agent.speaker": {
    label: "Speaker attribution",
  },
  "agent.gui": {
    label: "Open ShareCut Studio GUI",
  },
  "daw.view.transcriptAnnotate": {
    label: "Annotate transcript",
    tooltip:
      "Annotate: show edit boundaries, low-confidence words, unsuppressed words with no matching speech, and cut-away text",
    tooltip_pressed: "Hide annotate marks (clean reading view)",
    toggle: true,
  },
  "daw.transcript.correct": {
    label: "Correct transcript",
    tooltip:
      "Correct: click a word to fix ASR text or suppress it (text only; audio and timing unchanged), or ignore it to mute its audio at render (no cut)",
    tooltip_pressed: "Exit Correct (restore seek-on-click)",
    toggle: true,
  },
  "daw.transcript.adjustTiming": {
    label: "Adjust word timing",
    tooltip:
      "Adjust source-word boundaries against the raw recording waveform; one Undo per drag",
  },
  "daw.transcript.editWordInline": {
    label: "Edit focused transcript word",
    tooltip:
      "F2: edit the focused timed word in Navigate mode; Enter saves, Escape cancels",
  },
  "daw.transcript.select": {
    label: "Select transcript range",
    tooltip:
      "Select: click/shift/drag words for copy/cut (Mod+C/X/V); cuts remove audio",
    tooltip_pressed: "Exit Select (restore seek-on-click)",
    toggle: true,
  },
  "daw.transcript.extendRange": {
    label: "Extend transcript range",
    tooltip:
      "Extend the selected word range by a word at either edge; on touch, long-press a word in Select mode and drag",
  },
  "daw.transcript.ignore": {
    label: "Ignore / restore transcript words",
    tooltip:
      "Ignore: strike through and mute the selection at render (no cut); Restore brings it back",
    tooltip_pressed:
      "Restore: un-mute the selection and remove its strikethrough",
  },
  "daw.transcript.nextLowConfidence": {
    label: "Next low-confidence word",
    tooltip:
      "Next low-confidence word: seek and scroll to it, wrapping to the first; in Correct mode it opens in the word editor",
  },
  "daw.transcript.prevLowConfidence": {
    label: "Previous low-confidence word",
    tooltip:
      "Previous low-confidence word: seek and scroll to it, wrapping to the last; in Correct mode it opens in the word editor",
  },
  "daw.view.showCutAway": {
    label: "Show cut away",
    tooltip: "Show words removed by timeline cuts (drag boundaries to restore)",
    tooltip_pressed: "Hide cut-away words",
    toggle: true,
  },
  "daw.edit.trimClipEdge": {
    label: "Trim clip edge",
    tooltip: "Drag or use focused Left/Right arrows to trim a clip edge",
  },
  "daw.edit.moveClips": {
    label: "Move clips",
    tooltip:
      "Move clip in the inspector previews time and target track before Apply move; clip-body drag also moves clips",
  },
  "daw.edit.addChapter": {
    label: "Add chapter at playhead",
    tooltip: "Add a chapter marker at the playhead · turns Markers on",
  },
  "daw.envelope.addPoint": {
    label: "Add envelope point",
    tooltip:
      "Add a volume envelope point at the held time, at the level already there",
  },
  "daw.record.here": {
    label: "Record here",
    tooltip: "Open Record to insert a take at the held time",
  },
  "daw.comment.draftAt": {
    label: "Add comment",
    tooltip: "Start a comment at the held time",
  },
  "daw.edit.restoreClipBleed": {
    label: "Restore original audio",
    tooltip: "Restore one selected automatic reduction in this clip occurrence",
  },
  "daw.edit.rollClipJoin": {
    label: "Roll clip join",
    tooltip: "Drag join to roll both clip edges · clips stay flush",
  },
  "daw.edit.setClipFade": {
    label: "Set clip fade",
    tooltip: "Drag or use focused Left/Right arrows to set fade length",
  },
  "daw.edit.setClipJoin": {
    label: "Set clip join",
    tooltip:
      "How this clip meets the previous one: cut, fade or crossfade, with its length",
  },
  "daw.transcript.findReplace": {
    label: "Find and replace transcript",
    tooltip:
      "Preview literal replacements across all source transcripts, then apply them as one undoable pass.",
  },
  "daw.range.play": {
    label: "Play range",
    tooltip: "Play range",
  },
  "daw.range.cut": {
    label: "Cut selected range",
    tooltip: "Cut selected range",
  },
  "daw.range.mute": {
    label: "Mute selected range",
    tooltip: "Mute selected range",
  },
  "daw.range.fillRoomTone": {
    label: "Fill range with room tone",
    tooltip: "Fill the clip-free time in a range with the track's room tone",
  },
  "daw.range.moveSpeakerLaneSpan": {
    label: "Move to speaker",
    tooltip: "Move the range to another speaker track",
  },
  "daw.range.comment": {
    label: "Comment on range",
    tooltip: "Comment on range",
  },
  "daw.range.bounce": {
    label: "Bounce selected range",
    tooltip: "Bounce selected range",
  },
  "daw.range.arm": {
    label: "Select a range",
    tooltip: "Select a range",
  },
  "daw.edit.split": {
    label: "Split",
    tooltip:
      "Split at the playhead, or at both edges of the selected words or range (S)",
  },
  "daw.edit.hear": {
    label: "Hear",
    tooltip: "Hear the selection (Shift+Space)",
  },
  "daw.edit.hearBefore": {
    label: "Hear before",
    tooltip: "Hear the suggestion as it is now (A)",
  },
  "daw.edit.hearAfter": {
    label: "Hear after",
    tooltip: "Hear the suggestion applied (B)",
  },
  "daw.edit.keep": {
    label: "Keep",
    tooltip: "Keep what is cut, or reject the selected suggestion (X)",
  },
  "daw.edit.inspect": {
    label: "Inspect",
    tooltip: "Open the Inspector for the selection (I)",
  },
  "daw.edit.more": {
    label: "More",
    tooltip: "More actions for the selection (.)",
  },
  "daw.edit.mute": {
    label: "Mute",
    tooltip: "Mute the selection, else the targeted track (M)",
  },
  "daw.feed.read": {
    label: "Read podcast listing",
    tooltip:
      "Read the episode's podcast listing: show notes, chapters, people and what the feed still needs",
  },
  "daw.feed.edit": {
    label: "Edit podcast listing",
    tooltip:
      "Pin or release one podcast listing value: an episode value in one undo step, a show value in the show",
  },
  "daw.feed.write": {
    label: "Write podcast feed file",
    tooltip:
      "Write the episode's feed file next to the exported audio; refused while the feed has a blocker",
  },
};

export const GUI_SURFACE_TO_CAPABILITY: Record<string, string> = {
  "transport.play": "daw.transport.togglePlay",
  "transport.stop": "daw.transport.stop",
  "transport.audition": "daw.transport.audition",
  "presence.avatarStack": "daw.presence.follow",
  "presence.followBanner": "daw.presence.unfollow",
  timeline: "daw.edit.bladeCut",
  "timeline.createMenu": "daw.comment.draftAt",
  clipInspector: "daw.edit.moveClips",
  actionBar: "daw.edit.mute",
  trackInspector: "daw.track.setVolume",
  SourceCard: "daw.track.splitSpeakers",
  trackHeader: "daw.track.soloToggle",
  trackHeadersWell: "daw.track.deselectAll",
  "trackHeaders.soloChip": "daw.track.clearSolo",
  trackMix: "daw.track.clearSolo",
  editCorner: "daw.range.arm",
  viewSheet: "daw.view.trackHeightDecrease",
  "transport.fit": "daw.view.fit",
  stageBar: "daw.stage.deliver",
  editPlusMenu: "daw.edit.addChapter",
  historyPanel: "daw.history.redo",
  "timeline.waveform": "daw.view.waveformZoomOut",
  "transport.fitTracksHeight": "daw.view.fitTracksHeight",
  "mobileShell.gesture.twoFingerTap": "daw.history.undo",
  "transcript.findReplace": "daw.transcript.findReplace",
  "transcript.wordbar": "daw.transcript.adjustTiming",
  GesturesSheet: "daw.ui.toggleCommandPalette",
  deliverShare: "daw.share.manage",
  deliverBounce: "daw.export.bounce",
  RecordStage: "daw.record.marker",
  HostMcpDialog: "daw.mcp.connect",
  "home.help": "daw.help.diagnosticsBundle",
  HelpDialog: "daw.help.diagnosticsBundle",
  "home.models": "daw.models.open",
  ModelsDialog: "daw.models.open",
  deliverStage: "daw.export.deliverables",
  deliverTranscript: "daw.export.transcript",
  projectMenu: "daw.project.home",
  trackLane: "daw.track.add",
  drop: "daw.media.import",
  "transcript.annotate": "daw.view.transcriptAnnotate",
  "transcript.correct": "daw.transcript.correct",
  "mobileShell.gesture.doubleTapWord": "daw.transcript.correct",
  "transcript.inlineEdit": "daw.transcript.correct",
  "transcript.select": "daw.transcript.select",
  "rangeActions.words": "daw.transcript.ignore",
  "transcript.ignore": "daw.transcript.ignore",
  "transcript.restoreIgnored": "daw.transcript.ignore",
  "inspector.word.ignore": "daw.transcript.ignore",
  "transcript.lowConfidenceNext": "daw.transcript.nextLowConfidence",
  "transcript.lowConfidencePrev": "daw.transcript.prevLowConfidence",
  "transcript.showCutAway": "daw.view.showCutAway",
  "timeline.clip.trimHandle": "daw.edit.trimClipEdge",
  "timeline.clip.body": "daw.edit.moveClips",
  restoreClipBleed: "daw.edit.restoreClipBleed",
  "timeline.clip.joinDiamond": "daw.edit.rollClipJoin",
  "transcript.editBoundary": "daw.edit.rollClipJoin",
  "timeline.clip.fadeHandle": "daw.edit.setClipFade",
  "inspector.clip.joinMode": "daw.edit.setClipJoin",
  "timeline.join.badge": "daw.edit.setClipJoin",
};

export function capabilityTooltip(
  idOrGui: string,
  opts?: { pressed?: boolean },
): string {
  const id = CAPABILITY_COPY[idOrGui]
    ? idOrGui
    : GUI_SURFACE_TO_CAPABILITY[idOrGui];
  const row = id ? CAPABILITY_COPY[id] : undefined;
  if (!row) return idOrGui;
  if (opts?.pressed && row.tooltip_pressed) return row.tooltip_pressed;
  return row.tooltip ?? row.label;
}

export function capabilityLabel(idOrGui: string): string {
  const id = CAPABILITY_COPY[idOrGui]
    ? idOrGui
    : GUI_SURFACE_TO_CAPABILITY[idOrGui];
  const row = id ? CAPABILITY_COPY[id] : undefined;
  return row?.label ?? idOrGui;
}
