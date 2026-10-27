import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { ToolsButton } from "./ToolsButton";
import { ToolsSheet } from "./ToolsSheet";

const viewport = vi.hoisted(() => ({ shell: "phone" as string }));
vi.mock("../../hooks/useViewportClass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useViewportClass")>()),
  useViewportClass: () => viewport.shell,
}));

beforeEach(() => {
  viewport.shell = "phone";
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/tools/p.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    guestMode: null,
    toolMode: "select",
    commentMode: false,
    rangeArmed: false,
    editSurface: "lanes",
    openSheet: null,
  });
});

describe("ToolsButton", () => {
  it("opens the Tools sheet and shows the tool in use", async () => {
    const user = userEvent.setup();
    render(<ToolsButton />);
    const button = screen.getByRole("button", { name: "Tools" });
    expect(button).toHaveAttribute("data-tool", "select");
    await user.click(button);
    expect(useDawStore.getState().openSheet).toBe("tools");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("swaps its icon for the Blade tool", () => {
    useDawStore.setState({ toolMode: "blade" });
    render(<ToolsButton />);
    expect(screen.getByRole("button", { name: "Tools" })).toHaveAttribute(
      "data-tool",
      "blade",
    );
  });
});

describe("ToolsSheet", () => {
  it("holds the surface switch, the tools and Mix, and is axe-clean", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolsSheet />);
    expect(
      screen.getByRole("group", { name: "Edit surface" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Editing tools" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Script" }));
    expect(useDawStore.getState().editSurface).toBe("text");
    expect(screen.queryByRole("group", { name: "Editing tools" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mix" }));
    expect(useDawStore.getState().openSheet).toBe("mix");
  });

  it("holds the corner a short frame takes off the lanes", async () => {
    const user = userEvent.setup();
    render(<ToolsSheet />);
    const corner = screen.getByRole("group", { name: "Timeline view" });
    expect(corner).toBeInTheDocument();
    // The phone has no side-by-side Script pane, so no Script toggle.
    expect(screen.queryByRole("button", { name: /Script pane/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "View options" }));
    expect(useDawStore.getState().openSheet).toBe("view");
  });

  it("on a tablet holds the corner with the Script toggle and no tool rows", () => {
    viewport.shell = "tablet";
    render(<ToolsSheet />);
    expect(
      screen.getByRole("group", { name: "Timeline view" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Edit surface" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Editing tools" })).toBeNull();
  });
});
