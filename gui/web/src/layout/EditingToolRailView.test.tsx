import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { EditingToolRailView } from "./EditingToolRailView";

function baseProps() {
  return {
    bladeAllowed: true,
    mayIngest: true,
    toolMode: "select" as const,
    commentMode: false,
    busy: false,
    error: null,
    bladeConfirmSec: null,
    trackIdsForCut: [],
    toolToggle: <div data-testid="tool-toggle-slot" />,
    history: { canUndo: true, canRedo: false } as {
      canUndo: boolean;
      canRedo: boolean;
    } | null,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onAddTrack: vi.fn(),
    onImport: vi.fn(),
    onCutAtPlayhead: vi.fn(),
    onCancelCut: vi.fn(),
    onConfirmCut: vi.fn(),
  };
}

describe("EditingToolRailView", () => {
  it("renders null when neither editing nor ingest is allowed", () => {
    const { container } = render(
      <EditingToolRailView
        {...baseProps()}
        bladeAllowed={false}
        mayIngest={false}
        history={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("runs Undo and names why Redo is unavailable", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const { container } = render(<EditingToolRailView {...props} />);
    const group = screen.getByRole("group", { name: "Undo and redo" });
    expect(group).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(redo).toHaveAttribute("aria-disabled", "true");
    expect(redo).toHaveAccessibleDescription("Nothing to redo");
    expect(redo).toHaveAttribute("title", "Nothing to redo");
    await user.click(redo);
    expect(props.onRedo).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("says there is nothing to undo on a fresh project", async () => {
    const { container } = render(
      <EditingToolRailView
        {...baseProps()}
        history={{ canUndo: false, canRedo: true }}
      />,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(undo).toHaveAccessibleDescription("Nothing to undo");
    expect(screen.getByRole("button", { name: "Redo" })).not.toHaveAttribute(
      "aria-disabled",
    );
    await expectNoA11yViolations(container);
  });

  describe("tapping an unavailable Undo or Redo", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the reason in the rail's status line, which clears itself", () => {
      vi.useFakeTimers();
      const props = baseProps();
      render(<EditingToolRailView {...props} />);
      const status = screen.getByRole("status");
      expect(status).toBeEmptyDOMElement();
      act(() => {
        screen.getByRole("button", { name: "Redo" }).click();
      });
      expect(status).toHaveTextContent("Nothing to redo");
      expect(props.onRedo).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(3600);
      });
      expect(status).toBeEmptyDOMElement();
    });

    it("keeps the reason visible for a new wait after another unavailable tap", () => {
      vi.useFakeTimers();
      render(<EditingToolRailView {...baseProps()} />);
      act(() => screen.getByRole("button", { name: "Redo" }).click());
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      act(() => screen.getByRole("button", { name: "Redo" }).click());
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByRole("status")).toHaveTextContent("Nothing to redo");
      act(() => {
        vi.advanceTimersByTime(2600);
      });
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });

    it("passes axe while the reason shows", async () => {
      const { container } = render(<EditingToolRailView {...baseProps()} />);
      act(() => {
        screen.getByRole("button", { name: "Redo" }).click();
      });
      expect(screen.getByRole("status")).toHaveTextContent("Nothing to redo");
      await expectNoA11yViolations(container);
    });

    it("drops the reason once the action becomes available", () => {
      const props = baseProps();
      const { rerender } = render(<EditingToolRailView {...props} />);
      act(() => {
        screen.getByRole("button", { name: "Redo" }).click();
      });
      expect(screen.getByRole("status")).toHaveTextContent("Nothing to redo");
      rerender(
        <EditingToolRailView
          {...props}
          history={{ canUndo: true, canRedo: true }}
        />,
      );
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });

    it("says nothing for an action that runs", () => {
      const props = baseProps();
      render(<EditingToolRailView {...props} />);
      act(() => {
        screen.getByRole("button", { name: "Undo" }).click();
      });
      expect(props.onUndo).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });
  });

  it("hides Undo and Redo from people who cannot edit", () => {
    render(<EditingToolRailView {...baseProps()} history={null} />);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Undo and redo" })).toBeNull();
  });

  it("shows the toggle slot and track/import actions and fires callbacks", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const { container } = render(<EditingToolRailView {...props} />);
    expect(screen.getByRole("group", { name: "Editing tools" })).toBeTruthy();
    expect(screen.getByTestId("tool-toggle-slot")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "+ Track" }));
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(props.onAddTrack).toHaveBeenCalledTimes(1);
    expect(props.onImport).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("shows Cut at playhead in blade mode, disables it when busy, and hides it in comment mode", () => {
    const { rerender } = render(
      <EditingToolRailView {...baseProps()} toolMode="blade" />,
    );
    const cutButton = screen.getByRole("button", { name: "Cut at playhead" });
    expect(cutButton).not.toBeDisabled();
    expect(cutButton).toHaveAttribute(
      "title",
      "Cut selected tracks at playhead",
    );

    rerender(<EditingToolRailView {...baseProps()} toolMode="blade" busy />);
    expect(
      screen.getByRole("button", { name: "Cut at playhead" }),
    ).toBeDisabled();

    rerender(
      <EditingToolRailView {...baseProps()} toolMode="blade" commentMode />,
    );
    expect(
      screen.queryByRole("button", { name: "Cut at playhead" }),
    ).toBeNull();
  });

  it("renders no toggle slot and no confirm sheet when ingest-only", () => {
    render(
      <EditingToolRailView
        {...baseProps()}
        bladeAllowed={false}
        bladeConfirmSec={12}
      />,
    );
    expect(screen.queryByTestId("tool-toggle-slot")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the confirm sheet with formatted time and track ids, wiring Cut/Cancel", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(
      <EditingToolRailView
        {...props}
        bladeConfirmSec={83.5}
        trackIdsForCut={["host", "guest"]}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Confirm blade cut" });
    expect(dialog.textContent).toContain("host, guest");
    await user.click(screen.getByRole("button", { name: "Cut" }));
    expect(props.onConfirmCut).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancelCut).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(dialog);
  });

  it("falls back to 'all dialogue tracks' when the cut list is empty", () => {
    render(<EditingToolRailView {...baseProps()} bladeConfirmSec={5} />);
    expect(
      screen.getByRole("dialog", { name: "Confirm blade cut" }).textContent,
    ).toContain("all dialogue tracks");
  });

  it("shows Cutting… with both sheet buttons disabled while busy", () => {
    render(<EditingToolRailView {...baseProps()} bladeConfirmSec={5} busy />);
    expect(screen.getByRole("button", { name: "Cutting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("renders the error text", () => {
    render(
      <EditingToolRailView
        {...baseProps()}
        bladeConfirmSec={5}
        error="Cut failed"
      />,
    );
    expect(screen.getByText("Cut failed")).toBeTruthy();
  });
});
