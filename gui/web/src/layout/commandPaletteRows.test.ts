import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, listCatalogIds } from "../commands/catalog";
import { buildCommandContext } from "../commands/context";
import { registerDawCommands } from "../commands/register";
import { keymapCommandById } from "../keymap/registry";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import paletteStoryMeta from "./CommandPaletteView.stories";
import { paletteCommands } from "./commandPaletteRows";

const rowsNow = () => paletteCommands(buildCommandContext());

describe("paletteCommands", () => {
  beforeEach(() => {
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("lists every runnable catalog command once, keyed or not", () => {
    const expected = listCatalogIds().filter(
      (id) =>
        COMMANDS[id]?.paletteRunnable !== false &&
        id !== "ui.toggleCommandPalette",
    );
    expect(
      rowsNow()
        .map((r) => r.id)
        .sort(),
    ).toEqual([...expected].sort());
  });

  it("carries the keymap shortcut, default key and collision note", () => {
    const blade = rowsNow().find((r) => r.id === "tool.blade");
    expect(blade).toMatchObject({
      label: "Blade tool",
      category: "tools",
      shortcut: "C",
      defaultKey: keymapCommandById("tool.blade")?.keys[0],
      note: keymapCommandById("tool.blade")?.collision,
    });
    const annotate = rowsNow().find((r) => r.id === "view.transcriptAnnotate");
    expect(annotate?.shortcut).toBeNull();
    expect(annotate?.defaultKey).toBeUndefined();
  });

  it("treats focus-only gates as met, as a pointer click does", () => {
    useDawStore.setState({ timelineFocused: false, activeTab: "comments" });
    const play = rowsNow().find((r) => r.id === "transport.togglePlay");
    expect(play?.disabledReason).toBeNull();
  });

  it("gives host-only commands their reason on a review link", () => {
    useDawStore
      .getState()
      .hydrate(shareProjectKey("tok"), minimalProject(), "view", ["play"]);
    const exportRow = rowsNow().find((r) => r.id === "export.deliverables");
    expect(exportRow?.disabledReason).toBe(
      "Host-only (not available on review links)",
    );
  });

  it("keeps the story fixture in step with the catalog and keymap", () => {
    const live = new Map(rowsNow().map((r) => [r.id, r]));
    for (const row of paletteStoryMeta.args?.commands ?? []) {
      const actual = live.get(row.id);
      expect(actual, row.id).toBeDefined();
      expect({
        label: row.label,
        category: row.category,
        defaultKey: row.defaultKey,
      }).toEqual({
        label: actual?.label,
        category: actual?.category,
        defaultKey: actual?.defaultKey,
      });
    }
  });
});
