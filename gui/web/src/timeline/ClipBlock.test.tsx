import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipRow, PeaksData } from "../types/project";
import { ClipBlock } from "./ClipBlock";

const paint = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useClipWaveform", () => ({
  useClipWaveform: () => ({
    window: {
      cssWidth: 100,
      canvasLeft: 0,
      sourceStart: 0,
      sourceEnd: 2,
      offscreen: false,
    },
    quiet: [],
    ticks: [],
    paint,
  }),
}));
vi.mock("../state/useDaw", () => ({
  useDaw: () => ({
    projectPath: "/tmp/p.json",
    setProject: vi.fn(),
    scrollLeft: 0,
    playheadSec: 0,
    waveformAmpZoom: 1,
    auditionMode: "raw",
    guestMode: null,
    shareCapabilities: null,
    pointerTrackId: null,
    measureTimelineViewport: () => 800,
  }),
}));

const clip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 2,
  timeline_start: 0,
  timeline_end: 2,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
};

const peaks: PeaksData = {
  peaks: [0.2, 0.8, 0.4, 0.9, 0.3],
  samples_per_pixel: 512,
  sample_rate: 8000,
};

describe("ClipBlock waveform", () => {
  beforeEach(() => {
    paint.mockClear();
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  const base = {
    clip,
    trackId: "host",
    role: "dialogue",
    zoomPxPerSec: 50,
    color: "var(--clip-dialogue-0)",
    selected: false,
    peaks: null,
    prevClip: null,
    nextClip: null,
    neighborSourceLo: 0,
    neighborSourceHi: 10,
    leftNeighborSourceEnd: 0,
    mediaDurationSec: 10,
    rollPreview: null,
    onRollPreview: vi.fn(),
    onSelect: vi.fn(),
    onHit: vi.fn(),
    onSelectClip: vi.fn(),
    onMovePreview: vi.fn(),
    onMoveCommit: vi.fn(),
    onMoveCancel: vi.fn(),
  } as const;

  it("renders clip-waveform canvas for visible clips", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        peaks={peaks}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(container.querySelector("canvas.clip-waveform")).toBeTruthy();
  });

  it("still renders a waveform canvas when overview peaks are missing", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        peaks={null}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(container.querySelector("canvas.clip-waveform")).toBeTruthy();
  });

  it("paints the trim ghost with the ghost source range", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        peaks={peaks}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const handle = container.querySelector(".trim-handle.out");
    expect(handle).toBeTruthy();
    fireEvent.pointerDown(handle as Element, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle as Element, { clientX: 150, pointerId: 1 });
    const ghostCalls = paint.mock.calls.filter(
      (args) => args[1] != null && typeof args[1] === "object",
    );
    expect(ghostCalls.length).toBeGreaterThan(0);
    const override = ghostCalls[ghostCalls.length - 1]?.[1] as {
      sourceStart: number;
      sourceEnd: number;
      cssWidth: number;
    };
    expect(override.sourceStart).toBe(clip.source_end);
    expect(override.sourceEnd).toBeGreaterThan(clip.source_end);
    expect(override.cssWidth).toBeGreaterThan(0);
  });

  it("selects on body pointerdown without moving when under the drag threshold", () => {
    const onSelectClip = vi.fn();
    const onMovePreview = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelectClip={onSelectClip}
        onMovePreview={onMovePreview}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 40, clientY: 10, pointerId: 2 });
    fireEvent.pointerMove(hit, { clientX: 42, clientY: 10, pointerId: 2 });
    fireEvent.pointerUp(hit, { clientX: 42, clientY: 10, pointerId: 2 });
    expect(onSelectClip).toHaveBeenCalledWith({ shift: false, mod: false });
    expect(onMovePreview).not.toHaveBeenCalled();
  });

  it("starts a body move after crossing the pixel threshold", () => {
    const onMovePreview = vi.fn();
    const onMoveCommit = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelectClip={vi.fn()}
        onMovePreview={onMovePreview}
        onMoveCommit={onMoveCommit}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 40, clientY: 10, pointerId: 3 });
    fireEvent.pointerMove(hit, { clientX: 80, clientY: 10, pointerId: 3 });
    expect(onMovePreview).toHaveBeenCalled();
    fireEvent.pointerUp(hit, { clientX: 80, clientY: 10, pointerId: 3 });
    expect(onMoveCommit).toHaveBeenCalled();
    expect(onMoveCommit.mock.calls[0]?.[0].deltaSec).toBeCloseTo(0.8, 5);
  });

  it("does not body-move in blade mode", () => {
    const onMovePreview = vi.fn();
    const onHit = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        bladeMode
        onMovePreview={onMovePreview}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={onHit}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 40, clientY: 10, pointerId: 4 });
    fireEvent.pointerMove(hit, { clientX: 90, clientY: 10, pointerId: 4 });
    fireEvent.click(hit, { clientX: 90 });
    expect(onMovePreview).not.toHaveBeenCalled();
    expect(onHit).toHaveBeenCalled();
  });

  it("selects from a click when pointerdown never ran", () => {
    const onSelectClip = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelectClip={onSelectClip}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.click(hit, { shiftKey: true });
    expect(onSelectClip).toHaveBeenCalledWith({ shift: true, mod: false });
    expect(hit.getAttribute("aria-label")).toBe("Select clip c1");
  });

  it("cancels a body drag on lost pointer capture", () => {
    const onMovePreview = vi.fn();
    const onMoveCommit = vi.fn();
    const onMoveCancel = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelectClip={vi.fn()}
        onMovePreview={onMovePreview}
        onMoveCommit={onMoveCommit}
        onMoveCancel={onMoveCancel}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 40, clientY: 10, pointerId: 7 });
    fireEvent.pointerMove(hit, { clientX: 80, clientY: 10, pointerId: 7 });
    expect(onMovePreview).toHaveBeenCalled();
    fireEvent.lostPointerCapture(hit, { pointerId: 7 });
    expect(onMoveCancel).toHaveBeenCalled();
    expect(onMoveCommit).not.toHaveBeenCalled();
  });

  it("a touch hold selects once on pointerdown and never moves or reselects", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const onSelectClip = vi.fn();
    const onMoveCommit = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelect={onSelect}
        onSelectClip={onSelectClip}
        onMoveCommit={onMoveCommit}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    const touch = { pointerType: "touch", isPrimary: true, pointerId: 8 };
    fireEvent.pointerDown(hit, { ...touch, clientX: 40, clientY: 10 });
    vi.advanceTimersByTime(700);
    fireEvent.pointerUp(hit, { ...touch, clientX: 42, clientY: 10 });
    fireEvent.lostPointerCapture(hit, { pointerId: 8 });
    fireEvent.click(hit);
    vi.runOnlyPendingTimers();
    expect(onSelectClip).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMoveCommit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("hides ghost clips from the accessibility tree", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        interactive={false}
        prevClip={clip}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(
      container.querySelector(".clip-block")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(container.querySelector(".join-diamond")).toBeNull();
    expect(container.querySelector(".clip-hit")).toBeNull();
  });

  it("paints applied mute regions on the clip", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          mute_regions: [{ start_s: 0.5, end_s: 1.0 }],
        }}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(container.querySelector(".clip-mute-region")).toBeTruthy();
  });

  it("keeps trim-handle drags off the body-move path", () => {
    const onMovePreview = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        peaks={peaks}
        onMovePreview={onMovePreview}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const handle = container.querySelector(".trim-handle.out") as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 5 });
    fireEvent.pointerMove(handle, { clientX: 160, pointerId: 5 });
    expect(onMovePreview).not.toHaveBeenCalled();
  });
});
