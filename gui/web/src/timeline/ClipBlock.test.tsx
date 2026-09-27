import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rollClipJoin, setClipFade, trimClipEdge } from "../api";
import type { ClipRow } from "../types/project";
import { ClipBlock } from "./ClipBlock";

type LayerProps = {
  mediaRef: string;
  kind: string;
  mediaStartSec: number;
  clipLeftCss: number;
  clipWidthCss: number;
  zoom: number;
  colorVar: string;
};

const layers = vi.hoisted(() => [] as LayerProps[][]);

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  rollClipJoin: vi.fn(async () => undefined),
  trimClipEdge: vi.fn(async () => undefined),
  setClipFade: vi.fn(async () => undefined),
}));

// The layer is tested in WaveformLayer.test.tsx; here, what the clip gives it.
vi.mock("./WaveformLayer", () => ({
  WaveformLayer: (p: LayerProps) => {
    layers.at(-1)?.push(p);
    return <div className="clip-waveform" data-media-ref={p.mediaRef} />;
  },
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

describe("ClipBlock waveform", () => {
  beforeEach(() => {
    layers.push([]);
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
    mediaRef: "track:host",
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

  it("draws its media from the clip's left edge in timeline px", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          source_start: 3,
          source_end: 5,
          timeline_start: 1,
          timeline_end: 3,
        }}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(container.querySelector(".clip-waveform")).toBeTruthy();
    expect(layers.at(-1)!.at(-1)).toEqual({
      mediaRef: "track:host",
      kind: "raw",
      mediaStartSec: 3,
      clipLeftCss: 50,
      clipWidthCss: 100,
      zoom: 50,
      colorVar: "var(--clip-dialogue-0)",
    });
  });

  it("puts stem media on the timeline clock", () => {
    render(
      <ClipBlock
        {...base}
        mediaRef="stem:host"
        clip={{
          ...clip,
          source_start: 3,
          source_end: 5,
          timeline_start: 1,
          timeline_end: 3,
        }}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(layers.at(-1)!.at(-1)).toMatchObject({
      mediaRef: "stem:host",
      kind: "stem",
      mediaStartSec: 1,
    });
  });

  it("gives zero-length fade handles no contradictory start/end class", () => {
    const { container } = render(<ClipBlock {...base} />);
    for (const which of ["in", "out"]) {
      const handle = container.querySelector(
        `button.fade-handle-zero.${which}`,
      ) as HTMLElement;
      expect(handle).toBeTruthy();
      expect(handle.classList.contains("start")).toBe(false);
      expect(handle.classList.contains("end")).toBe(false);
      // Blade mode's cursor rule targets .fade-handle.
      expect(handle.classList.contains("fade-handle")).toBe(true);
    }
  });

  it("hides only the fades at a cut join and keeps trim and roll", () => {
    const faded = { ...clip, fade_in_ms: 20, fade_out_ms: 20 };
    const prev = { ...clip, id: "c0" };
    const { container, rerender } = render(
      <ClipBlock {...base} clip={faded} prevClip={prev} />,
    );
    expect(container.querySelectorAll(".fade-region")).toHaveLength(2);
    // Incoming join is a cut: the fade-in goes, the fade-out stays.
    rerender(
      <ClipBlock
        {...base}
        clip={{ ...faded, join_in_mode: "cut", join_left_clip_id: "c0" }}
        prevClip={prev}
      />,
    );
    expect(container.querySelector(".fade-in-region")).toBeNull();
    expect(container.querySelector(".fade-out-region")).not.toBeNull();
    expect(container.querySelectorAll(".trim-handle")).toHaveLength(2);
    expect(container.querySelector("button.join-diamond")).not.toBeNull();
    // Outgoing join is a cut: the fade-out goes, the fade-in stays.
    rerender(
      <ClipBlock
        {...base}
        clip={faded}
        prevClip={prev}
        nextClip={{
          ...clip,
          id: "c2",
          join_in_mode: "cut",
          join_left_clip_id: "c1",
        }}
      />,
    );
    expect(container.querySelector(".fade-out-region")).toBeNull();
    expect(container.querySelector(".fade-in-region")).not.toBeNull();
    expect(container.querySelectorAll(".trim-handle")).toHaveLength(2);
  });

  it("keeps a first clip's fade-in when its leftover mode is cut", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          fade_in_ms: 20,
          join_in_mode: "cut",
          join_left_clip_id: null,
        }}
        prevClip={null}
      />,
    );
    expect(container.querySelector(".fade-in-region")).not.toBeNull();
  });

  describe("fade handle drags", () => {
    const dragIn = (
      dxPx: number,
      props: { fadeMaxMs?: number | null; clip?: ClipRow } = {},
    ) => {
      const view = render(<ClipBlock {...base} {...props} />);
      const handle = view.container.querySelector(
        "button.fade-handle-zero.in",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 100 + dxPx, pointerId: 3 });
      return { ...view, handle };
    };

    beforeEach(() => {
      vi.mocked(setClipFade).mockClear();
    });

    it("clamps to the track cap, shows it live and commits it", async () => {
      const { container, handle } = dragIn(25, { fadeMaxMs: 40 });
      expect(handle.isConnected).toBe(true);
      expect(container.querySelector(".fade-readout.in")?.textContent).toBe(
        "40 ms",
      );
      fireEvent.pointerUp(handle, { clientX: 125, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          40,
          0,
        ),
      );
      expect(container.querySelector(".fade-readout")).toBeNull();
      expect(container.querySelector(".clip-block.fade-dragging")).toBeNull();
    });

    it("clamps an uncapped track to the clip length", async () => {
      const { handle } = dragIn(250);
      fireEvent.pointerUp(handle, { clientX: 350, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          2000,
          0,
        ),
      );
    });

    it("never saves a click under the drag threshold", async () => {
      const { container, handle } = dragIn(1);
      fireEvent.pointerUp(handle, { clientX: 101, pointerId: 3 });
      await new Promise((r) => setTimeout(r, 0));
      expect(setClipFade).not.toHaveBeenCalled();
      expect(container.querySelector(".fade-readout")).toBeNull();
    });

    it("drags a committed fade to zero from its region handle", async () => {
      const { container } = render(
        <ClipBlock {...base} clip={{ ...clip, fade_in_ms: 40 }} />,
      );
      const handle = container.querySelector(
        ".fade-in-region .fade-handle",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 0, pointerId: 3 });
      expect(handle.isConnected).toBe(true);
      expect(container.querySelector(".fade-readout.in")?.textContent).toBe(
        "0 ms",
      );
      fireEvent.pointerUp(handle, { clientX: 0, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(expect.anything(), "c1", 0, 0),
      );
      expect(container.querySelector(".fade-readout")).toBeNull();
    });

    it("keeps the two fades from overlapping", async () => {
      const { container, handle } = dragIn(100, {
        clip: { ...clip, fade_out_ms: 1500 },
      });
      expect(container.querySelector(".fade-readout.in")?.textContent).toBe(
        "500 ms",
      );
      fireEvent.pointerUp(handle, { clientX: 200, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          500,
          1500,
        ),
      );
    });

    it("writes nothing when a drag leaves the fade at the cap", async () => {
      const { container } = render(
        <ClipBlock
          {...base}
          fadeMaxMs={40}
          clip={{ ...clip, fade_in_ms: 40 }}
        />,
      );
      const handle = container.querySelector(
        ".fade-in-region .fade-handle",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 110, pointerId: 3 });
      fireEvent.pointerUp(handle, { clientX: 110, pointerId: 3 });
      await new Promise((r) => setTimeout(r, 0));
      expect(setClipFade).not.toHaveBeenCalled();
    });

    it("discards a drag that comes back to within 3 px of its start", async () => {
      const { container, handle } = dragIn(25);
      fireEvent.pointerMove(handle, { clientX: 101, pointerId: 3 });
      fireEvent.pointerUp(handle, { clientX: 101, pointerId: 3 });
      await new Promise((r) => setTimeout(r, 0));
      expect(setClipFade).not.toHaveBeenCalled();
      expect(container.querySelector(".fade-readout")).toBeNull();
    });

    it("shows and commits the out-edge readout", async () => {
      const { container } = render(<ClipBlock {...base} fadeMaxMs={40} />);
      const handle = container.querySelector(
        "button.fade-handle-zero.out",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 75, pointerId: 3 });
      expect(container.querySelector(".fade-readout.out")?.textContent).toBe(
        "40 ms",
      );
      expect(handle.isConnected).toBe(true);
      fireEvent.pointerUp(handle, { clientX: 75, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          0,
          40,
        ),
      );
    });

    it("names each fade handle with its length", () => {
      const { container } = render(
        <ClipBlock {...base} clip={{ ...clip, fade_out_ms: 30 }} />,
      );
      const zeroIn = container.querySelector(
        "button.fade-handle-zero.in",
      ) as HTMLElement;
      expect(zeroIn.getAttribute("aria-label")).toMatch(/ · in 0 ms$/);
      const regionOut = container.querySelector(
        ".fade-out-region .fade-handle",
      ) as HTMLElement;
      expect(regionOut.getAttribute("aria-label")).toMatch(/ · out 30 ms$/);
    });
  });

  describe("trim and roll handle clicks", () => {
    beforeEach(() => {
      vi.mocked(trimClipEdge).mockClear();
      vi.mocked(rollClipJoin).mockClear();
    });

    it("a click on a trim handle only selects", async () => {
      const onSelect = vi.fn();
      const { container } = render(<ClipBlock {...base} onSelect={onSelect} />);
      const h = container.querySelector(".trim-handle.out") as HTMLElement;
      fireEvent.pointerDown(h, { clientX: 100, pointerId: 5 });
      fireEvent.pointerUp(h, { clientX: 101, pointerId: 5 });
      await new Promise((r) => setTimeout(r, 0));
      expect(onSelect).toHaveBeenCalledWith("c1");
      expect(trimClipEdge).not.toHaveBeenCalled();
    });

    it("commits a trim drag", async () => {
      const { container } = render(<ClipBlock {...base} />);
      const h = container.querySelector(".trim-handle.out") as HTMLElement;
      fireEvent.pointerDown(h, { clientX: 100, pointerId: 5 });
      fireEvent.pointerMove(h, { clientX: 150, pointerId: 5 });
      fireEvent.pointerUp(h, { clientX: 150, pointerId: 5 });
      await waitFor(() =>
        expect(trimClipEdge).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          "out",
          expect.any(Number),
        ),
      );
    });

    it("a click on the join diamond never rolls", async () => {
      const { container } = render(
        <ClipBlock {...base} prevClip={{ ...clip, id: "c0" }} />,
      );
      const d = container.querySelector("button.join-diamond") as HTMLElement;
      fireEvent.pointerDown(d, { clientX: 100, pointerId: 6 });
      fireEvent.pointerUp(d, { clientX: 101, pointerId: 6 });
      await new Promise((r) => setTimeout(r, 0));
      expect(rollClipJoin).not.toHaveBeenCalled();
    });
  });

  it("gives the trim ghost its own layer over the ghost source range", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const handle = container.querySelector(".trim-handle.out");
    expect(handle).toBeTruthy();
    fireEvent.pointerDown(handle as Element, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle as Element, { clientX: 150, pointerId: 1 });
    // The clip sits at x 0; its ghost follows the committed width.
    const rendered = layers.at(-1)!;
    const ghost = rendered.findLast((p) => p.clipLeftCss > 0);
    const main = rendered.findLast((p) => p.clipLeftCss === 0);
    // The ghost follows the committed clip (2 s at 50 px/s) and starts at
    // its source end.
    expect(
      container.querySelector(".clip-trim-ghost .clip-waveform"),
    ).toBeTruthy();
    // The committed clip is 100 px wide; the ghost's border box starts at its
    // edge, 1px left of padding-box x 100.
    expect(
      (container.querySelector(".clip-trim-ghost") as HTMLElement).style.left,
    ).toBe("99px");
    expect(ghost).toMatchObject({
      mediaStartSec: clip.source_end,
      clipLeftCss: 100,
    });
    expect(ghost!.clipWidthCss).toBeGreaterThan(0);
    expect(main!.mediaStartSec).toBe(clip.source_start);
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
    expect(onSelectClip).toHaveBeenCalledWith("c1", {
      shift: false,
      mod: false,
    });
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
    expect(onMoveCommit.mock.calls[0]?.[0]).toBe("c1");
    expect(onMoveCommit.mock.calls[0]?.[1].deltaSec).toBeCloseTo(0.8, 5);
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
    expect(onSelectClip).toHaveBeenCalledWith("c1", {
      shift: true,
      mod: false,
    });
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

  it("tints the span where the recording clipped", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          source_start: 0,
          source_end: 2,
          clipping_regions: [
            { start_s: 0.5, end_s: 1.0 },
            { start_s: 5, end_s: 6 },
          ],
        }}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const tints = container.querySelectorAll(".clip-clipping-region");
    expect(tints).toHaveLength(1);
    expect(tints[0]?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps trim-handle drags off the body-move path", () => {
    const onMovePreview = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
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

  it("shows clip times to the millisecond in its tooltip", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          timeline_start: 1.23456,
          timeline_end: 3.23456,
        }}
      />,
    );
    const block = container.querySelector(".clip-block") as HTMLElement;
    expect(block.title).toContain("(1.235–3.235s)");
  });

  describe("join roll", () => {
    const prevClip: ClipRow = {
      ...clip,
      id: "c0",
      source_start: 0,
      source_end: 2,
      timeline_start: 0,
      timeline_end: 2,
    };
    const right: ClipRow = {
      ...clip,
      source_start: 4,
      source_end: 6,
      timeline_start: 2,
      timeline_end: 4,
    };
    const rollBy = (zoom: number, dxPx: number) => {
      const { container } = render(
        <ClipBlock
          {...base}
          clip={right}
          prevClip={prevClip}
          leftNeighborSourceEnd={0}
          zoomPxPerSec={zoom}
        />,
      );
      const diamond = container.querySelector(
        "button.join-diamond",
      ) as HTMLElement;
      fireEvent.pointerDown(diamond, { clientX: 100, pointerId: 7 });
      fireEvent.pointerUp(diamond, { clientX: 100 + dxPx, pointerId: 7 });
    };

    beforeEach(() => {
      vi.mocked(rollClipJoin).mockClear();
    });

    it("commits a 3 px roll at deep zoom (a 62 µs join move)", async () => {
      rollBy(48000, 3);
      await waitFor(() => expect(rollClipJoin).toHaveBeenCalledTimes(1));
      const delta = vi.mocked(rollClipJoin).mock.calls[0]?.[3];
      expect(delta).toBeCloseTo(3 / 48000, 12);
    });

    it("skips a roll under the drag threshold", async () => {
      rollBy(50, 0.4);
      await new Promise((r) => setTimeout(r, 0));
      expect(rollClipJoin).not.toHaveBeenCalled();
    });
  });
});
