import { beforeEach, describe, expect, it } from "vitest";
import type { RecentProject } from "../../api";
import { COMMANDS, listCatalogIds } from "../../commands/catalog";
import { buildCommandContext } from "../../commands/context";
import { registerDawCommands } from "../../commands/register";
import { keymapCommandById } from "../../keymap/registry";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import paletteStoryMeta from "./CommandPaletteView.stories";
import { paletteCommands, paletteEntries } from "./commandPaletteRows";
import { searchPaletteCommands } from "./paletteSearch";

const rowsNow = () => paletteCommands(buildCommandContext());

describe("paletteCommands on Home", () => {
  beforeEach(() => {
    registerDawCommands();
    useDawStore.setState({ project: null, projectPath: "" });
  });

  it("lists only the catalog commands marked for Home, all runnable with no project", () => {
    const rows = paletteCommands(buildCommandContext(), "home");
    expect(rows.map((r) => r.id).sort()).toEqual(
      [
        "help.diagnosticsBundle",
        "help.guides",
        "mcp.connect",
        "models.open",
        "project.open",
        "settings.open",
      ].sort(),
    );
    expect(rows.filter((r) => r.disabledReason != null)).toEqual([]);
    expect(rows.filter((r) => r.group === "help").map((r) => r.id)).toEqual([
      "help.diagnosticsBundle",
      "help.guides",
    ]);
  });
});

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

  it("lists J and L with honest labels, found by search and keyed apart", () => {
    const rows = rowsNow();
    expect(rows.find((r) => r.id === "transport.shuttleBack")).toMatchObject({
      label: "Jump back",
      shortcut: expect.stringMatching(/J$/),
      defaultKey: "J",
      disabledReason: null,
    });
    expect(rows.find((r) => r.id === "transport.shuttleForward")).toMatchObject(
      {
        label: "Speed up (1×/2×/4×)",
        shortcut: expect.stringMatching(/L$/),
        defaultKey: "L",
        disabledReason: null,
      },
    );
    expect(searchPaletteCommands(rows, "shuttle").map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "transport.shuttleBack",
        "transport.shuttleForward",
      ]),
    );
  });

  it("carries the keymap shortcut, default key and collision note", () => {
    const blade = rowsNow().find((r) => r.id === "edit.bladeCut");
    expect(blade).toMatchObject({
      label: "Split at playhead",
      category: "edit",
      shortcut: expect.stringMatching(/K$/),
      defaultKey: keymapCommandById("edit.bladeCut")?.keys[0],
      note: keymapCommandById("edit.bladeCut")?.collision,
    });
    const showCut = rowsNow().find((r) => r.id === "view.showCutAway");
    expect(showCut?.shortcut).toBeNull();
    expect(showCut?.defaultKey).toBeUndefined();
  });

  it.each([
    ["mp3", "export.deliverables"],
    ["wav", "export.deliverables"],
    ["loudness", "export.deliverables"],
    ["razor", "edit.bladeCut"],
    ["invite", "share.manage"],
  ])("finds what people call it: %s → %s", (query, id) => {
    expect(searchPaletteCommands(rowsNow(), query).map((r) => r.id)).toContain(
      id,
    );
  });

  it("treats focus-only gates as met, as a pointer click does", () => {
    useDawStore.setState({ timelineFocused: false, stage: "review" });
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

  it("puts the five stage commands and the hand-off in Stages, with the stage icons, and help.* in Help", () => {
    const rows = rowsNow();
    const stages = rows.filter((r) => r.group === "stages");
    expect(stages.map((r) => r.id).sort()).toEqual(
      ["deliver", "edit", "handoff", "prepare", "record", "review"].map(
        (id) => `stage.${id}`,
      ),
    );
    expect(stages.filter((r) => r.icon === undefined).map((r) => r.id)).toEqual(
      ["stage.handoff"],
    );
    expect(stages.find((r) => r.id === "stage.record")?.icon).toBe("record");
    expect(rows.filter((r) => r.group === "help").map((r) => r.id)).toEqual([
      "help.diagnosticsBundle",
      "help.guides",
    ]);
    expect(rows.find((r) => r.id === "edit.bladeCut")?.group).toBeUndefined();
  });

  it("gives verb-table commands their verb icon and leaves others without", () => {
    const rows = new Map(rowsNow().map((r) => [r.id, r]));
    expect(rows.get("transport.togglePlay")?.icon).toBe("play");
    expect(rows.get("view.showCutAway")?.icon).toBeUndefined();
  });

  it("keeps the stage gates: a guest link gets the reason on stages it cannot enter", () => {
    useDawStore
      .getState()
      .hydrate(shareProjectKey("tok"), minimalProject(), "view", ["play"]);
    const rows = new Map(rowsNow().map((r) => [r.id, r]));
    expect(rows.get("stage.deliver")?.disabledReason).toBe(
      "Not available on this link",
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

describe("paletteEntries", () => {
  const recentProject = (path: string, extra: Partial<RecentProject> = {}) =>
    ({
      path,
      name: path.split("/").at(-1) ?? path,
      opened_at: "",
      edited_at: null,
      duration_sec: null,
      stage: "edit",
      chip: { text: "Ready", state: "ready" },
      peaks: [],
      folder_missing: false,
      ...extra,
    }) satisfies RecentProject;
  const sources = {
    chapters: [
      { time: 90, title: "Outro" },
      { time: 5, title: "Intro" },
    ],
    projects: [
      recentProject("/p/a"),
      recentProject("/p/b", { folder_missing: true }),
      recentProject("/tmp/p.json"),
    ],
    people: [{ clientId: "c1", name: "Ana", role: "editor", following: true }],
    projectPath: "/tmp/p.json",
  };

  beforeEach(() => {
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("builds chapters by time, people and other projects, each on a registry command", () => {
    const entries = paletteEntries(buildCommandContext(), sources);
    expect(entries.map((e) => [e.group, e.label, e.commandId, e.args])).toEqual(
      [
        ["projects", "a", "project.open", { path: "/p/a" }],
        ["people", "Ana", "presence.follow", { clientId: "c1" }],
        ["chapters", "Intro", "transport.seek", { sec: 5 }],
        ["chapters", "Outro", "transport.seek", { sec: 90 }],
      ],
    );
    expect(entries.find((e) => e.group === "people")?.verb).toBe(
      "Stop following",
    );
    for (const e of entries) {
      expect(COMMANDS[e.commandId], e.id).toBeDefined();
    }
  });

  it("gives chapters that share a time and title distinct, stable ids", () => {
    const build = () =>
      paletteEntries(buildCommandContext(), {
        ...sources,
        chapters: [
          { time: 5, title: "" },
          { time: 5, title: "" },
          { time: 5, title: "Intro" },
        ],
      })
        .filter((e) => e.group === "chapters")
        .map((e) => e.id);
    const ids = build();
    expect(new Set(ids).size).toBe(3);
    expect(build()).toEqual(ids);
  });

  it("leaves Projects out on a guest link but keeps chapters and people", () => {
    useDawStore
      .getState()
      .hydrate(shareProjectKey("tok"), minimalProject(), "view", ["play"]);
    const groups = new Set(
      paletteEntries(buildCommandContext(), sources).map((e) => e.group),
    );
    expect([...groups].sort()).toEqual(["chapters", "people"]);
  });

  it("returns nothing for an empty project with no people", () => {
    expect(
      paletteEntries(buildCommandContext(), {
        ...sources,
        chapters: [],
        projects: [],
        people: [],
      }),
    ).toEqual([]);
  });
});
