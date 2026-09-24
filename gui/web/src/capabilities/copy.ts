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
    tooltip: "Stop playback",
  },
  "daw.transport.audition": {
    label: "Audition Mix / FX / Raw",
    tooltip: "Audition Mix, FX, or Raw",
  },
  "daw.presence.follow": {
    label: "Follow",
    tooltip: "Follow this person",
  },
  "daw.presence.unfollow": {
    label: "Stop following",
    tooltip: "Stop following",
  },
  "daw.tool.select": {
    label: "Select tool",
    tooltip: "Select tool",
  },
  "daw.tool.blade": {
    label: "Blade tool",
    tooltip: "Blade tool",
  },
  "daw.review.exitCommentMode": {
    label: "Exit comment mode",
  },
  "daw.edit.clearSelection": {
    label: "Clear selection",
    tooltip: "Clear selection",
  },
  "daw.review.toggleCommentMode": {
    label: "Toggle comment mode",
    tooltip: "Toggle comment mode",
  },
  "daw.review.resolveComment": {
    label: "Resolve comment",
    tooltip: "Resolve this comment",
  },
  "daw.tighten.applyHit": {
    label: "Apply tighten hit",
    tooltip: "Apply the selected tighten cut",
  },
  "daw.tighten.skipHit": {
    label: "Skip tighten hit",
    tooltip: "Skip the selected tighten cut",
  },
  "daw.tighten.applyAllSafe": {
    label: "Apply eligible tighten hits",
    tooltip: "Apply listed tighten hits, skipping harsh cuts when enabled",
  },
  "daw.tighten.previewHit": {
    label: "Preview tighten hit",
    tooltip: "Preview the selected tighten hit",
  },
  "daw.tighten.goToHit": {
    label: "Go to tighten hit",
    tooltip: "Seek the playhead to a tighten hit",
  },
  "daw.focus.default": {
    label: "Focus: default layout",
    tooltip: "Focus: default layout",
  },
  "daw.focus.timeline": {
    label: "Focus: timeline",
    tooltip: "Focus: timeline",
  },
  "daw.focus.text": {
    label: "Focus: text",
    tooltip: "Focus: text",
  },
  "daw.focus.review": {
    label: "Focus: review",
    tooltip: "Focus: review",
  },
  "daw.focus.cycle": {
    label: "Cycle focus mode",
    tooltip: "Cycle focus mode",
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
    label: "Blade cut",
    tooltip: "Blade cut at the playhead or clicked time",
  },
  "daw.edit.bladeCut.confirm": {
    label: "Confirm blade cut",
    tooltip: "Confirm blade cut",
  },
  "daw.edit.bladeCut.cancel": {
    label: "Cancel blade cut",
    tooltip: "Cancel blade cut",
  },
  "daw.edit.delete": {
    label: "Delete clip",
    tooltip: "Delete clip",
  },
  "daw.track.remove": {
    label: "Remove track",
    tooltip: "Remove track",
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
  "daw.view.zoomIn": {
    label: "Zoom in",
    tooltip: "Zoom in",
  },
  "daw.view.zoomOut": {
    label: "Zoom out",
    tooltip: "Zoom out",
  },
  "daw.view.fit": {
    label: "Fit session in view",
    tooltip: "Fit session in view",
  },
  "daw.view.setTab": {
    label: "Switch editor tab",
    tooltip: "Switch editor tab",
  },
  "daw.view.setMobileMode": {
    label: "Switch phone mode",
    tooltip: "Switch phone Listen / Timeline / Text / More",
  },
  "daw.view.waveformZoomIn": {
    label: "Waveform amplitude zoom in",
    tooltip: "Waveform amplitude zoom in",
  },
  "daw.view.waveformZoomOut": {
    label: "Waveform amplitude zoom out",
    tooltip: "Waveform amplitude zoom out",
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
    label: "Command cheatsheet",
    tooltip: "Command cheatsheet",
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
  "daw.record.start": {
    label: "Start recording",
    tooltip: "Start recording",
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
  "daw.record.panel": {
    label: "Record panel",
    tooltip: "Record panel",
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
    label: "Help…",
    tooltip: "Create a sanitized diagnostics bundle",
  },
  "daw.export.deliverables": {
    label: "Export deliverables",
    tooltip: "Export deliverables",
  },
  "daw.project.new": {
    label: "New project",
    tooltip: "New project",
  },
  "daw.project.open": {
    label: "Open project",
    tooltip: "Open project",
  },
  "daw.track.add": {
    label: "New track",
    tooltip: "New track",
  },
  "daw.media.import": {
    label: "Import audio",
    tooltip: "Import audio",
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
    label: "Open Sharecut Studio GUI",
  },
  "daw.view.transcriptAnnotate": {
    label: "Annotate transcript",
    tooltip:
      "Annotate: show edit boundaries, low-confidence words, and cut-away text",
    tooltip_pressed: "Hide annotate marks (clean reading view)",
    toggle: true,
  },
  "daw.transcript.correct": {
    label: "Correct transcript",
    tooltip: "Correct: click a word to fix ASR text or suppress",
    tooltip_pressed: "Exit Correct (restore seek-on-click)",
    toggle: true,
  },
  "daw.transcript.select": {
    label: "Select transcript range",
    tooltip: "Select: click/shift/drag words for copy/cut (Mod+C/X/V)",
    tooltip_pressed: "Exit Select (restore seek-on-click)",
    toggle: true,
  },
  "daw.view.showCutAway": {
    label: "Show cut away",
    tooltip: "Show words removed by timeline cuts (drag boundaries to restore)",
    tooltip_pressed: "Hide cut-away words",
    toggle: true,
  },
  "daw.edit.trimClipEdge": {
    label: "Trim clip edge",
    tooltip:
      "Drag clip start or end to expand or trim this clip · waveform preview shows restored audio",
  },
  "daw.edit.moveClips": {
    label: "Move clips",
    tooltip:
      "Drag clip bodies to move in time or onto another track · gaps and overlap allowed",
  },
  "daw.edit.rollClipJoin": {
    label: "Roll clip join",
    tooltip: "Drag join to roll both clip edges · clips stay flush",
  },
  "daw.edit.setClipFade": {
    label: "Set clip fade",
    tooltip: "Drag to set fade length (distinct from trim)",
  },
  "daw.view.editBoundary": {
    label: "Edit boundary",
    tooltip: "Edit boundary glyph (Annotate)",
  },
  "daw.view.cutAwayWord": {
    label: "Cut-away word",
    tooltip: "Cut away — not in the mix · drag nearby boundary to restore",
  },
};

export const GUI_SURFACE_TO_CAPABILITY: Record<string, string> = {
  "transport.play": "daw.transport.togglePlay",
  "transport.stop": "daw.transport.stop",
  "transport.audition": "daw.transport.audition",
  "presence.avatarStack": "daw.presence.follow",
  "presence.followBanner": "daw.presence.unfollow",
  toolModeToggle: "daw.tool.blade",
  "transport.comment": "daw.review.toggleCommentMode",
  "mobileShell.gesture.swipeLeftComment": "daw.review.resolveComment",
  tightenPanel: "daw.tighten.goToHit",
  focusToggle: "daw.focus.review",
  "transport.menu": "daw.media.import",
  editingToolRail: "daw.media.import",
  timeline: "daw.edit.bladeCut",
  bladeConfirmSheet: "daw.edit.bladeCut.cancel",
  clipInspector: "daw.edit.rippleDelete",
  trackInspector: "daw.track.remove",
  trackHeader: "daw.track.soloToggle",
  trackHeadersWell: "daw.track.deselectAll",
  "transport.fit": "daw.view.fit",
  tabBar: "daw.view.setTab",
  mobileNav: "daw.view.setMobileMode",
  "timeline.waveform": "daw.view.waveformZoomOut",
  historyPanel: "daw.history.redo",
  "mobileShell.gesture.twoFingerTap": "daw.history.undo",
  staleRenderPill: "daw.render.refreshMix",
  BounceDialog: "daw.export.bounce",
  ShareDialog: "daw.share.manage",
  RecordPanel: "daw.record.panel",
  "transport.recChip": "daw.record.stop",
  LiveComments: "daw.record.marker",
  HostMcpDialog: "daw.mcp.connect",
  "home.help": "daw.help.diagnosticsBundle",
  HelpDialog: "daw.help.diagnosticsBundle",
  trackLane: "daw.track.add",
  drop: "daw.media.import",
  "transcript.annotate": "daw.view.transcriptAnnotate",
  "transcript.correct": "daw.transcript.correct",
  "mobileShell.gesture.doubleTapWord": "daw.transcript.correct",
  "transcript.select": "daw.transcript.select",
  "transcript.showCutAway": "daw.view.showCutAway",
  "timeline.clip.trimHandle": "daw.edit.trimClipEdge",
  "timeline.clip.body": "daw.edit.moveClips",
  "timeline.clip.joinDiamond": "daw.edit.rollClipJoin",
  "transcript.editBoundary": "daw.edit.rollClipJoin",
  "timeline.clip.fadeHandle": "daw.edit.setClipFade",
  "transcript.cutAwayWord": "daw.view.cutAwayWord",
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
