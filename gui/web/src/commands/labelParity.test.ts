import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { capabilityLabel } from "../capabilities/copy";
import { paletteCommands } from "../stage/dialogs/commandPaletteRows";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { SRC_ROOT, sourceFiles } from "../test/sourceFiles";
import { COMMANDS, listCatalogIds } from "./catalog";
import { buildCommandContext } from "./context";
import { commandLabel } from "./labels";
import { registerDawCommands } from "./register";

type ManifestCapability = {
  id: string;
  label: string;
  surfaces?: { command?: string };
};

const MANIFEST: ManifestCapability[] = JSON.parse(
  readFileSync(
    join(SRC_ROOT, "../../../contracts/capabilities.manifest.json"),
    "utf-8",
  ),
).capabilities;

const COMMAND_ELEMENT =
  /<(CommandButton|CommandMenuItem)\b((?:[^<>{}]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*?)(\/>|>([^<>{}]*)<\/\1>)/g;

type Literal = { file: string; commandId: string; text: string };

/** String-literal names written on a `CommandButton` or `CommandMenuItem`. */
function writtenNames(): Literal[] {
  const found: Literal[] = [];
  for (const { rel, text } of sourceFiles()) {
    if (/\.(test|stories)\.tsx?$/.test(rel) || !rel.endsWith(".tsx")) {
      continue;
    }
    for (const m of text.matchAll(COMMAND_ELEMENT)) {
      const attrs = m[2] ?? "";
      const commandId = /\bcommandId="([^"]+)"/.exec(attrs)?.[1];
      if (!commandId) {
        continue;
      }
      const child = (m[4] ?? "").replace(/\s+/g, " ").trim();
      if (child) {
        found.push({ file: rel, commandId, text: child });
      }
      const aria = /\baria-label="([^"]+)"/.exec(attrs)?.[1];
      if (aria) {
        found.push({ file: rel, commandId, text: aria });
      }
    }
  }
  return found;
}

describe("one name per command", () => {
  beforeEach(() => {
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("declares each short form and variant once, apart from the label", () => {
    for (const id of listCatalogIds()) {
      const def = COMMANDS[id]!;
      const forms = [def.shortLabel, ...(def.variants ?? [])].filter(
        (n): n is string => n !== undefined,
      );
      expect(forms, id).not.toContain(def.label);
      expect(new Set(forms).size, id).toBe(forms.length);
    }
    expect(commandLabel("range.arm", "short")).toBe("Select range");
    expect(commandLabel("range.arm")).toBe("Select a range");
  });

  it("writes only the label, shortLabel or a declared variant on a button or menu item", () => {
    const offenders = writtenNames()
      .filter(({ commandId, text }) => {
        const def = COMMANDS[commandId];
        if (!def) {
          return true;
        }
        return ![def.label, def.shortLabel, ...(def.variants ?? [])].includes(
          text,
        );
      })
      .map(({ file, commandId, text }) => `${file} ${commandId}: "${text}"`);
    expect(offenders).toEqual([]);
  });

  it("reads each palette row's name from the catalog label", () => {
    const rows = paletteCommands(buildCommandContext());
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) {
      expect(row.label, row.id).toBe(COMMANDS[row.id]!.label);
    }
    expect(rows.find((r) => r.id === "project.new")?.label).toBe(
      "New project…",
    );
  });

  it("reads each manifest capability's name from the catalog label", () => {
    const mismatched = MANIFEST.filter((cap) => {
      const id = cap.surfaces?.command;
      return id && COMMANDS[id] && cap.label !== COMMANDS[id].label;
    }).map((cap) => `${cap.id}: ${cap.label}`);
    expect(mismatched).toEqual([]);
    expect(capabilityLabel("daw.transport.togglePlay")).toBe(
      COMMANDS["transport.togglePlay"]!.label,
    );
  });
});
