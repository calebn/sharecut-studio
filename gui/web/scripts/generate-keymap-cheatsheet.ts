#!/usr/bin/env node
/**
 * Generate Sharecut Studio shortcut cheatsheets from KEYMAP_COMMANDS + COMMANDS.
 *
 * Writes:
 *   docs/daw-shortcuts.md          — engineer README
 *   ux/pages/shortcuts.md          — UX site (Copy Markdown → Google Docs)
 *
 * Usage (from repo root):
 *   make cheatsheet
 *   make cheatsheet-check
 *
 * Implementation: ``cd gui/web && npx vite-node scripts/generate-keymap-cheatsheet.ts``
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, listCatalogIds } from "../src/commands/catalog";
import {
  formatShortcutKeys,
  KEYMAP_COMMANDS,
  type KeymapCategory,
  type KeymapCommand,
} from "../src/keymap/registry";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const CATEGORY_ORDER: KeymapCategory[] = [
  "transport",
  "tools",
  "focus",
  "navigation",
  "review",
  "history",
  "edit",
  "view",
  "ui",
  "presence",
];

const WHEN_HINTS: Record<string, string> = {
  always: "Always (when not typing in an input)",
  layoutFocused: "Timeline or transcript focused",
  timelineFocused: "Timeline focused",
  commentMode: "Comment mode on",
  canSuggestStructural: "Structural edits allowed",
  timelineAndStructural: "Timeline focused + structural edits allowed",
  hasProject: "Project loaded",
  canApplyPass12: "Host or shared edit mode",
  canRefreshMix: "Refresh mix allowed",
  canIngestMedia: "Media ingest allowed",
  canManageProjects: "Host project management",
  hostProjectLoaded: "Loaded host project",
  following: "While following another client",
};

const MARKER_START = "<!-- keymap-cheatsheet:generated -->";
const MARKER_END = "<!-- /keymap-cheatsheet:generated -->";

function defaultShortcut(cmd: KeymapCommand): string {
  // Ignore localStorage remaps for published docs.
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

function byCategory(cmds: readonly KeymapCommand[]) {
  const out: Record<string, KeymapCommand[]> = {};
  for (const cat of CATEGORY_ORDER) {
    out[cat] = [];
  }
  for (const cmd of cmds) {
    (out[cmd.category] ??= []).push(cmd);
  }
  return out;
}

function generatedBody(linkStyle: "docs" | "ux"): string {
  const keymapHref =
    linkStyle === "docs"
      ? "[`gui/web/src/keymap/registry.ts`](../gui/web/src/keymap/registry.ts)"
      : "[`gui/web/src/keymap/registry.ts`](https://github.com/calebn/sharecut-studio/blob/main/gui/web/src/keymap/registry.ts)";
  const catalogHref =
    linkStyle === "docs"
      ? "[`gui/web/src/commands/catalog.ts`](../gui/web/src/commands/catalog.ts)"
      : "[`gui/web/src/commands/catalog.ts`](https://github.com/calebn/sharecut-studio/blob/main/gui/web/src/commands/catalog.ts)";

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `> **Auto-generated** from ${keymapHref} and ${catalogHref}. Do not edit by hand — run \`make cheatsheet\`.`,
  );
  lines.push("");
  lines.push(
    "Shortcuts dispatch through the Sharecut Studio command bus (`execute(id)`). Character keys (letters, digits, Space) are scoped by context (WCAG 2.1.4). **Mod** = ⌘ on macOS / Ctrl elsewhere.",
  );
  lines.push("");
  lines.push(
    "Open the in-app cheatsheet with **?** while Sharecut Studio is focused.",
  );
  lines.push("");

  const grouped = byCategory(KEYMAP_COMMANDS);
  for (const cat of CATEGORY_ORDER) {
    const rows = grouped[cat] ?? [];
    if (!rows.length) {
      continue;
    }
    lines.push(`## ${cat}`);
    lines.push("");
    lines.push("| Shortcut | Command | When | Notes |");
    lines.push("|----------|---------|------|-------|");
    for (const cmd of rows) {
      const shortcut = defaultShortcut(cmd);
      const when = WHEN_HINTS[cmd.when] ?? cmd.when;
      const notes = (cmd.notes ?? "").replace(/\|/g, "\\|");
      lines.push(
        `| \`${shortcut}\` | ${cmd.label} (\`${cmd.id}\`) | ${when} | ${notes} |`,
      );
    }
    lines.push("");
  }

  const bound = new Set(KEYMAP_COMMANDS.map((c) => c.id));
  const unbound = listCatalogIds().filter((id) => !bound.has(id));
  if (unbound.length) {
    lines.push("## Commands without default keys");
    lines.push("");
    lines.push(
      "Available via toolbar / `execute` (and the in-app palette). Agents use session/document APIs — not these ids.",
    );
    lines.push("");
    lines.push("| Command | Id | When | Notes |");
    lines.push("|---------|----|------|-------|");
    for (const id of unbound) {
      const def = COMMANDS[id];
      if (!def) {
        continue;
      }
      const when = WHEN_HINTS[def.when] ?? def.when;
      const notes = (def.notes ?? "").replace(/\|/g, "\\|");
      lines.push(`| ${def.label} | \`${id}\` | ${when} | ${notes} |`);
    }
    lines.push("");
  }

  lines.push("## Governance");
  lines.push("");
  lines.push(
    "- New shortcuts: add a `KEYMAP_COMMANDS` row + `commands/` handler; call `execute` from buttons.",
  );
  lines.push(
    "- Never add a second window `keydown` listener — see `gui/web/src/commands/governance.test.ts`.",
  );
  lines.push(
    "- Regenerate this page: `make cheatsheet`. CI/pre-commit: `make cheatsheet-check`.",
  );
  lines.push("");

  return lines.join("\n");
}

function wrapEngineerDoc(body: string): string {
  return [
    "# Sharecut Studio keyboard shortcuts",
    "",
    "Engineer reference for Sharecut Studio shortcuts and the command bus.",
    "",
    "Partner-facing copy (UX site / Google Docs): [ux/pages/shortcuts.md](../ux/pages/shortcuts.md) — live at [ux.sharecut.studio/#/shortcuts](https://ux.sharecut.studio/#/shortcuts) (**Copy Markdown** → paste into Google Docs).",
    "",
    "Full host surface matrix (command / MCP / CLI / skill): [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities).",
    "",
    MARKER_START,
    body.trimEnd(),
    MARKER_END,
    "",
  ].join("\n");
}

function wrapUxPage(body: string): string {
  return [
    "# Keyboard shortcuts",
    "",
    "Sharecut Studio shortcut reference for hosts and UX partners.",
    "",
    "> **Google Docs:** use **Copy Markdown** on this UX site, then paste into Docs. Keep this page as the source of truth — it regenerates from the product keymap.",
    "",
    "Live product cheatsheet: press **?** in Sharecut Studio.",
    "",
    "Host capability matrix (GUI / MCP / CLI / skills): [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities).",
    "",
    MARKER_START,
    body.trimEnd(),
    MARKER_END,
    "",
    "## Related",
    "",
    "- [Screen inventory](#/screens)",
    "- Capabilities catalog: [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities)",
    "- Engineer doc: [docs/daw-shortcuts.md](https://github.com/calebn/sharecut-studio/blob/main/docs/daw-shortcuts.md)",
    "- Command bus: [docs/daw-editing.md](https://github.com/calebn/sharecut-studio/blob/main/docs/daw-editing.md)",
    "",
  ].join("\n");
}

function extractGenerated(full: string): string | null {
  const start = full.indexOf(MARKER_START);
  const end = full.indexOf(MARKER_END);
  if (start < 0 || end < 0 || end < start) {
    return null;
  }
  return full.slice(start + MARKER_START.length, end).trim();
}

function writeOrCheck(path: string, content: string, check: boolean): boolean {
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = "";
  }
  if (check) {
    if (existing !== content) {
      console.error(`cheatsheet out of date: ${path}`);
      console.error("Run: make cheatsheet");
      return false;
    }
    return true;
  }
  writeFileSync(path, content, "utf8");
  console.log(`wrote ${path}`);
  return true;
}

const check = process.argv.includes("--check");
// Touch formatShortcutKeys so import graph stays honest under vite-node.
void formatShortcutKeys;

const docsPath = join(REPO_ROOT, "docs/daw-shortcuts.md");
const uxPath = join(REPO_ROOT, "ux/pages/shortcuts.md");

const okDocs = writeOrCheck(
  docsPath,
  wrapEngineerDoc(generatedBody("docs")),
  check,
);
const okUx = writeOrCheck(uxPath, wrapUxPage(generatedBody("ux")), check);

// Sanity: generated markers present and keymap non-empty
if (KEYMAP_COMMANDS.length < 1) {
  console.error("KEYMAP_COMMANDS is empty");
  process.exit(1);
}
if (check && okDocs && okUx) {
  const gen = extractGenerated(readFileSync(docsPath, "utf8"));
  if (!gen?.includes("transport.togglePlay")) {
    console.error("generated section missing expected command id");
    process.exit(1);
  }
  const bound = new Set(KEYMAP_COMMANDS.map((c) => c.id));
  for (const c of KEYMAP_COMMANDS) {
    if (!gen.includes(c.id)) {
      console.error(`docs generated body missing keymap id ${c.id}`);
      process.exit(1);
    }
  }
  for (const id of listCatalogIds()) {
    if (bound.has(id)) continue;
    if (!gen.includes(id)) {
      console.error(`docs generated body missing unbound id ${id}`);
      process.exit(1);
    }
  }
  console.log("cheatsheet up to date");
}

process.exit(okDocs && okUx ? 0 : 1);
