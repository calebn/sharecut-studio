/**
 * Sharecut Studio keybinding catalog (keys → command ids).
 *
 * Character-key shortcuts (letters, digits, Space) are WCAG 2.1.4 sensitive:
 * handlers must scope them via command when-clauses, or later offer disable/remap.
 * Arrow keys are not character keys under that criterion.
 *
 * Mod+chords (e.g. history undo) are an OS-aware exception to bare-key tool keys.
 *
 * Cheatsheet UI can render {@link keymapByCategory}. Dispatch goes through
 * commands/execute — never scatter key strings in handlers.
 */

import type { ContextPredicateId } from "../commands/types";
import { useDawStore } from "../state/dawStore";
import { getKeymapOverride } from "./remaps";

export type KeymapCategory =
  | "transport"
  | "tools"
  | "focus"
  | "navigation"
  | "review"
  | "history"
  | "edit"
  | "view"
  | "ui"
  | "presence";

export type KeymapCommand = {
  id: string;
  category: KeymapCategory;
  label: string;
  /** Display / match keys (e.g. "V", "ArrowLeft", " "). */
  keys: string[];
  /** When true (default), ignore if meta/ctrl/alt held. */
  bareKey?: boolean;
  /** When true, require meta or ctrl (Mod+key chords). */
  requireMod?: boolean;
  /** true = Shift required; false = Shift excluded; omit = Shift optional. */
  requireShift?: boolean;
  /** Keyboard when-clause — must match command catalog when for that id. */
  when: ContextPredicateId;
  notes?: string;
};

