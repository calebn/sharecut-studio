import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { LayoutRestoreChip, LayoutToggle } from "./LayoutControls";

function renderControls(collapsed = false) {
  return render(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <LayoutToggle />
      <LayoutRestoreChip collapsed={collapsed} />
    </DawProvider>,
  );
}

describe("layout controls", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({ layoutMode: "default" });
  });

  it("toggles between default and maximized timeline", async () => {
    const user = userEvent.setup();
    const view = renderControls();
    const toggle = screen.getByRole("button", { name: "Maximize timeline" });
    expect(toggle).not.toHaveAttribute("aria-pressed");
    await user.click(toggle);
    expect(useDawStore.getState().layoutMode).toBe("timeline");
    const restore = screen.getByRole("button", { name: "Restore layout" });
    expect(restore).not.toHaveAttribute("aria-pressed");
    expect(restore.getAttribute("title")).toMatch(/^Restore layout( \(.+\))?$/);
    await expectNoA11yViolations(view.container);
    await user.click(restore);
    expect(useDawStore.getState().layoutMode).toBe("default");
  });

  it("names the toggle Restore layout in the text and review layouts", () => {
    for (const layoutMode of ["text", "review"] as const) {
      useDawStore.setState({ layoutMode });
      const view = renderControls();
      expect(
        screen.getByRole("button", { name: "Restore layout" }),
      ).toBeTruthy();
      view.unmount();
    }
  });

  it("shows a Restore chip only outside the default layout", async () => {
    const user = userEvent.setup();
    const view = renderControls();
    expect(screen.queryByRole("button", { name: /Restore$/ })).toBeNull();
    useDawStore.setState({ layoutMode: "text" });
    const chip = await screen.findByRole("button", {
      name: "Transcript maximized · Restore",
    });
    await expectNoA11yViolations(view.container);
    await user.click(chip);
    expect(useDawStore.getState().layoutMode).toBe("default");
  });

  it("collapses the chip text to Restore", () => {
    useDawStore.setState({ layoutMode: "review" });
    renderControls(true);
    const chip = screen.getByRole("button", { name: "Restore" });
    expect(chip.getAttribute("title")).toContain("Review layout");
  });
});
