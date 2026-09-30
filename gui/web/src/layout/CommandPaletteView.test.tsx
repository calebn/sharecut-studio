import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { CommandPaletteView } from "./CommandPaletteView";
import type { CommandPaletteCategory } from "./commandPaletteRows";

const CATEGORIES: CommandPaletteCategory[] = [
  {
    category: "tools",
    rows: [
      {
        id: "tool.select",
        label: "Select tool",
        shortcut: "V",
        defaultKey: "v",
      },
      {
        id: "tool.blade",
        label: "Blade tool",
        shortcut: "C",
        defaultKey: "c",
        note: "C alone selects the Blade tool; Mod+C is Copy, Mod+Shift+C is Toggle comment mode",
      },
    ],
  },
  {
    category: "transport",
    rows: [
      {
        id: "transport.playPause",
        label: "Play / pause",
        shortcut: "Space",
        defaultKey: " ",
      },
    ],
  },
];

const UNBOUND = [
  { id: "view.transcriptAnnotate", label: "Annotate transcript" },
];

function actions() {
  return {
    onClose: vi.fn(),
    onOpenGestures: vi.fn(),
    onRun: vi.fn(),
    onRemap: vi.fn(),
  };
}

describe("CommandPaletteView", () => {
  it("renders nothing when closed", () => {
    render(
      <CommandPaletteView
        open={false}
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows category filters, rows and the unbound section and passes axe", async () => {
    const { baseElement: container } = render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    expect(
      screen.getByRole("group", { name: "Shortcut categories" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "All keys" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions" })).toBeTruthy();
    expect(screen.getByText("Select tool")).toBeTruthy();
    expect(screen.getByText("V")).toBeTruthy();
    expect(screen.getByText("Annotate transcript")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("filters rows to the selected category filter", async () => {
    const user = userEvent.setup();
    render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "tools" }));
    expect(screen.getByRole("button", { name: "tools" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "All keys" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText("Select tool")).toBeTruthy();
    expect(screen.getByText("Blade tool")).toBeTruthy();
    expect(screen.queryByText("Play / pause")).toBeNull();
  });

  it("shows only unbound actions on the Actions filter", async () => {
    const user = userEvent.setup();
    render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByText("Select tool")).toBeNull();
    expect(screen.getByText("Annotate transcript")).toBeTruthy();
  });

  it("omits the Actions filter when there are no unbound commands", () => {
    render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={[]}
        {...actions()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("renders a row's collision note and links it via aria-describedby", async () => {
    const { baseElement: container } = render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    const note = screen.getByText(
      "C alone selects the Blade tool; Mod+C is Copy, Mod+Shift+C is Toggle comment mode",
    );
    const bladeButton = screen.getByRole("button", { name: /Blade tool/ });
    expect(bladeButton.getAttribute("aria-describedby")).toBe(note.id);
    const selectButton = screen.getByRole("button", { name: /Select tool/ });
    expect(selectButton.hasAttribute("aria-describedby")).toBe(false);
    await expectNoA11yViolations(container);
  });

  it("omits a filter for a category with no rows", () => {
    render(
      <CommandPaletteView
        open
        categories={[{ category: "history", rows: [] }]}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    expect(screen.queryByRole("button", { name: "history" })).toBeNull();
  });

  it("calls onRun, onOpenGestures, and onClose on Escape", async () => {
    const user = userEvent.setup();
    const cbs = actions();
    render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...cbs}
      />,
    );
    await user.click(screen.getByText("Select tool"));
    expect(cbs.onRun).toHaveBeenCalledWith("tool.select");
    await user.click(screen.getByRole("button", { name: "Gestures" }));
    expect(cbs.onOpenGestures).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(cbs.onClose).toHaveBeenCalled();
  });

  it("sends the trimmed key on remap blur, and empty string when cleared", async () => {
    const user = userEvent.setup();
    const cbs = actions();
    render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...cbs}
      />,
    );
    await user.click(screen.getByLabelText("Show remaps"));
    const input = screen.getByLabelText("Remap Select tool");
    await user.type(input, "  x  ");
    await user.tab();
    expect(cbs.onRemap).toHaveBeenLastCalledWith("tool.select", "x");
    await user.clear(input);
    await user.tab();
    expect(cbs.onRemap).toHaveBeenLastCalledWith("tool.select", "");
  });

  it("resets filter and remap state when the dialog reopens", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "tools" }));
    await user.click(screen.getByLabelText("Show remaps"));
    rerender(
      <CommandPaletteView
        open={false}
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    rerender(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "All keys" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByLabelText("Remap Select tool")).toBeNull();
  });
});