export const KEYMAP_COMMANDS: readonly KeymapCommand[] = [
  {
    id: "presence.unfollow",
    category: "presence",
    label: "Stop following",
    keys: ["Escape"],
    bareKey: true,
    when: "following",
  },
  {
    id: "transport.togglePlay",
    category: "transport",
    label: "Play / pause",
    keys: [" ", "Space"],
    bareKey: true,
    when: "layoutFocused",
    notes: "When timeline or transcript is focused",
  },
  {
    id: "transport.stop",
    category: "transport",
    label: "Stop playback",
    keys: ["K"],
    bareKey: true,
    when: "always",
  },
  {
    id: "tool.select",
    category: "tools",
    label: "Select tool",
    keys: ["V"],
    bareKey: true,
    when: "timelineAndStructural",
    notes: "When timeline is focused",
  },
  {
    id: "tool.blade",
    category: "tools",
    label: "Blade tool",
    keys: ["C"],
    bareKey: true,
    when: "timelineAndStructural",
    notes: "When timeline is focused",
  },
  {
    id: "review.exitCommentMode",
    category: "review",
    label: "Exit comment mode",
    keys: ["Escape"],
    bareKey: true,
    when: "commentMode",
  },
  {
    id: "edit.clearSelection",
    category: "edit",
    label: "Clear selection",
    keys: ["Escape"],
    bareKey: true,
    when: "hasInspectorSelection",
    notes: "After exitCommentMode; does not clear track targeting",
  },
  {
    id: "review.toggleCommentMode",
    category: "review",
    label: "Toggle comment mode",
    keys: ["C"],
    bareKey: false,
    requireMod: true,
    requireShift: true,
    when: "always",
    notes: "Mod+Shift+C",
  },
  {
    id: "focus.default",
    category: "focus",
    label: "Focus: default layout",
    keys: ["1"],
    bareKey: true,
    when: "layoutFocused",
  },
  {
    id: "focus.timeline",
    category: "focus",
    label: "Focus: timeline",
    keys: ["2"],
    bareKey: true,
    when: "layoutFocused",
  },
  {
    id: "focus.text",
    category: "focus",
    label: "Focus: text",
    keys: ["3"],
    bareKey: true,
    when: "layoutFocused",
  },
  {
    id: "focus.review",
    category: "focus",
    label: "Focus: review",
    keys: ["4"],
    bareKey: true,
    when: "layoutFocused",
  },
  {
    id: "navigation.nudgePlayheadBack",
    category: "navigation",
    label: "Nudge playhead back",
    keys: ["ArrowLeft"],
    bareKey: true,
    when: "always",
    notes: "Shift for 5 seconds",
  },
  {
    id: "navigation.nudgePlayheadForward",
    category: "navigation",
    label: "Nudge playhead forward",
    keys: ["ArrowRight"],
    bareKey: true,
    when: "always",
    notes: "Shift for 5 seconds",
  },
  {
    id: "navigation.goToStart",
    category: "navigation",
    label: "Go to start",
    keys: ["ArrowLeft"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "always",
    notes: "Mod+ArrowLeft — Home alias for laptops",
  },
  {
    id: "navigation.goToStart",
    category: "navigation",
    label: "Go to start",
    keys: ["Home"],
    bareKey: true,
    when: "always",
    notes: "Also Mod+ArrowLeft (laptops without Home)",
  },
  {
    id: "navigation.goToEnd",
    category: "navigation",
    label: "Go to end",
    keys: ["ArrowRight"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "always",
    notes: "Mod+ArrowRight — End alias for laptops",
  },
  {
    id: "navigation.goToEnd",
    category: "navigation",
    label: "Go to end",
    keys: ["End"],
    bareKey: true,
    when: "always",
    notes: "Also Mod+ArrowRight (laptops without End)",
  },
  {
    id: "history.undo",
    category: "history",
    label: "Undo",
    keys: ["Z"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "hasProject",
    notes: "Mod+Z",
  },
  {
    id: "history.redo",
    category: "history",
    label: "Redo",
    keys: ["Z"],
    bareKey: false,
    requireMod: true,
    requireShift: true,
    when: "hasProject",
    notes: "Mod+Shift+Z",
  },
  {
    id: "edit.copy",
    category: "edit",
    label: "Copy",
    keys: ["C"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "hasProject",
    notes: "Mod+C",
  },
  {
    id: "edit.cut",
    category: "edit",
    label: "Cut",
    keys: ["X"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "canApplyPass12",
    notes: "Mod+X",
  },
  {
    id: "edit.paste",
    category: "edit",
    label: "Paste",
    keys: ["V"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "canApplyPass12",
    notes: "Mod+V — same-track at playhead",
  },
  {
    id: "tighten.applyHit",
    category: "review",
    label: "Apply tighten hit",
    keys: ["Enter"],
    bareKey: true,
    when: "tightenPanelOpen",
    notes: "Enter — selected filler/pause hit",
  },
  {
    id: "tighten.skipHit",
    category: "review",
    label: "Skip tighten hit",
    keys: ["Backspace"],
    bareKey: true,
    when: "tightenPanelOpen",
    notes: "Backspace — selected filler/pause hit",
  },
  {
    id: "tighten.applyAllSafe",
    category: "review",
    label: "Apply eligible tighten hits",
    keys: ["Enter"],
    bareKey: false,
    requireMod: true,
    requireShift: true,
    when: "tightenPanelOpen",
    notes: "Mod+Shift+Enter — skip harsh when Avoid harsh cuts is on",
  },
  {
    id: "tighten.previewHit",
    category: "review",
    label: "Preview tighten hit",
    keys: ["P"],
    bareKey: true,
    when: "tightenPanelOpen",
    notes: "P — Suggested skip when possible",
  },
  {
    id: "track.remove",
    category: "edit",
    label: "Remove track",
    keys: ["Backspace", "Delete"],
    bareKey: true,
    when: "trackInspectorSelected",
    notes: "Before edit.delete — inspector track selection only",
  },
  {
    id: "track.moveUp",
    category: "edit",
    label: "Move track up",
    keys: ["ArrowUp"],
    bareKey: true,
    requireShift: false,
    when: "canMoveSelectedTrackUp",
    notes: "Inspector track selected",
  },
  {
    id: "track.moveDown",
    category: "edit",
    label: "Move track down",
    keys: ["ArrowDown"],
    bareKey: true,
    requireShift: false,
    when: "canMoveSelectedTrackDown",
    notes: "Inspector track selected",
  },
  {
    id: "edit.delete",
    category: "edit",
    label: "Delete clip",
    keys: ["Backspace", "Delete"],
    bareKey: true,
    when: "canSuggestStructural",
  },
  {
    id: "edit.rippleDelete",
    category: "edit",
    label: "Ripple delete clip",
    keys: ["Backspace"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "canSuggestStructural",
    notes: "Mod+Backspace",
  },
  {
    id: "edit.bladeCut",
    category: "edit",
    label: "Blade cut at playhead",
    keys: ["K"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "canSuggestStructural",
    notes: "Mod+K — cut at playhead",
  },
  {
    id: "track.selectAll",
    category: "edit",
    label: "Select all tracks",
    keys: ["A"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "timelineFocused",
    notes: "Mod+A — Logic-style track targeting",
  },
  {
    id: "track.deselectAll",
    category: "edit",
    label: "Deselect all tracks",
    keys: ["A"],
    bareKey: false,
    requireMod: true,
    requireShift: true,
    when: "timelineFocused",
    notes: "Mod+Shift+A — Logic-style; empty targeting",
  },
  {
    id: "track.muteToggle",
    category: "edit",
    label: "Toggle track mute",
    keys: ["M"],
    bareKey: true,
    when: "hasProject",
  },
  {
    id: "record.marker",
    category: "ui",
    label: "Record marker",
    keys: ["M"],
    bareKey: true,
    when: "recordPanelOpen",
    notes:
      "M — live marker while the record panel is open; with the panel closed, M still mutes the targeted track",
  },
  {
    id: "track.soloToggle",
    category: "edit",
    label: "Toggle track solo",
    keys: ["S"],
    bareKey: true,
    when: "hasProject",
  },
  {
    id: "view.zoomIn",
    category: "view",
    label: "Zoom in",
    keys: ["=", "+"],
    bareKey: true,
    when: "timelineFocused",
    notes: "Timeline focused; also numpad +",
  },
  {
    id: "view.zoomOut",
    category: "view",
    label: "Zoom out",
    keys: ["-"],
    bareKey: true,
    when: "timelineFocused",
    notes: "Timeline focused; also numpad -",
  },
  {
    id: "view.fit",
    category: "view",
    label: "Fit session in view",
    keys: ["\\"],
    bareKey: true,
    when: "timelineFocused",
    notes: "Timeline focused",
  },
  {
    id: "view.waveformZoomIn",
    category: "view",
    label: "Waveform amplitude zoom in",
    keys: ["ArrowUp"],
    bareKey: true,
    requireShift: true,
    when: "timelineFocused",
    notes: "Shift+ArrowUp — timeline focused",
  },
  {
    id: "view.waveformZoomOut",
    category: "view",
    label: "Waveform amplitude zoom out",
    keys: ["ArrowDown"],
    bareKey: true,
    requireShift: true,
    when: "timelineFocused",
    notes: "Shift+ArrowDown — timeline focused",
  },
  {
    id: "ui.toggleCommandPalette",
    category: "ui",
    label: "Command cheatsheet",
    keys: ["?"],
    bareKey: true,
    when: "always",
    notes: "Also Shift+/",
  },
  {
    id: "render.refreshMix",
    category: "transport",
    label: "Refresh mix",
    keys: ["B"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "canRefreshMix",
    notes: "Mod+B — rebuild stems/premix when host or Docs Editor",
  },
  {
    id: "export.bounce",
    category: "ui",
    label: "Bounce…",
    keys: ["B"],
    bareKey: false,
    requireMod: true,
    requireShift: true,
    when: "canExportProject",
    notes: "Mod+Shift+B — bounce dialog (export/bounces/)",
  },
  {
    id: "export.deliverables",
    category: "ui",
    label: "Export deliverables",
    keys: ["E"],
    bareKey: false,
    requireMod: true,
    requireShift: true,
    when: "canManageProjects",
    notes: "Mod+Shift+E — mastered export/ via PipelineService",
  },
  {
    id: "project.new",
    category: "ui",
    label: "New project",
    keys: ["N"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "canManageProjects",
    notes: "Mod+N",
  },
  {
    id: "project.open",
    category: "ui",
    label: "Open project",
    keys: ["O"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "canManageProjects",
    notes: "Mod+O — OS dialog via local engine; paste path fallback",
  },
  {
    id: "track.add",
    category: "edit",
    label: "New track",
    keys: ["T"],
    bareKey: false,
    requireMod: true,
    requireShift: true,
    when: "canIngestMedia",
    notes: "Mod+Shift+T (Shift avoids browser New Tab; Reaper uses Mod+T)",
  },
  {
    id: "media.import",
    category: "edit",
    label: "Import audio",
    keys: ["I"],
    bareKey: false,
    requireMod: true,
    requireShift: false,
    when: "canIngestMedia",
    notes: "Mod+I — Menu or drop on arrange",
  },
] as const;

export function formatShortcutKeys(cmd: KeymapCommand): string {
  const override = getKeymapOverride(cmd.id);
  if (override?.length) {
    return override.join("+");
  }
  const primary = cmd.keys[0] ?? "";
  if (primary === " " || primary === "Space") {
    return "Space";
  }
  const parts: string[] = [];
  if (cmd.requireMod) {
    parts.push("Mod");
  }
  if (cmd.requireShift) {
    parts.push("Shift");
  }
  parts.push(primary === "?" ? "?" : primary);
  return parts.join("+");
}

export function keymapCommandById(id: string): KeymapCommand | undefined {
  return KEYMAP_COMMANDS.find((c) => c.id === id);
}

export function keymapByCategory(): Record<KeymapCategory, KeymapCommand[]> {
  const out: Record<KeymapCategory, KeymapCommand[]> = {
    transport: [],
    tools: [],
    focus: [],
    navigation: [],
    review: [],
    history: [],
    edit: [],
    view: [],
    ui: [],
    presence: [],
  };
  for (const cmd of KEYMAP_COMMANDS) {
    out[cmd.category].push(cmd);
  }
  return out;
}

function eventKeyCandidates(
  e: Pick<KeyboardEvent, "key" | "code" | "shiftKey">,
): string[] {
  const keys = [e.key];
  if (e.code === "Space" || e.key === " ") {
    keys.push(" ", "Space");
  }
  if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
    keys.push("?");
  }
  if (e.key.length === 1) {
    keys.push(e.key.toUpperCase(), e.key.toLowerCase());
  }
  return keys;
}

function effectiveKeys(cmd: KeymapCommand): string[] {
  const override = getKeymapOverride(cmd.id);
  return override?.length ? override : [...cmd.keys];
}

export function matchKeymapCommands(
  e: Pick<
    KeyboardEvent,
    "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): KeymapCommand[] {
  const candidates = eventKeyCandidates(e);
  const mod = e.metaKey || e.ctrlKey;
  const out: KeymapCommand[] = [];

  for (const cmd of KEYMAP_COMMANDS) {
    if (cmd.requireMod) {
      if (!mod || e.altKey) {
        continue;
      }
      if (cmd.requireShift === true && !e.shiftKey) {
        continue;
      }
      if (cmd.requireShift === false && e.shiftKey) {
        continue;
      }
    } else {
      const bare = cmd.bareKey !== false;
      if (bare && (e.metaKey || e.ctrlKey || e.altKey)) {
        continue;
      }
      if (cmd.requireShift === true && !e.shiftKey) {
        continue;
      }
      if (cmd.requireShift === false && e.shiftKey) {
        continue;
      }
    }

    const keys = effectiveKeys(cmd);
    const matched = keys.some((k) =>
      candidates.some((c) => c === k || c.toUpperCase() === k.toUpperCase()),
    );
    if (matched) {
      out.push(cmd);
    }
  }
  return out;
}

/** First keymap row that matches the event (ignores when-clauses). */
export function matchKeymapCommand(
  e: Pick<
    KeyboardEvent,
    "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): KeymapCommand | null {
  return matchKeymapCommands(e)[0] ?? null;
}

export function argsFromKeyEvent(
  e: Pick<KeyboardEvent, "shiftKey">,
  commandId: string,
): Record<string, unknown> {
  if (
    commandId === "navigation.nudgePlayheadBack" ||
    commandId === "navigation.nudgePlayheadForward"
  ) {
    return { shift: e.shiftKey };
  }
  if (commandId === "tighten.applyAllSafe") {
    const scope = useDawStore.getState().tightenApplyScope;
    return {
      avoidHarsh: scope.avoidHarsh,
      ids: [...scope.ids],
    };
  }
  return {};
}
