import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow } from "../test/fixtures";
import { JoinPopoverView, type JoinPopoverViewProps } from "./JoinPopoverView";

const left = clipRow({
  id: "c0",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  timeline_end: 5,
  fade_out_ms: 10,
});
const right = clipRow({
  id: "c1",
  source_start: 5,
  source_end: 10,
  timeline_start: 5,
  timeline_end: 10,
  fade_in_ms: 10,
  join_left_clip_id: "c0",
  join_in_mode: "fade",
});

function renderView(overrides: Partial<JoinPopoverViewProps> = {}) {
  const props: JoinPopoverViewProps = {
    id: "join-popover",
    left,
    right,
    seamSec: 5,
    trackFadeMaxMs: 40,
    editable: true,
    busy: false,
    error: null,
    onModeChange: vi.fn(),
    onLengthCommit: vi.fn(),
    onClose: vi.fn(),
    footer: null,
    ...overrides,
  };
  const view = render(<JoinPopoverView {...props} />);
  return { ...view, props };
}

describe("JoinPopoverView", () => {
  it("is a dialog named for the seam", async () => {
    const { container } = renderView();
    expect(
      screen.getByRole("dialog", { name: "Fade join at 0:05.0" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("shows a Join mode group with the current mode pressed", () => {
    renderView();
    expect(
      screen.getByRole("group", { name: "Join mode" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Fade", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onModeChange for a different mode, not the pressed one", () => {
    const onModeChange = vi.fn();
    renderView({ onModeChange });
    fireEvent.click(
      screen.getByRole("button", { name: "Crossfade", exact: true }),
    );
    expect(onModeChange).toHaveBeenCalledWith("crossfade");
    fireEvent.click(screen.getByRole("button", { name: "Fade", exact: true }));
    expect(onModeChange).toHaveBeenCalledTimes(1);
  });

  it("has a Length slider bounded by joinLengthMaxMs, with the current value", () => {
    renderView();
    const slider = screen.getByRole("slider", { name: "Length" });
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "40");
    expect(slider).toHaveValue("10");
    expect(slider).toHaveAttribute("aria-valuetext", "10 ms");
  });

  it("commits a length change once", () => {
    const onLengthCommit = vi.fn();
    renderView({ onLengthCommit });
    const slider = screen.getByRole("slider", { name: "Length" });
    fireEvent.input(slider, { target: { value: "30" } });
    fireEvent.change(slider, { target: { value: "30" } });
    expect(onLengthCommit).toHaveBeenCalledTimes(1);
    expect(onLengthCommit).toHaveBeenCalledWith(30);
  });

  it("floors the length slider at 1 ms for crossfade", () => {
    renderView({
      right: clipRow({ ...right, join_in_mode: "crossfade", fade_in_ms: 25 }),
      left: clipRow({ ...left, fade_out_ms: 25 }),
    });
    expect(screen.getByRole("slider", { name: "Length" })).toHaveAttribute(
      "min",
      "1",
    );
  });

  it("has no slider for a cut", () => {
    renderView({ right: clipRow({ ...right, join_in_mode: "cut" }) });
    expect(screen.queryByRole("slider", { name: "Length" })).toBeNull();
  });

  it("is read-only when not editable: mode as text, no mode buttons", () => {
    renderView({ editable: false });
    expect(screen.queryByRole("group", { name: "Join mode" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Crossfade", exact: true }),
    ).toBeNull();
    expect(screen.getByText("Fade (dip at join)")).toBeInTheDocument();
  });

  it("shows the blocked-crossfade note", () => {
    renderView({
      right: clipRow({
        ...right,
        join_in_mode: "crossfade",
        join_crossfade_blocked: "no_fade_in",
      }),
    });
    expect(screen.getByText(/will not blend/)).toBeInTheDocument();
  });

  it("disables the mode buttons and the slider while busy", () => {
    renderView({ busy: true });
    expect(
      screen.getByRole("button", { name: "Crossfade", exact: true }),
    ).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Length" })).toBeDisabled();
  });

  it("shows an error with role=alert", () => {
    renderView({ error: "Join could not be applied" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Join could not be applied",
    );
  });

  it("calls onClose from the Close button", () => {
    const onClose = vi.fn();
    renderView({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
