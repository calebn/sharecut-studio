import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { EditToolStrip } from "./EditToolStrip";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/strip/p.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    guestMode: null,
    toolMode: "select",
    commentMode: false,
    rangeArmed: false,
  });
});

describe("EditToolStrip", () => {
  it("offers Select, Blade, Comment mode and Select range in one group", () => {
    render(<EditToolStrip />);
    const group = screen.getByRole("group", { name: "Editing tools" });
    for (const name of [
      "Select tool",
      "Blade tool",
      "Toggle comment mode",
      "Select range",
    ]) {
      expect(group).toContainElement(screen.getByRole("button", { name }));
    }
    expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("switches to Blade through tool.blade and offers Cut at the playhead", async () => {
    const user = userEvent.setup();
    render(<EditToolStrip />);
    expect(screen.queryByRole("button", { name: /Blade cut/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Blade tool" }));
    expect(useDawStore.getState().toolMode).toBe("blade");
    expect(
      screen.getByRole("button", { name: /Blade cut/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select tool" }));
    expect(useDawStore.getState().toolMode).toBe("select");
  });

  it("toggles comment mode through review.toggleCommentMode", async () => {
    const user = userEvent.setup();
    render(<EditToolStrip />);
    await user.click(
      screen.getByRole("button", { name: "Toggle comment mode" }),
    );
    expect(useDawStore.getState().commentMode).toBe(true);
    expect(
      screen.getByRole("button", { name: "Toggle comment mode" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /Blade cut/i })).toBeNull();
  });

  it("arms and disarms a range through range.arm", async () => {
    const user = userEvent.setup();
    render(<EditToolStrip />);
    const range = screen.getByRole("button", { name: "Select range" });
    expect(range).toHaveAttribute("aria-pressed", "false");
    await user.click(range);
    expect(useDawStore.getState().rangeArmed).toBe(true);
    expect(range).toHaveAttribute("aria-pressed", "true");
    await user.click(range);
    expect(useDawStore.getState().rangeArmed).toBe(false);
  });

  it("explains why Blade is unavailable to a link that cannot suggest edits", () => {
    useDawStore.setState({ guestMode: "comment", projectPath: "share:abc" });
    render(<EditToolStrip />);
    expect(screen.getByRole("button", { name: "Blade tool" })).toBeDisabled();
  });
});
