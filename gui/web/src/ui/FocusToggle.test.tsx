import { fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { FocusToggle } from "./FocusToggle";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async (id: string) => {
    if (id === "focus.text") {
      useDawStore.getState().setFocusMode("text");
    }
    if (id === "focus.default") {
      useDawStore.getState().setFocusMode("default");
    }
    if (id === "focus.timeline") {
      useDawStore.getState().setFocusMode("timeline");
    }
    return { status: "ok" };
  }),
}));

describe("FocusToggle", () => {
  beforeEach(() => {
    useDawStore.setState({ focusMode: "default" });
  });

  it("activates focus mode and is axe-clean", async () => {
    const { container } = render(
      <FocusToggle mode="text" label="Transcript" />,
    );
    const btn = within(container).getByRole("button", { name: "Focus" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveClass("ui-control");
    fireEvent.click(btn);
    expect(useDawStore.getState().focusMode).toBe("text");
    await expectNoA11yViolations(container);
  });

  it("toggles back to default when already active", () => {
    useDawStore.setState({ focusMode: "timeline" });
    const { container } = render(
      <FocusToggle mode="timeline" label="Timeline" />,
    );
    const btn = within(container).getByRole("button", { name: "Focused" });
    expect(btn).toHaveClass("ui-control", "active");
    fireEvent.click(btn);
    expect(useDawStore.getState().focusMode).toBe("default");
  });
});
