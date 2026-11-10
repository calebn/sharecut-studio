import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { makeRangeTarget } from "../../edit/rangeSelection";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { closeOverlay, openOverlay } from "../../ui/modalGate";
import { EditCorner } from "./EditCorner";
import { EditCornerView, type ViewPopoverSlotProps } from "./EditCornerView";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(
    "/tmp/corner/p.json",
    minimalProject({
      tracks: [sampleTrack()],
      clips: {
        tracks: {
          [sampleTrack().id]: [
            clipRow({ track_id: sampleTrack().id, timeline_end: 5 }),
          ],
        },
        clip_count: 1,
      },
    }),
  );
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
  it("opens and closes the eye popover without a sheet", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const eye = screen.getByRole("button", { name: "View options" });
    expect(eye).toHaveAttribute("aria-pressed", "false");
    await user.click(eye);
    expect(
      screen.getByRole("dialog", { name: "View options" }),
    ).toBeInTheDocument();
    expect(useDawStore.getState().openSheet).toBeNull();
    expect(eye).toHaveAttribute("aria-pressed", "true");
    await user.click(eye);
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
  });

  it("closes on anchor loss without stealing focus from another control", async () => {
    const user = userEvent.setup();
    const fallback = document.createElement("button");
    fallback.textContent = "Recovery";
    document.body.append(fallback);
    const { rerender } = render(<EditCorner />);
    await user.click(screen.getByRole("button", { name: "View options" }));
    fallback.focus();
    rerender(
      <EditCorner
        viewAnchor={{ kind: "unavailable", returnTarget: () => fallback }}
      />,
    );
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it.each(["focus", "pointer", "modal"])(
    "cancels recovery after newer %s ownership during removal",
    (actor) => {
      const elsewhere = document.createElement("button");
      const destination = document.createElement("button");
      document.body.append(elsewhere, destination);
      function Slot({ panelRef }: ViewPopoverSlotProps) {
        useLayoutEffect(() => {
          panelRef?.current?.focus();
          return () => {
            if (actor === "focus") {
              elsewhere.focus();
              elsewhere.blur();
            } else if (actor === "pointer")
              document.dispatchEvent(
                new Event("pointerdown", { bubbles: true }),
              );
            else {
              const modal = openOverlay(true);
              closeOverlay(modal);
            }
          };
        }, [panelRef]);
        return (
          <div ref={panelRef} tabIndex={-1}>
            View panel
          </div>
        );
      }
      const props = {
        zoom: { canZoomIn: true, canZoomOut: true },
        onZoomIn() {},
        onZoomOut() {},
        onFit() {},
        onToggleView() {},
        onCloseView() {},
        viewPopover: Slot,
      };
      const { rerender } = render(<EditCornerView {...props} viewOpen />);
      rerender(
        <EditCornerView
          {...props}
          viewOpen
          viewAnchor={{ kind: "unavailable", returnTarget: () => destination }}
        />,
      );
      rerender(
        <EditCornerView
          {...props}
          viewOpen={false}
          viewAnchor={{ kind: "unavailable", returnTarget: () => destination }}
        />,
      );
      expect(document.body).toHaveFocus();
      expect(destination).not.toHaveFocus();
      elsewhere.remove();
      destination.remove();
    },
  );

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

  it("announces why the range toggle refuses over a committed range", async () => {
    const user = userEvent.setup();
    useDawStore.setState({ pointerKind: "coarse" });
    render(<EditCorner />);
    const project = useDawStore.getState().project!;
    const target = makeRangeTarget(
      project,
      [{ start: 1, end: 3 }],
      [sampleTrack().id],
    )!;
    act(() => useDawStore.getState().commitRange(target));
    await user.click(screen.getByRole("button", { name: "Select range" }));
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "A range is already selected",
    });
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

  describe("Snap toggle", () => {
    beforeEach(() => {
      localStorage.clear();
      useDawStore.setState({ snapEnabled: true });
    });

    it.each(["fine", "coarse"] as const)(
      "turns snapping off and on from a %s pointer",
      async (pointerKind) => {
        const user = userEvent.setup();
        useDawStore.setState({ pointerKind });
        render(<EditCorner />);
        const snap = screen.getByRole("button", { name: "Snap to cut points" });
        expect(snap).toHaveAttribute("aria-pressed", "true");
        await user.click(snap);
        expect(useDawStore.getState().snapEnabled).toBe(false);
        expect(snap).toHaveAttribute("aria-pressed", "false");
        await user.click(snap);
        expect(useDawStore.getState().snapEnabled).toBe(true);
        expect(snap).toHaveAttribute("aria-pressed", "true");
      },
    );

    it("is unavailable without a project", () => {
      useDawStore.setState({ project: null });
      render(<EditCorner />);
      expect(
        screen.getByRole("button", { name: "Snap to cut points" }),
      ).toBeDisabled();
    });

    it("has no accessibility violations", async () => {
      const { container } = render(<EditCorner />);
      await expectNoA11yViolations(container);
    });
  });
});
