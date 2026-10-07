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
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Transport", "Tools", "App"]);
    expect(
      within(dialog).getByRole("button", { name: /^Play \/ pause/ }),
    ).toBeEnabled();
    await expectNoA11yViolations(baseElement);
  });

  it("focuses Search on open", async () => {
    renderPalette();
    await waitForDialogFocus();
    expect(
      screen.getByRole("searchbox", { name: "Search commands" }),
    ).toHaveFocus();
  });

  it("filters as you type, counts matches and runs the top one on Enter", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await waitForDialogFocus();
    await user.type(
      screen.getByRole("searchbox", { name: "Search commands" }),
      "export",
    );
    expect(screen.getByRole("status")).toHaveTextContent("2 commands");
    const rows = screen
      .getAllByRole("listitem")
      .map((li) => li.querySelector("button")?.textContent);
    expect(rows).toEqual([
      "Export deliverables…App⌘+Shift+E",
      "Export diagnostics…App",
    ]);
    await user.keyboard("{Enter}");
    expect(props.onRun).toHaveBeenCalledExactlyOnceWith("export.deliverables");
  });

  it("disables a command that cannot run and says why", () => {
    renderPalette();
    const row = screen.getByRole("button", { name: "Export diagnostics…" });
    expect(row).toBeDisabled();
    expect(row).toHaveAccessibleDescription("Project create/open is host-only");
  });

  it("moves between results with the arrow keys and back up to Search", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    const search = screen.getByRole("searchbox", { name: "Search commands" });
    await user.type(search, "e");
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("button", { name: /^Export deliverables…/ }),
    ).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("button", { name: /^Play \/ pause/ }),
    ).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(search).toHaveFocus();
  });

  it("offers Clear search when nothing matches", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    const search = screen.getByRole("searchbox", { name: "Search commands" });
    await user.type(search, "xylophone");
    expect(
      screen.getByText("No commands match “xylophone”."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.getByRole("button", { name: /^Play \/ pause/ })).toBeTruthy();
  });

  it("links a row's collision note through aria-describedby", () => {
    renderPalette();
    expect(
      screen.getByRole("button", { name: /^Blade tool/ }),
    ).toHaveAccessibleDescription(
      "C alone selects the Blade tool; Mod+C is Copy",
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
      screen.getByRole("searchbox", { name: "Search commands" }),
      "blade",
    );
    await user.click(screen.getByLabelText("Show remaps"));
    rerender(<CommandPaletteView {...props} open={false} />);
    rerender(<CommandPaletteView {...props} open />);
    expect(
      screen.getByRole("searchbox", { name: "Search commands" }),
    ).toHaveValue("");
    expect(screen.getByLabelText("Show remaps")).not.toBeChecked();
  });
});
