import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { waitForDialogFocus } from "../../test/dialogFocus";
import { CommandPaletteView } from "./CommandPaletteView";
import {
  PALETTE_GESTURES,
  type PaletteCommand,
  type PaletteEntry,
} from "./paletteSearch";

const COMMANDS: PaletteCommand[] = [
  {
    id: "transport.togglePlay",
    label: "Play / pause",
    category: "transport",
    shortcut: "Space",
    defaultKey: " ",
    disabledReason: null,
  },
  {
    id: "edit.bladeCut",
    label: "Blade cut",
    category: "edit",
    shortcut: "Mod+K",
    defaultKey: "K",
    note: "Mod+K cuts; K alone pauses and returns",
    disabledReason: null,
  },
  {
    id: "export.deliverables",
    label: "Export deliverables…",
    category: "ui",
    shortcut: "⌘E",
    defaultKey: "E",
    disabledReason: null,
  },
  {
    id: "help.diagnosticsBundle",
    label: "Export diagnostics…",
    category: "ui",
    shortcut: null,
    disabledReason: "Project create/open is host-only",
  },
];

const groupNames = () =>
  screen
    .queryAllByRole("group")
    .map(
      (g) =>
        document.getElementById(g.getAttribute("aria-labelledby") ?? "")
          ?.textContent,
    );

const HELP_COMMAND: PaletteCommand = {
  id: "help.diagnosticsBundle",
  label: "Export diagnostics…",
  category: "ui",
  shortcut: null,
  group: "help",
  disabledReason: null,
};

const ENTRIES: PaletteEntry[] = [
  {
    id: "project:/p/Show",
    group: "projects",
    label: "Season Finale",
    context: "Ready",
    verb: "Open",
    commandId: "project.open",
    args: { path: "/p/Show" },
  },
  {
    id: "person:c1",
    group: "people",
    label: "Ana",
    context: "editor",
    verb: "Follow",
    commandId: "presence.follow",
    args: { clientId: "c1" },
  },
  {
    id: "chapter:62:Intro",
    group: "chapters",
    label: "Intro",
    context: "1:02",
    verb: "Go to",
    commandId: "transport.seek",
    args: { sec: 62 },
  },
];

function renderPalette(
  overrides: Partial<Parameters<typeof CommandPaletteView>[0]> = {},
) {
  const props = {
    open: true,
    commands: COMMANDS,
    onClose: vi.fn(),
    onRun: vi.fn(),
    onRemap: vi.fn(),
    ...overrides,
  };
  return { ...render(<CommandPaletteView {...props} />), props };
}

