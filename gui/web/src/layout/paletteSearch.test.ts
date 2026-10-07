import { describe, expect, it } from "vitest";
import {
  groupPaletteCommands,
  type PaletteCommand,
  searchPaletteCommands,
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
  cmd("export.bounce", "Bounce…", "ui", { shortcut: "⌘+Shift+B" }),
  cmd("export.deliverables", "Export deliverables…", "ui", {
    shortcut: "⌘+Shift+E",
  }),
  cmd("help.diagnosticsBundle", "Export diagnostics…", "ui", {
    disabledReason: "Project create/open is host-only",
  }),
  cmd("view.transcriptAnnotate", "Annotate transcript", "view"),
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
      "view.transcriptAnnotate",
      "transport.togglePlay",
    ]);
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
      ["view", ["view.transcriptAnnotate"]],
    ]);
  });
});
