/**
 * The manifest `gui` column lists every surface that renders a command, and
 * the manifest gates are the catalog `when` (#1795). A command with a button
 * somewhere the manifest does not name is a surface an agent or the
 * capabilities doc cannot see; a gate that differs from the `when` is a rule
 * only one of the two enforces.
 *
 * The scan reads JSX: a `CommandButton` or `CommandMenuItem` with a literal
 * `commandId`, and a literal `commandLabel("id")` written on a control. A file
 * that renders a command must be declared in `FILE_SURFACES`, which names the
 * manifest `gui` ids the file hosts. A shared control group mounted by more
 * than one parent is declared per mount in `WRAPPER_MOUNTS`, so a surface
 * cannot hide behind a sibling that is listed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT, sourceFiles } from "../test/sourceFiles";
import { COMMANDS } from "./catalog";

type ManifestCapability = {
  id: string;
  gates?: string[];
  surfaces?: { command?: string; gui?: string[] };
};

const MANIFEST: ManifestCapability[] = JSON.parse(
  readFileSync(
    join(SRC_ROOT, "../../../contracts/capabilities.manifest.json"),
    "utf-8",
  ),
).capabilities;

type RenderKind = "CommandButton" | "CommandMenuItem" | "label";

/**
 * Manifest `gui` ids each file hosts. A key may end in `#CommandButton`,
 * `#CommandMenuItem` or `#label` to host different surfaces by element kind
 * (the transport bar held both its menu and its buttons). A command a
 * file renders needs at least one of the file's ids in its `gui` row.
 */
const FILE_SURFACES: Record<string, string[]> = {
  "inspector/views/ClipInspector.tsx": ["clipInspector"],
  "stage/frame/HistoryControls.tsx": ["historyPanel"],
  "inspector/views/TrackInspector.tsx": ["trackInspector"],
  "stage/edit/EditCornerView.tsx": ["editCorner"],
  "stage/edit/PlusMenu.tsx": ["editPlusMenu"],
  "stage/edit/ViewSheet.tsx": ["viewSheet"],
  "tracks/SoloChip.tsx": ["trackHeaders.soloChip"],
  "transcript/TranscriptWordbar.tsx": ["transcript.wordbar"],
  "transcript/WordRangeControls.tsx": ["rangeActions.words"],
};

const RENDERED =
  /<(CommandButton|CommandMenuItem)\b(?:[^<>{}]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*?\bcommandId="([a-zA-Z.]+)"|\bcommandLabel\(\s*"([a-zA-Z.]+)"/g;

type Rendered = { file: string; kind: RenderKind; commandId: string };

function renderedCommands(): Rendered[] {
  const found = new Map<string, Rendered>();
  for (const { rel, text } of sourceFiles()) {
    if (!rel.endsWith(".tsx") || /\.(test|stories)\./.test(rel)) {
      continue;
    }
    for (const m of text.matchAll(RENDERED)) {
      const kind: RenderKind = m[1] ? (m[1] as RenderKind) : "label";
      const commandId = m[2] ?? m[3];
      found.set(`${rel}#${kind}#${commandId}`, { file: rel, kind, commandId });
    }
  }
  return [...found.values()];
}

function guiOf(commandId: string): string[] {
  return (
    MANIFEST.find((cap) => cap.surfaces?.command === commandId)?.surfaces
      ?.gui ?? []
  );
}

function hostsOf(file: string, kind: RenderKind): string[] | undefined {
  return FILE_SURFACES[`${file}#${kind}`] ?? FILE_SURFACES[file];
}

describe("manifest surfaces", () => {
  it("lists every surface that renders a command in its gui row", () => {
    const unmapped = new Set<string>();
    const missing: string[] = [];
    for (const { file, kind, commandId } of renderedCommands()) {
      if (!COMMANDS[commandId]) {
        continue;
      }
      const hosts = hostsOf(file, kind);
      if (!hosts) {
        unmapped.add(`${file}#${kind}`);
        continue;
      }
      const gui = guiOf(commandId);
      if (!hosts.some((id) => gui.includes(id))) {
        missing.push(
          `${commandId} rendered in ${file} (${kind}): gui [${gui.join(", ")}] has none of [${hosts.join(", ")}]`,
        );
      }
    }
    expect([...unmapped]).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("declares only surfaces the manifest knows", () => {
    const known = new Set(MANIFEST.flatMap((cap) => cap.surfaces?.gui ?? []));
    const files = new Set(
      [...sourceFiles()].map(({ rel }) => rel).filter((rel) => rel),
    );
    const stale: string[] = [];
    for (const [key, ids] of Object.entries(FILE_SURFACES)) {
      if (!files.has(key.split("#")[0])) {
        stale.push(key);
      }
      stale.push(
        ...ids.filter((id) => !known.has(id)).map((id) => `${key} ${id}`),
      );
    }
    expect(stale).toEqual([]);
  });

  it("gates each manifest row on exactly the catalog when", () => {
    const drift: string[] = [];
    for (const cap of MANIFEST) {
      const commandId = cap.surfaces?.command;
      const def = commandId ? COMMANDS[commandId] : undefined;
      if (!def) {
        continue;
      }
      if (JSON.stringify(cap.gates ?? []) !== JSON.stringify([def.when])) {
        drift.push(
          `${def.id}: when=${def.when} gates=${(cap.gates ?? []).join(",")}`,
        );
      }
    }
    expect(drift).toEqual([]);
  });
});
