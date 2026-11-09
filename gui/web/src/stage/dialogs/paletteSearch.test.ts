import { describe, expect, it } from "vitest";
import { MOBILE_GESTURES } from "../../commands/gestures";
import {
  groupPaletteCommands,
  groupPaletteEntries,
  PALETTE_GESTURES,
  type PaletteCommand,
  type PaletteEntry,
  searchPaletteCommands,
  searchPaletteEntries,
  searchPaletteGestures,
} from "./paletteSearch";

function cmd(
  id: string,
  label: string,
  category: PaletteCommand["category"],
  extra: Partial<PaletteCommand> = {},
): PaletteCommand {
  return {
    id,
    label,
    category,
    shortcut: null,
    disabledReason: null,
    ...extra,
  };
}

const COMMANDS: PaletteCommand[] = [
  cmd("transport.togglePlay", "Play / pause", "transport", {
    shortcut: "Space",
  }),
  cmd("view.fitTracksHeight", "Fit tracks to window height", "view"),
  cmd("export.bounce", "Bounce…", "ui"),
  cmd("export.deliverables", "Export deliverables…", "ui", {
    shortcut: "⌘E",
    keywords: ["mp3", "master"],
  }),
  cmd("help.diagnosticsBundle", "Export diagnostics…", "ui", {
    disabledReason: "Project create/open is host-only",
  }),
  cmd("daw.transcript.findReplace", "Transcript find and replace", "view"),
];

const ids = (rows: PaletteCommand[]) => rows.map((r) => r.id);

describe("searchPaletteCommands", () => {
  it("returns every command for an empty query", () => {
    expect(ids(searchPaletteCommands(COMMANDS, "   "))).toEqual(ids(COMMANDS));
  });

  it("ranks label prefixes first and runnable before unavailable", () => {
    expect(ids(searchPaletteCommands(COMMANDS, "export"))).toEqual([
      "export.deliverables",
      "help.diagnosticsBundle",
    ]);
  });

  it("matches words in any order across label, category and shortcut", () => {
    expect(ids(searchPaletteCommands(COMMANDS, "height fit"))).toEqual([
      "view.fitTracksHeight",
    ]);
    expect(ids(searchPaletteCommands(COMMANDS, "app bounce"))).toEqual([
      "export.bounce",
    ]);
    expect(ids(searchPaletteCommands(COMMANDS, "space"))).toEqual([
      "transport.togglePlay",
    ]);
  });

  it("ranks a label word match above a category match", () => {
    expect(ids(searchPaletteCommands(COMMANDS, "tran"))).toEqual([
      "daw.transcript.findReplace",
      "transport.togglePlay",
    ]);
  });

  it("matches catalog keywords, below label matches", () => {
    expect(ids(searchPaletteCommands(COMMANDS, "mp3"))).toEqual([
      "export.deliverables",
    ]);
    expect(
      ids(
        searchPaletteCommands(
          [cmd("view.master", "Master meter", "view"), ...COMMANDS],
          "master",
        ),
      ),
    ).toEqual(["view.master", "export.deliverables"]);
  });

  it("finds nothing for a word no command has", () => {
    expect(searchPaletteCommands(COMMANDS, "xylophone")).toEqual([]);
  });
});

describe("groupPaletteCommands", () => {
  it("groups consecutive rows by category in the order given", () => {
    expect(
      groupPaletteCommands(COMMANDS).map((g) => [g.category, ids(g.rows)]),
    ).toEqual([
      ["transport", ["transport.togglePlay"]],
      ["view", ["view.fitTracksHeight"]],
      [
        "ui",
        ["export.bounce", "export.deliverables", "help.diagnosticsBundle"],
      ],
      ["view", ["daw.transcript.findReplace"]],
    ]);
  });
});

describe("palette entries", () => {
  const entries: PaletteEntry[] = [
    {
      id: "chapter:0:Intro",
      group: "chapters",
      label: "Intro",
      context: "0:00",
      verb: "Go to",
      commandId: "transport.seek",
      args: { sec: 0 },
    },
    {
      id: "person:a",
      group: "people",
      label: "Ana",
      context: "editor",
      verb: "Follow",
      commandId: "presence.follow",
      args: { clientId: "a" },
    },
    {
      id: "project:/x",
      group: "projects",
      label: "Intro show",
      verb: "Open",
      commandId: "project.open",
      args: { path: "/x" },
    },
  ];

  it("groups in Projects, People, Chapters order and drops empty groups", () => {
    expect(groupPaletteEntries(entries).map((g) => g.group)).toEqual([
      "projects",
      "people",
      "chapters",
    ]);
    expect(groupPaletteEntries([])).toEqual([]);
  });

  it("matches every word in label, context or group name, label prefixes first", () => {
    expect(searchPaletteEntries(entries, "").length).toBe(3);
    expect(
      searchPaletteEntries(entries, "editor ana").map((e) => e.id),
    ).toEqual(["person:a"]);
    expect(searchPaletteEntries(entries, "chapters").map((e) => e.id)).toEqual([
      "chapter:0:Intro",
    ]);
    expect(
      searchPaletteEntries(entries, "show intro").map((e) => e.id),
    ).toEqual(["project:/x"]);
    expect(searchPaletteEntries(entries, "zzz")).toEqual([]);
  });
});

describe("group names in search", () => {
  const stage = {
    ...cmd("stage.edit", "Go to Edit", "navigation"),
    group: "stages",
  } as PaletteCommand;
  const help = {
    ...cmd("help.x", "Export diagnostics…", "ui"),
    group: "help",
  } as PaletteCommand;
  it("matches a grouped command by its group name", () => {
    expect(ids(searchPaletteCommands([stage, help], "stages"))).toEqual([
      "stage.edit",
    ]);
    expect(ids(searchPaletteCommands([stage, help], "help"))).toEqual([
      "help.x",
    ]);
  });
});

describe("PALETTE_GESTURES", () => {
  it("has one row per MOBILE_GESTURES entry, the first being Undo", () => {
    expect(PALETTE_GESTURES).toHaveLength(MOBILE_GESTURES.length);
    expect(PALETTE_GESTURES[0]).toEqual({
      id: "gesture:Two-finger tap",
      gesture: "Two-finger tap",
      action: "Undo",
      description: "Undo the last action. Optional ShareCut shortcut.",
    });
  });
});

describe("searchPaletteGestures", () => {
  const names = (q: string) =>
    searchPaletteGestures(PALETTE_GESTURES, q).map((g) => g.gesture);
  it("returns every gesture for an empty query, the group name or touch", () => {
    expect(names("")).toHaveLength(5);
    expect(names("  ")).toHaveLength(5);
    expect(names("gestures")).toHaveLength(5);
    expect(names("touch")).toHaveLength(5);
  });
  it("finds a gesture by its name or its action", () => {
    expect(names("Pinch")).toEqual(["Pinch"]);
    expect(names("zoom")).toEqual(["Pinch"]);
    expect(names("two-finger tap")).toEqual(["Two-finger tap"]);
  });
  it("rejects a word no gesture or action contains", () => {
    expect(names("blade")).toEqual([]);
    expect(names("pinch blade")).toEqual([]);
  });
});
