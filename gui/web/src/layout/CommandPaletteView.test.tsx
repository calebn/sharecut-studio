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
      { id: "tool.blade", label: "Blade tool", shortcut: "C", defaultKey: "c" },
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
    const { container } = render(
      <CommandPaletteView
        open={false}
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows tabs, rows and the unbound section and passes axe", async () => {
    const { container } = render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    expect(screen.getByRole("tab", { name: "All keys" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "tools" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Actions" })).toBeTruthy();
    expect(screen.getByText("Select tool")).toBeTruthy();
    expect(screen.getByText("V")).toBeTruthy();
    expect(screen.getByText("Annotate transcript")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("filters rows to the selected category tab", async () => {
    const user = userEvent.setup();
    render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "tools" }));
    expect(screen.getByText("Select tool")).toBeTruthy();
    expect(screen.getByText("Blade tool")).toBeTruthy();
    expect(screen.queryByText("Play / pause")).toBeNull();
  });

  it("shows only unbound actions on the Actions tab", async () => {
    const user = userEvent.setup();
    render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Actions" }));
    expect(screen.queryByText("Select tool")).toBeNull();
    expect(screen.getByText("Annotate transcript")).toBeTruthy();
  });

  it("omits the Actions tab when there are no unbound commands", () => {
    render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={[]}
        {...actions()}
      />,
    );
    expect(screen.queryByRole("tab", { name: "Actions" })).toBeNull();
  });

  it("omits a tab for a category with no rows", () => {
    render(
      <CommandPaletteView
        open
        categories={[{ category: "history", rows: [] }]}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    expect(screen.queryByRole("tab", { name: "history" })).toBeNull();
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

  it("resets tab and remap state when the dialog reopens", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CommandPaletteView
        open
        categories={CATEGORIES}
        unbound={UNBOUND}
        {...actions()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "tools" }));
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
    expect(screen.getByRole("tab", { name: "All keys" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByLabelText("Remap Select tool")).toBeNull();
  });
});
