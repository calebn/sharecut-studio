import { beforeEach, describe, expect, it } from "vitest";
import { registerDawCommands } from "../commands/register";
import { KEYMAP_CATEGORY_ORDER, KEYMAP_COMMANDS } from "../keymap/registry";
import {
  commandPaletteCategories,
  commandPaletteUnbound,
} from "./commandPaletteRows";

describe("commandPaletteCategories", () => {
  beforeEach(() => {
    registerDawCommands();
  });

  it("comes out in KEYMAP_CATEGORY_ORDER with no empty category", () => {
    const categories = commandPaletteCategories();
    const seen = categories.map((c) => c.category);
    const expectedOrder = KEYMAP_CATEGORY_ORDER.filter((c) => seen.includes(c));
    expect(seen).toEqual(expectedOrder);
    for (const cat of categories) {
      expect(cat.rows.length).toBeGreaterThan(0);
    }
  });

  it("includes tool.select / Select tool / V in the tools category", () => {
    const tools = commandPaletteCategories().find(
      (c) => c.category === "tools",
    );
    expect(tools).toBeTruthy();
    const row = tools?.rows.find((r) => r.id === "tool.select");
    expect(row).toMatchObject({ label: "Select tool", shortcut: "V" });
  });
});

describe("commandPaletteUnbound", () => {
  beforeEach(() => {
    registerDawCommands();
  });

  it("includes view.transcriptAnnotate", () => {
    const unbound = commandPaletteUnbound();
    expect(unbound.some((a) => a.id === "view.transcriptAnnotate")).toBe(true);
  });

  it("excludes keymapped ids", () => {
    const unbound = commandPaletteUnbound();
    for (const cmd of KEYMAP_COMMANDS) {
      expect(unbound.some((a) => a.id === cmd.id)).toBe(false);
    }
  });

  it("excludes ids with paletteRunnable false", () => {
    const unbound = commandPaletteUnbound();
    expect(unbound.some((a) => a.id === "transport.seek")).toBe(false);
  });
});