describe("CommandPaletteView", () => {
  it("keeps one section per run when a category repeats, across query changes", async () => {
    const user = userEvent.setup();
    const cmd = (
      id: string,
      label: string,
      category: PaletteCommand["category"],
    ): PaletteCommand => ({
      id,
      label,
      category,
      shortcut: null,
      disabledReason: null,
    });
    renderPalette({
      commands: [
        cmd("a", "Alpha", "transport"),
        cmd("b", "Bravo", "view"),
        cmd("c", "Charlie", "edit"),
        cmd("d", "Delta", "view"),
      ],
      entries: ENTRIES,
    });
    const labels = () =>
      screen
        .getAllByRole("group")
        .map(
          (g) =>
            document.getElementById(g.getAttribute("aria-labelledby") ?? "")
              ?.textContent,
        );
    expect(labels()).toEqual([
      "Transport",
      "View",
      "Edit",
      "View",
      "Projects",
      "People",
      "Chapters",
    ]);
    const search = screen.getByRole("combobox");
    await user.type(search, "alp");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    await user.clear(search);
    expect(labels()).toHaveLength(7);
    expect(screen.getAllByRole("option")).toHaveLength(7);
    const ids = screen.getAllByRole("option").map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders nothing when closed", () => {
    renderPalette({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("groups commands under readable category names and passes axe", async () => {
    const { baseElement } = renderPalette();
    const dialog = screen.getByRole("dialog", {
      name: "Commands and shortcuts",
    });
    const listbox = within(dialog).getByRole("listbox", { name: "Commands" });
    expect(
      within(listbox)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-labelledby"))
        .map((id) => document.getElementById(id ?? "")?.textContent),
    ).toEqual(["Transport", "Edit", "App"]);
    expect(
      within(listbox).getByRole("option", { name: "Play / pause Space" }),
    ).not.toHaveAttribute("aria-disabled");
    await expectNoA11yViolations(baseElement);
  });

  it("focuses Search on open", async () => {
    renderPalette();
    await waitForDialogFocus();
    expect(
      screen.getByRole("combobox", { name: "Search commands" }),
    ).toHaveFocus();
  });

  it("includes the visible palette label with searched category and shortcut, and runs the top match", async () => {
    const user = userEvent.setup();
    const { props, baseElement } = renderPalette();
    await waitForDialogFocus();
    const search = screen.getByRole("combobox", { name: "Search commands" });
    await user.type(search, "export");
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 commands. Enter runs Export deliverables…. Tab remaps",
    );
    const top = screen.getByRole("option", { name: /^Export deliverables…/ });
    expect(top).toHaveAccessibleName("Export deliverables… App ⌘E");
    expect(top).toHaveTextContent(/^Export deliverables… App ⌘E$/);
    const unavailable = screen.getByRole("option", {
      name: /^Export diagnostics…/,
    });
    expect(unavailable).toHaveAccessibleName(
      "Export diagnostics… App Project create/open is host-only",
    );
    expect(unavailable).toHaveTextContent(
      /^Export diagnostics… App Project create\/open is host-only$/,
    );
    expect(top).toHaveAttribute("aria-selected", "true");
    expect(search).toHaveAttribute("aria-activedescendant", top.id);
    await expectNoA11yViolations(baseElement);
    await user.keyboard("{Enter}");
    expect(props.onRun).toHaveBeenCalledExactlyOnceWith("export.deliverables");
  });

  it("finds a command by a catalog keyword", async () => {
    const user = userEvent.setup();
    renderPalette({
      commands: COMMANDS.map((c) =>
        c.id === "export.deliverables" ? { ...c, keywords: ["mp3"] } : c,
      ),
    });
    await waitForDialogFocus();
    await user.type(
      screen.getByRole("combobox", { name: "Search commands" }),
      "mp3",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 command. Enter runs Export deliverables…. Tab remaps",
    );
  });

  it("includes the visible palette label with a disabled reason and prevents running it", () => {
    const { props } = renderPalette();
    const row = screen.getByRole("option", {
      name: "Export diagnostics… Project create/open is host-only",
    });
    expect(row).toHaveAccessibleName(
      "Export diagnostics… Project create/open is host-only",
    );
    expect(row).toHaveTextContent(
      /^Export diagnostics… Project create\/open is host-only$/,
    );
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAccessibleDescription("");
    row.click();
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("runs a command on click without taking focus from Search", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await waitForDialogFocus();
    await user.click(
      screen.getByRole("option", {
        name: "Blade cut Mod+K Mod+K cuts; K alone pauses and returns",
      }),
    );
    expect(props.onRun).toHaveBeenCalledExactlyOnceWith("edit.bladeCut");
    expect(
      screen.getByRole("combobox", { name: "Search commands" }),
    ).toHaveFocus();
  });

  it("steps through every match with the arrows, unavailable ones included", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await waitForDialogFocus();
    const search = screen.getByRole("combobox", { name: "Search commands" });
    const activeName = () =>
      document
        .getElementById(search.getAttribute("aria-activedescendant") ?? "")
        ?.querySelector(".command-palette-label")?.firstChild?.textContent;
    await user.type(search, "e");
    expect(activeName()).toBe("Export deliverables…");
    await user.keyboard("{ArrowDown}");
    expect(activeName()).toBe("Export diagnostics…");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Export diagnostics… is unavailable: Project create/open is host-only",
    );
    await user.keyboard("{Enter}");
    expect(props.onRun).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
    expect(activeName()).toBe("Play / pause");
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(activeName()).toBe("Export deliverables…");
    expect(search).toHaveFocus();
  });

  it("runs nothing on Enter while browsing until a command is picked", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await waitForDialogFocus();
    const search = screen.getByRole("combobox", { name: "Search commands" });
    expect(search).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Enter}");
    expect(props.onRun).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Enter runs Play / pause. Tab remaps",
    );
    await user.keyboard("{Enter}");
    expect(props.onRun).toHaveBeenCalledExactlyOnceWith("transport.togglePlay");
  });

  it("offers Clear search when nothing matches", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    const search = screen.getByRole("combobox", { name: "Search commands" });
    await user.type(search, "xylophone");
    expect(
      screen.getByText("No commands match “xylophone”."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(
      screen.getByRole("option", { name: "Play / pause Space" }),
    ).toBeTruthy();
  });

  it("includes the visible palette label with its shortcut and collision note", () => {
    renderPalette();
    const row = screen.getByRole("option", {
      name: "Blade cut Mod+K Mod+K cuts; K alone pauses and returns",
    });
    expect(row).toHaveAccessibleName(
      "Blade cut Mod+K Mod+K cuts; K alone pauses and returns",
    );
    expect(row).toHaveTextContent(
      /^Blade cut Mod\+K Mod\+K cuts; K alone pauses and returns$/,
    );
    expect(row).toHaveAccessibleDescription("");
  });

  it("opens with Search first and no help sentence, remap checkbox or Gestures button", async () => {
    renderPalette();
    await waitForDialogFocus();
    expect(screen.queryByText(/anytime/)).toBeNull();
    expect(screen.queryByLabelText("Show remaps")).toBeNull();
    expect(screen.queryByRole("button", { name: "Gestures" })).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Search commands" }),
    ).toHaveFocus();
  });

  it("hands Escape to the owner", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await waitForDialogFocus();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  describe("Tab remap", () => {
    async function openBladeField() {
      const user = userEvent.setup();
      const view = renderPalette();
      await waitForDialogFocus();
      const search = screen.getByRole("combobox", { name: "Search commands" });
      await user.type(search, "blade");
      await user.keyboard("{Tab}");
      return { user, search, ...view };
    }

    it("opens the key field in the row and saves the trimmed key on Enter", async () => {
      const { user, search, props } = await openBladeField();
      expect(screen.getByLabelText("Remap Blade cut")).toHaveFocus();
      expect(search).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      await user.keyboard(" B {Enter}");
      expect(props.onRemap).toHaveBeenCalledTimes(1);
      expect(props.onRemap).toHaveBeenCalledWith("edit.bladeCut", "B");
      expect(screen.queryByLabelText("Remap Blade cut")).toBeNull();
      expect(search).toHaveFocus();
      expect(search).toHaveAttribute(
        "aria-activedescendant",
        screen.getByRole("option", { name: /^Blade cut/ }).id,
      );
    });

    it("keeps the palette open and saves nothing on Escape", async () => {
      const { user, search, props } = await openBladeField();
      await user.keyboard("B{Escape}");
      expect(props.onRemap).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Remap Blade cut")).toBeNull();
      expect(search).toHaveFocus();
    });

    it("saves nothing when Tab or Enter leaves an untouched field, and restores the default from a cleared one", async () => {
      const { user, search, props } = await openBladeField();
      await user.keyboard("{Tab}");
      expect(props.onRemap).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Remap Blade cut")).toBeNull();
      await user.keyboard("{Tab}");
      await user.keyboard("{Enter}");
      expect(props.onRemap).not.toHaveBeenCalled();
      expect(search).toHaveFocus();
      await user.keyboard("{Tab}");
      await user.keyboard("B{Backspace}{Enter}");
      expect(props.onRemap).toHaveBeenCalledTimes(1);
      expect(props.onRemap).toHaveBeenCalledWith("edit.bladeCut", "");
    });

    it("opens the field in the row Tab was pressed on when the command is also in Recent", async () => {
      const user = userEvent.setup();
      renderPalette({ recent: ["edit.bladeCut"] });
      await waitForDialogFocus();
      const search = screen.getByRole("combobox");
      const edit = within(screen.getByRole("group", { name: "Edit" }));
      const inCategory = edit.getByRole("option", { name: /^Blade cut/ });
      for (
        let i = 0;
        i < 6 && search.getAttribute("aria-activedescendant") !== inCategory.id;
        i++
      ) {
        await user.keyboard("{ArrowDown}");
      }
      expect(search).toHaveAttribute("aria-activedescendant", inCategory.id);
      await user.keyboard("{Tab}");
      const field = screen.getByLabelText("Remap Blade cut");
      expect(field.closest('[role="group"]')).toHaveAccessibleName("Edit");
      expect(
        within(screen.getByRole("group", { name: "Recent" })).queryByLabelText(
          "Remap Blade cut",
        ),
      ).toBeNull();
    });

    it("does not pull focus back to Search when a click elsewhere blurs the field", async () => {
      const { user, search, props } = await openBladeField();
      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(props.onRemap).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Remap Blade cut")).toBeNull();
      expect(search).not.toHaveFocus();
    });

    it("does not open a field on an unavailable command", async () => {
      const user = userEvent.setup();
      renderPalette({
        commands: [{ ...COMMANDS[1], disabledReason: "Needs a selection" }],
      });
      await waitForDialogFocus();
      await user.keyboard("{ArrowDown}{Tab}");
      expect(screen.queryByLabelText("Remap Blade cut")).toBeNull();
    });

    it("commits a typed key when Tab leaves the field", async () => {
      const { user, props } = await openBladeField();
      await user.keyboard("B{Tab}");
      expect(props.onRemap).toHaveBeenCalledTimes(1);
      expect(props.onRemap).toHaveBeenCalledWith("edit.bladeCut", "B");
    });

    it("does not open a field on an unkeyed command or an entry", async () => {
      const user = userEvent.setup();
      renderPalette({ entries: ENTRIES });
      await waitForDialogFocus();
      const search = screen.getByRole("combobox", { name: "Search commands" });
      await user.type(search, "diagnostics");
      await user.keyboard("{ArrowDown}{Tab}");
      expect(screen.queryByRole("textbox")).toBeNull();
      await user.clear(search);
      await user.type(search, "ana");
      expect(screen.getByRole("status").textContent).toBe(
        "1 result. Enter: Follow Ana",
      );
    });

    it("names Tab on a keyed row in the status line", async () => {
      const user = userEvent.setup();
      renderPalette();
      await waitForDialogFocus();
      await user.type(screen.getByRole("combobox"), "blade");
      expect(screen.getByRole("status").textContent).toBe(
        "1 command. Enter runs Blade cut. Tab remaps",
      );
    });
  });

  it("clears the search and any open key field when it reopens", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderPalette();
    await waitForDialogFocus();
    await user.type(
      screen.getByRole("combobox", { name: "Search commands" }),
      "blade",
    );
    await user.keyboard("{Tab}");
    expect(screen.getByLabelText("Remap Blade cut")).toBeTruthy();
    rerender(<CommandPaletteView {...props} open={false} />);
    rerender(<CommandPaletteView {...props} open />);
    expect(
      screen.getByRole("combobox", { name: "Search commands" }),
    ).toHaveValue("");
    expect(screen.queryByLabelText("Remap Blade cut")).toBeNull();
  });

  it("shows Recent first when Search is empty, skipping unavailable and unknown ids", () => {
    renderPalette({
      entries: ENTRIES,
      recent: [
        "help.diagnosticsBundle",
        "gone",
        "chapter:62:Intro",
        "edit.bladeCut",
      ],
    });
    const recent = screen.getByRole("group", { name: "Recent" });
    expect(within(recent).getAllByRole("option")).toHaveLength(2);
    expect(within(recent).getByRole("option", { name: /^Intro/ })).toBeTruthy();
    expect(
      within(recent).getByRole("option", { name: /^Blade cut/ }),
    ).toBeTruthy();
    expect(within(recent).queryByText("Export diagnostics…")).toBeNull();
  });

  it("caps Recent at five rows", () => {
    const many: PaletteCommand[] = Array.from({ length: 7 }, (_, i) => ({
      id: `cmd.${i}`,
      label: `Command ${i}`,
      category: "view",
      shortcut: null,
      disabledReason: null,
    }));
    renderPalette({ commands: many, recent: many.map((c) => c.id) });
    const recent = screen.getByRole("group", { name: "Recent" });
    expect(within(recent).getAllByRole("option")).toHaveLength(5);
  });

  it("says Nothing matches when entries exist and the search finds none", async () => {
    renderPalette({ entries: ENTRIES });
    await userEvent.setup().type(screen.getByRole("combobox"), "zzzz");
    expect(screen.getByText(/Nothing matches/).textContent).toContain("zzzz");
    expect(screen.queryByText(/No commands match/)).toBeNull();
  });

  it("shows no Recent group without recents or while searching", async () => {
    const { rerender, props } = renderPalette({ entries: ENTRIES });
    expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
    rerender(<CommandPaletteView {...props} recent={["edit.bladeCut"]} />);
    expect(screen.getByRole("group", { name: "Recent" })).toBeTruthy();
    await userEvent.setup().type(screen.getByRole("combobox"), "blade");
    expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
  });

  it("lists Projects, People and Chapters groups, hiding empty ones", () => {
    const { rerender, props } = renderPalette({ entries: ENTRIES });
    for (const name of ["Projects", "People", "Chapters"]) {
      expect(screen.getByRole("group", { name })).toBeTruthy();
    }
    rerender(
      <CommandPaletteView
        {...props}
        entries={ENTRIES.filter((e) => e.group === "chapters")}
      />,
    );
    expect(screen.queryByRole("group", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("group", { name: "People" })).toBeNull();
    expect(screen.getByRole("group", { name: "Chapters" })).toBeTruthy();
  });

  it("runs an entry by click and by arrow keys and Enter", async () => {
    const onRunEntry = vi.fn();
    const user = userEvent.setup();
    renderPalette({ entries: ENTRIES, onRunEntry });
    await user.click(screen.getByRole("option", { name: /^Intro/ }));
    expect(onRunEntry).toHaveBeenCalledWith(ENTRIES[2]);
    await user.type(screen.getByRole("combobox"), "ana");
    expect(screen.getByRole("status").textContent).toContain(
      "1 result. Enter: Follow Ana",
    );
    await user.keyboard("{Enter}");
    expect(onRunEntry).toHaveBeenLastCalledWith(ENTRIES[1]);
  });

  it("finds entries by their context and keeps arrow keys across groups", async () => {
    const user = userEvent.setup();
    renderPalette({ entries: ENTRIES });
    const box = screen.getByRole("combobox");
    await user.type(box, "1:02");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.clear(box);
    await user.keyboard("{ArrowUp}");
    const last = screen.getAllByRole("option").at(-1);
    expect(box.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0]?.id,
    );
    expect(last?.textContent).toContain("Intro");
    for (let i = 0; i < 20; i++) await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).toBe(last?.id);
  });

  describe("Stages and Help groups, verb icons", () => {
    const stage = (
      id: string,
      label: string,
      overrides: Partial<PaletteCommand> = {},
    ): PaletteCommand => ({
      id: `stage.${id}`,
      label,
      category: "navigation",
      shortcut: null,
      group: "stages",
      disabledReason: null,
      ...overrides,
    });
    const GROUPED: PaletteCommand[] = [
      COMMANDS[0],
      {
        id: "stage.edit",
        label: "Go to Edit",
        category: "navigation",
        shortcut: "Ctrl+3",
        group: "stages",
        icon: "stage-edit",
        disabledReason: null,
      },
      stage("deliver", "Go to Deliver", {
        disabledReason: "Not available on this link",
      }),
      {
        id: "help.diagnosticsBundle",
        label: "Export diagnostics…",
        category: "ui",
        shortcut: null,
        group: "help",
        disabledReason: null,
      },
    ];

    it("lists Stages after the categories and Help last, off the category sections", () => {
      renderPalette({ commands: GROUPED, entries: ENTRIES });
      expect(groupNames()).toEqual([
        "Transport",
        "Stages",
        "Projects",
        "People",
        "Chapters",
        "Help",
      ]);
      const stages = within(screen.getByRole("group", { name: "Stages" }));
      expect(stages.getAllByRole("option")).toHaveLength(2);
      expect(
        stages.getByRole("option", { name: /Go to Deliver/ }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        within(screen.getByRole("group", { name: "Help" })).getByRole(
          "option",
          { name: "Export diagnostics…" },
        ),
      ).toBeTruthy();
      const ids = screen.getAllByRole("option").map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id, i) => id.endsWith(`-opt-${i}`))).toBe(true);
    });

    it("with leadGroup lists Help first and makes the first Help row active; searching lists flat", async () => {
      const user = userEvent.setup();
      renderPalette({ commands: GROUPED, leadGroup: "help" });
      expect(groupNames()).toEqual(["Help", "Transport", "Stages"]);
      const search = screen.getByRole("combobox", { name: "Search commands" });
      expect(search).toHaveAttribute(
        "aria-activedescendant",
        screen.getAllByRole("option")[0].id,
      );
      await user.type(search, "export");
      expect(
        screen.getByRole("option", { name: "Export diagnostics… Help" }),
      ).toBeTruthy();
    });

    it("runs a stage command through onRun and refuses a gated one", async () => {
      const user = userEvent.setup();
      const { props } = renderPalette({ commands: GROUPED });
      await user.click(screen.getByRole("option", { name: /Go to Deliver/ }));
      expect(props.onRun).not.toHaveBeenCalled();
      await user.click(screen.getByRole("option", { name: /Go to Edit/ }));
      expect(props.onRun).toHaveBeenCalledWith("stage.edit");
    });

    it("hides the Stages group when no stage command is listed", () => {
      renderPalette({ commands: [COMMANDS[0]] });
      expect(groupNames()).toEqual(["Transport"]);
    });

    it("keeps Stages and Help commands in the flat search results, labelled by group", async () => {
      const user = userEvent.setup();
      renderPalette({ commands: GROUPED });
      await user.type(screen.getByRole("combobox"), "diagnostics");
      expect(screen.queryAllByRole("group")).toHaveLength(0);
      expect(
        screen.getByRole("option", { name: "Export diagnostics… Help" }),
      ).toBeTruthy();
      await user.clear(screen.getByRole("combobox"));
      await user.type(screen.getByRole("combobox"), "go to ed");
      expect(
        screen.getByRole("option", { name: /Go to Edit Stages/ }),
      ).toBeTruthy();
    });

    it("draws the verb icon as a decorative SVG and keeps the option name unchanged", () => {
      renderPalette({ commands: GROUPED });
      const edit = screen.getByRole("option", { name: /Go to Edit/ });
      expect(edit.querySelector("svg.command-palette-icon")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(edit).toHaveAccessibleName("Go to Edit Ctrl+3");
      expect(
        screen
          .getByRole("option", { name: /Go to Deliver/ })
          .querySelector("svg"),
      ).toBeNull();
    });
  });

  describe("Gestures rows", () => {
    it("lists one non-option row per gesture after the listbox, only when passed", () => {
      const { unmount } = renderPalette({
        commands: [COMMANDS[0], HELP_COMMAND],
        entries: ENTRIES,
        gestures: PALETTE_GESTURES,
      });
      expect(groupNames()).toEqual([
        "Transport",
        "Projects",
        "People",
        "Chapters",
        "Help",
        "Gestures",
      ]);
      const group = screen.getByRole("group", { name: "Gestures" });
      expect(within(group).queryAllByRole("option")).toHaveLength(0);
      const rows = within(group).getAllByRole("listitem");
      expect(
        rows.map((r) => r.querySelector(".command-palette-label")?.textContent),
      ).toEqual([
        "Undo",
        "Open inspector",
        "Zoom in / Zoom out",
        "Extend transcript range",
        "Edit focused transcript word",
      ]);
      expect(
        rows.map(
          (r) => r.querySelector(".command-palette-gesture")?.textContent,
        ),
      ).toEqual([
        "Two-finger tap",
        "Long-press",
        "Pinch",
        "Hold a word, then drag",
        "Double-tap word",
      ]);
      unmount();
      renderPalette({ entries: ENTRIES });
      expect(groupNames()).not.toContain("Gestures");
    });

    it("lists two-finger Undo as an optional ShareCut shortcut among the gesture rows", () => {
      renderPalette({ gestures: PALETTE_GESTURES });
      expect(
        within(screen.getByRole("group", { name: "Gestures" })).getAllByRole(
          "listitem",
        )[0],
      ).toHaveTextContent(
        "Undo Two-finger tap Undo the last action. Optional ShareCut shortcut.",
      );
    });

    it("finds a gesture by name; the row is not an option, is skipped by the arrows and Enter does nothing", async () => {
      const user = userEvent.setup();
      const { props } = renderPalette({
        entries: ENTRIES,
        gestures: PALETTE_GESTURES,
      });
      await user.type(screen.getByRole("combobox"), "pinch");
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
      expect(screen.getByRole("status").textContent).toBe("1 result");
      await user.keyboard("{ArrowDown}{Enter}");
      await user.click(screen.getByRole("listitem"));
      expect(props.onRun).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("leads with Help on Home and keeps Gestures last", () => {
      renderPalette({
        commands: [COMMANDS[0], HELP_COMMAND],
        leadGroup: "help",
        gestures: PALETTE_GESTURES,
      });
      expect(groupNames()).toEqual(["Help", "Transport", "Gestures"]);
    });
  });
});
