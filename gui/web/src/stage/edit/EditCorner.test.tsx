import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { EditCorner } from "./EditCorner";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/corner/p.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    guestMode: null,
    openSheet: null,
    scriptCollapsed: false,
    zoomPxPerSec: 100,
    pointerKind: "fine",
    rangeArmed: false,
  });
});

describe("EditCorner", () => {
  it("opens and closes the eye sheet", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const eye = screen.getByRole("button", { name: "View options" });
    expect(eye).toHaveAttribute("aria-pressed", "false");
    await user.click(eye);
    expect(useDawStore.getState().openSheet).toBe("view");
    expect(eye).toHaveAttribute("aria-pressed", "true");
    await user.click(eye);
    expect(useDawStore.getState().openSheet).toBeNull();
  });

  it("zooms through view.zoomIn and view.zoomOut", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomedIn = useDawStore.getState().zoomPxPerSec;
    expect(zoomedIn).toBeGreaterThan(100);
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(useDawStore.getState().zoomPxPerSec).toBeLessThan(zoomedIn);
  });

  it("toggles the Script pane through view.toggleScript", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const script = screen.getByRole("button", { name: "Show or hide Script" });
    expect(script).toHaveAttribute("aria-pressed", "true");
    await user.click(script);
    expect(useDawStore.getState().scriptCollapsed).toBe(true);
    expect(script).toHaveAttribute("aria-pressed", "false");
  });

  it("has no Script toggle on a phone", () => {
    render(<EditCorner showScript={false} />);
    expect(
      screen.queryByRole("button", { name: "Show or hide Script" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Fit session width" }),
    ).toBeInTheDocument();
  });

  it("offers no range toggle to a mouse or pen", () => {
    render(<EditCorner />);
    expect(screen.queryByRole("button", { name: "Select range" })).toBeNull();
  });

  it("arms and disarms a range through range.arm on a touch screen", async () => {
    const user = userEvent.setup();
    useDawStore.setState({ pointerKind: "coarse" });
    render(<EditCorner />);
    const range = screen.getByRole("button", { name: "Select range" });
    expect(range).toHaveAttribute("aria-pressed", "false");
    await user.click(range);
    expect(useDawStore.getState().rangeArmed).toBe(true);
    expect(range).toHaveAttribute("aria-pressed", "true");
    await user.click(range);
    expect(useDawStore.getState().rangeArmed).toBe(false);
  });

  it("follows the pointer kind live, so a first touch brings the toggle", () => {
    render(<EditCorner />);
    expect(screen.queryByRole("button", { name: "Select range" })).toBeNull();
    act(() => useDawStore.getState().setPointerKind("coarse"));
    expect(
      screen.getByRole("button", { name: "Select range" }),
    ).toBeInTheDocument();
  });

  it("explains why the range toggle is unavailable without a project", () => {
    useDawStore.setState({ pointerKind: "coarse", project: null });
    render(<EditCorner />);
    const range = screen.getByRole("button", { name: "Select range" });
    expect(range).toBeDisabled();
  });
});
