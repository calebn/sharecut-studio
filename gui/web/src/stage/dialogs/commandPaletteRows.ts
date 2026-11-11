/**
 * Builds the command palette's rows from the command catalog (the single
 * source), with each command's shortcut (in the Menu's platform form, ⌘E
 * or Ctrl+E) and remap from the live keymap registry. It imports the store-bound registry at runtime, so
 * CommandPaletteView.tsx and its stories import the store-free model from
 * `paletteSearch.ts` instead.
 */

import type { RecentProject } from "../../api";
import { COMMANDS, listCatalogIds } from "../../commands/catalog";
import { type CommandContext, evaluateWhen } from "../../commands/context";
import {
  displayShortcutFor,
  KEYMAP_CATEGORY_ORDER,
  keymapCommandById,
} from "../../keymap/registry";
import type { SystemIconName } from "../../system/icons";
import { STAGES, VERBS, type VerbDef } from "../../system/verbs";
import type { ChapterMarker } from "../../types/project";
import { formatTimeShort } from "../../utils/time";
import type {
  PaletteCommand,
  PaletteCommandGroup,
  PaletteEntry,
} from "./paletteSearch";

/** Verb icon by command id: the first verb in the table that names the command. */
const VERB_ICONS = new Map<string, SystemIconName>();
for (const verb of VERBS as readonly VerbDef[]) {
  if (
    verb.commandId != null &&
    verb.icon !== null &&
    !VERB_ICONS.has(verb.commandId)
  ) {
    VERB_ICONS.set(verb.commandId, verb.icon);
  }
}
const STAGE_ICONS = new Map(STAGES.map((s) => [`stage.${s.id}`, s.icon]));

function groupOf(id: string): PaletteCommandGroup | undefined {
  return id.startsWith("stage.")
    ? "stages"
    : id.startsWith("help.")
      ? "help"
      : undefined;
}

/**
 * Runnable catalog commands in category order. A palette click runs a command
 * the way a pointer does, so focus-only keyboard gates (timeline or transcript
 * focus) count as met; every other `when` gate gives the row its reason. On
 * Home (`scope: "home"`) only the commands marked `home` in the catalog count.
 */
export function paletteCommands(
  ctx: CommandContext,
  scope?: "home",
): PaletteCommand[] {
  const pointerCtx: CommandContext = {
    ...ctx,
    timelineFocused: true,
    editorFocused: true,
  };
  const rows = listCatalogIds()
    .map((id) => COMMANDS[id])
    // The palette does not list itself.
    .filter(
      (def) =>
        def != null &&
        def.paletteRunnable !== false &&
        def.id !== "ui.toggleCommandPalette" &&
        (scope !== "home" || def.home === true),
    )
    .map((def): PaletteCommand => {
      const keyed = keymapCommandById(def.id);
      const gate = evaluateWhen(def.when, pointerCtx);
      const group = groupOf(def.id);
      const icon = STAGE_ICONS.get(def.id) ?? VERB_ICONS.get(def.id);
      return {
        id: def.id,
        label: def.label,
        category: def.category,
        ...(def.keywords ? { keywords: def.keywords } : {}),
        shortcut: displayShortcutFor(def.id) ?? null,
        ...(keyed ? { defaultKey: keyed.keys[0] } : {}),
        ...(keyed?.collision ? { note: keyed.collision } : {}),
        disabledReason: gate.ok ? null : gate.reason,
        ...(group ? { group } : {}),
        ...(icon ? { icon } : {}),
      };
    });
  return KEYMAP_CATEGORY_ORDER.flatMap((category) =>
    rows.filter((row) => row.category === category),
  );
}

export type PalettePerson = {
  clientId: string;
  name: string;
  role: string;
  following: boolean;
  goTo?: boolean;
};

export type PaletteEntrySources = {
  chapters: readonly ChapterMarker[];
  /** The host's recent projects (`/api/projects/recent`); empty for guests. */
  projects: readonly RecentProject[];
  /** Live remote clients in the session. */
  people: readonly PalettePerson[];
  /** The open project, left out of Projects. */
  projectPath: string;
};

/**
 * Projects, People and Chapters rows. Each runs a registry command, and one
 * whose command is gated off for this role (Open project for a guest link) is
 * left out rather than shown disabled.
 */
export function paletteEntries(
  ctx: CommandContext,
  src: PaletteEntrySources,
): PaletteEntry[] {
  const allowed = (commandId: string) => {
    const def = COMMANDS[commandId];
    return def != null && evaluateWhen(def.when, ctx).ok;
  };
  const out: PaletteEntry[] = [];
  if (allowed("project.open")) {
    for (const p of src.projects) {
      if (p.folder_missing || p.path === src.projectPath) {
        continue;
      }
      out.push({
        id: `project:${p.path}`,
        group: "projects",
        label: p.name,
        context: p.chip.text,
        verb: "Open",
        commandId: "project.open",
        args: { path: p.path },
      });
    }
  }
  if (allowed("presence.follow")) {
    for (const person of src.people) {
      out.push({
        id: `person:${person.clientId}`,
        group: "people",
        label: person.name,
        context: person.following ? `${person.role}, following` : person.role,
        verb: person.following ? "Stop following" : "Follow",
        commandId: "presence.follow",
        args: { clientId: person.clientId },
      });
    }
  }
  if (allowed("presence.goTo")) {
    for (const person of src.people) {
      if (!person.goTo) continue;
      out.push({
        id: `person:goTo:${person.clientId}`,
        group: "people",
        label: person.name,
        context: person.role,
        verb: "Go to",
        commandId: "presence.goTo",
        args: { clientId: person.clientId },
      });
    }
  }
  if (allowed("transport.seek")) {
    const seen = new Map<string, number>();
    [...src.chapters]
      .sort((a, b) => a.time - b.time)
      .forEach((c) => {
        // The nth chapter with the same time and title gets `#n`, so ids stay unique and stable.
        const base = `chapter:${c.time}:${c.title}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        out.push({
          id: n === 0 ? base : `${base}#${n}`,
          group: "chapters",
          label: c.title || "Untitled chapter",
          context: formatTimeShort(c.time),
          verb: "Go to",
          commandId: "transport.seek",
          args: { sec: c.time },
        });
      });
  }
  return out;
}
