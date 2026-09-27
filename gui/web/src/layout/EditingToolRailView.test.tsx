import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
      />,
    );
    expect(container).toBeEmptyDOMElement();
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
    expect(
      screen.getByRole("button", { name: "Cut at playhead" }),
    ).not.toBeDisabled();

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
