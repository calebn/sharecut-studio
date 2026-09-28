import { fireEvent, render, screen } from "@testing-library/react";
import { type RefObject, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipJoin } from "../api";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { JoinPopover } from "./JoinPopover";

vi.mock("../api", () => ({
  setClipJoin: vi.fn(async () => undefined),
}));

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

function Harness({
  onClose = vi.fn(),
  rightRow = right,
}: {
  onClose?: () => void;
  rightRow?: typeof right;
}) {
  const anchorRef = useRef<HTMLButtonElement>(
    null,
  ) as RefObject<HTMLButtonElement | null>;
  return (
    <div>
      <button ref={anchorRef} type="button">
        Anchor
      </button>
      <JoinPopover
        id="join-popover"
        left={left}
        right={rightRow}
        seamSec={5}
        trackFadeMaxMs={40}
        anchorRef={anchorRef}
        onClose={onClose}
      />
    </div>
  );
}

describe("JoinPopover", () => {
  beforeEach(() => {
    vi.mocked(setClipJoin).mockClear();
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [sampleTrack()] }));
    useDawStore.setState({
      playheadSec: 0,
      playUntilSec: null,
      isPlaying: false,
    });
  });

  it("sends SetClipJoin for a mode change", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Crossfade" }));
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c0",
      "c1",
      "crossfade",
      null,
    );
  });

  it("sends SetClipJoin for a length change", () => {
    render(<Harness />);
    const slider = screen.getByRole("slider", { name: "Length" });
    fireEvent.input(slider, { target: { value: "30" } });
    fireEvent.change(slider, { target: { value: "30" } });
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c0",
      "c1",
      "fade",
      30,
    );
  });

  it("Audition join plays the seam padded by JOIN_AUDITION_PAD_SEC", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Audition join" }));
    const s = useDawStore.getState();
    expect(s.playheadSec).toBe(4.25);
    expect(s.playUntilSec).toBe(5.75);
  });

  it("closes on an outside pointerdown, not inside the panel or on the anchor", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Anchor" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is read-only for a guest without edit", () => {
    useDawStore
      .getState()
      .hydrate(
        shareProjectKey("tok"),
        minimalProject({ tracks: [sampleTrack()] }),
        "view",
        ["view"],
      );
    render(<Harness />);
    expect(screen.queryByRole("group", { name: "Join mode" })).toBeNull();
  });

  it("shows a rejected SetClipJoin as an alert", async () => {
    vi.mocked(setClipJoin).mockRejectedValueOnce(new Error("nope"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Crossfade" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("places the panel with inline left/top px", () => {
    render(<Harness />);
    const panel = screen.getByRole("dialog");
    expect(panel.style.left).toMatch(/px$/);
    expect(panel.style.top).toMatch(/px$/);
  });

  it("has no axe violations", async () => {
    render(<Harness />);
    await expectNoA11yViolations(document.body);
  });
});
