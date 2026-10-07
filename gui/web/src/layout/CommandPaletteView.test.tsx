import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { waitForDialogFocus } from "../test/dialogFocus";
import { CommandPaletteView } from "./CommandPaletteView";
import type { PaletteCommand } from "./paletteSearch";

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
    id: "tool.blade",
    label: "Blade tool",
    category: "tools",
    shortcut: "C",
    defaultKey: "C",
    note: "C alone selects the Blade tool; Mod+C is Copy",
    disabledReason: null,
  },
  {
    id: "export.deliverables",
    label: "Export deliverables…",
    category: "ui",
    shortcut: "⌘+Shift+E",
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

function renderPalette(
  overrides: Partial<Parameters<typeof CommandPaletteView>[0]> = {},
) {
  const props = {
    open: true,
    commands: COMMANDS,
    onClose: vi.fn(),
    onOpenGestures: vi.fn(),
    onRun: vi.fn(),
    onRemap: vi.fn(),
    ...overrides,
  };
  return { ...render(<CommandPaletteView {...props} />), props };
}

describe("CommandPaletteView", () => {
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
    ).toEqual(["Transport", "Tools", "App"]);
    expect(
      within(listbox).getByRole("option", { name: "Play / pause" }),
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

  it("marks the top runnable match and says Enter runs it", async () => {
    const user = userEvent.setup();
    const { props, baseElement } = renderPalette();
    await waitForDialogFocus();
    const search = screen.getByRole("combobox", { name: "Search commands" });
    await user.type(search, "export");
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 commands. Enter runs Export deliverables…",
    );
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Export deliverables…App⌘+Shift+E",
      "Export diagnostics…AppProject create/open is host-only",
    ]);
    const top = screen.getByRole("option", { name: /^Export deliverables…/ });
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
      "1 command. Enter runs Export deliverables…",
    );
  });

  it("marks a command that cannot run and says why", () => {
    const { props } = renderPalette();
    const row = screen.getByRole("option", { name: "Export diagnostics…" });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAccessibleDescription("Project create/open is host-only");
    row.click();
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("runs a command on click without taking focus from Search", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await waitForDialogFocus();
    await user.click(screen.getByRole("option", { name: "Blade tool" }));
    expect(props.onRun).toHaveBeenCalledExactlyOnceWith("tool.blade");
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
      "Enter runs Play / pause",
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
    expect(screen.getByRole("option", { name: "Play / pause" })).toBeTruthy();
  });

  it("links a row's collision note through aria-describedby", () => {
    renderPalette();
    expect(
      screen.getByRole("option", { name: "Blade tool" }),
    ).toHaveAccessibleDescription(
      "C C alone selects the Blade tool; Mod+C is Copy",
    );
  });

  it("hands Gestures and Escape to the owner", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await waitForDialogFocus();
    await user.click(screen.getByRole("button", { name: "Gestures" }));
    expect(props.onOpenGestures).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("sends the trimmed key on remap blur, and empty string when cleared", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await waitForDialogFocus();
    await user.click(screen.getByLabelText("Show remaps"));
    expect(screen.queryByLabelText("Remap Export diagnostics…")).toBeNull();
    const input = screen.getByLabelText("Remap Blade tool");
    await user.type(input, " B ");
    await user.tab();
    expect(props.onRemap).toHaveBeenLastCalledWith("tool.blade", "B");
    await user.clear(input);
    await user.tab();
    expect(props.onRemap).toHaveBeenLastCalledWith("tool.blade", "");
  });

  it("clears the search and remaps when it reopens", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderPalette();
    await waitForDialogFocus();
    await user.type(
      screen.getByRole("combobox", { name: "Search commands" }),
      "blade",
    );
    await user.click(screen.getByLabelText("Show remaps"));
    rerender(<CommandPaletteView {...props} open={false} />);
    rerender(<CommandPaletteView {...props} open />);
    expect(
      screen.getByRole("combobox", { name: "Search commands" }),
    ).toHaveValue("");
    expect(screen.getByLabelText("Show remaps")).not.toBeChecked();
  });
});
