import { fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { FocusToggle } from "./FocusToggle";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async (id: string) => {
    if (id === "layout.text") {
      useDawStore.getState().setLayoutMode("text");
    }
    if (id === "layout.default") {
      useDawStore.getState().setLayoutMode("default");
    }
    if (id === "layout.timeline") {
      useDawStore.getState().setLayoutMode("timeline");
    }
    return { status: "ok" };
  }),
}));

describe("FocusToggle", () => {
  beforeEach(() => {
    useDawStore.setState({ layoutMode: "default" });
  });

  it("activates focus mode and is axe-clean", async () => {
    const { container } = render(
      <FocusToggle mode="text" label="Transcript" />,
    );
    const btn = within(container).getByRole("button", { name: "Focus" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveClass("ui-control");
    fireEvent.click(btn);
    expect(useDawStore.getState().layoutMode).toBe("text");
    await expectNoA11yViolations(container);
  });

  it("toggles back to default when already active", () => {
    useDawStore.setState({ layoutMode: "timeline" });
    const { container } = render(
      <FocusToggle mode="timeline" label="Timeline" />,
    );
    const btn = within(container).getByRole("button", { name: "Focused" });
    expect(btn).toHaveClass("ui-control", "active");
    fireEvent.click(btn);
    expect(useDawStore.getState().layoutMode).toBe("default");
  });
});
