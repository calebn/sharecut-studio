import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow } from "../test/fixtures";
import type { ClipRow } from "../types/project";
import { ClipBlock } from "./ClipBlock";
import { ClipBlockView } from "./ClipBlockView";
import { clipBlockGeometry } from "./clipBlockGeometry";
import { PIECE_CULL_MIN, visiblePieceRange } from "./visiblePieces";

type LayerProps = {
  mediaRef: string;
  mediaStartSec: number;
  clipLeftCss: number;
  clipWidthCss: number;
};

const layers = vi.hoisted(() => [] as LayerProps[]);

vi.mock("./WaveformLayer", () => ({
  WaveformLayer: (p: LayerProps) => {
    layers.push(p);
    return <div className="clip-waveform" data-media-ref={p.mediaRef} />;
  },
}));

const timing = (steps: { at: number; delta_sec: number }[]) => ({
  steps,
  method: "bleed_lag",
  micro_fade_ms: 10,
});

const untimed = clipRow({
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 6,
  timeline_start: 1,
  timeline_end: 7,
});

const hole: ClipRow = {
  ...untimed,
  timeline_end: 8,
  timing: timing([{ at: 2, delta_sec: 1 }]),
};

const holeAndSkip: ClipRow = {
  ...untimed,
  timeline_end: 7,
  timing: timing([
    { at: 2, delta_sec: 1 },
    { at: 4, delta_sec: -1 },
  ]),
};

const props = {
  trackId: "host",
  role: "dialogue",
  zoomPxPerSec: 50,
  color: "var(--color-clip-dialogue-0)",
  selected: false,
  mediaRef: "track:host",
  nextClip: null,
  neighborSourceLo: 0,
  neighborSourceHi: 10,
  rollPreview: null,
  onSelect: vi.fn(),
  onSelectClip: vi.fn(),
  onMovePreview: vi.fn(),
  onMoveCommit: vi.fn(),
  onMoveCancel: vi.fn(),
} as const;

function draw(clip: ClipRow, extra: Record<string, unknown> = {}) {
  layers.length = 0;
  const view = render(<ClipBlock {...props} {...extra} clip={clip} />);
  return { ...view, layers: [...layers] };
}

beforeEach(() => {
  useDawStore.setState({ project: null, projectPath: "" });
});

describe("ClipBlock waveform pieces", () => {
  it("keeps one layer for a clip with no timing", () => {
    const { container, layers: drawn } = draw(untimed);
    expect(drawn).toEqual([
      expect.objectContaining({
        mediaStartSec: 0,
        clipLeftCss: 50,
        clipWidthCss: 300,
      }),
    ]);
    expect(
      container.querySelectorAll('[data-testid$="waveform-piece"]'),
    ).toHaveLength(0);
  });

  it("draws one layer per piece and leaves the hole blank", () => {
    const { container, layers: drawn } = draw(hole);
    expect(drawn).toEqual([
      expect.objectContaining({
        mediaStartSec: 0,
        clipLeftCss: 50,
        clipWidthCss: 100,
      }),
      expect.objectContaining({
        mediaStartSec: 2,
        clipLeftCss: 200,
        clipWidthCss: 200,
      }),
    ]);
    const wrappers = container.querySelectorAll<HTMLElement>(
      '[data-testid$="waveform-piece"]',
    );
    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]!.style.left).toBe("0px");
    expect(wrappers[1]!.style.left).toBe("150px");
  });

  it("draws three layers across a hole and a skipped span", () => {
    const { layers: drawn } = draw(holeAndSkip);
    expect(drawn.map((l) => l.mediaStartSec)).toEqual([0, 2, 5]);
    expect(drawn.map((l) => l.clipLeftCss)).toEqual([50, 200, 300]);
    expect(drawn.map((l) => l.clipWidthCss)).toEqual([100, 100, 50]);
  });

  it("keeps a stem on one layer on the timeline clock", () => {
    const { layers: drawn } = draw(holeAndSkip, { mediaRef: "stem:host" });
    expect(drawn).toEqual([
      expect.objectContaining({
        mediaRef: "stem:host",
        mediaStartSec: 1,
        clipLeftCss: 50,
        clipWidthCss: 300,
      }),
    ]);
  });

  it("sizes the clip block to its timeline length", () => {
    const { container } = draw(hole);
    const block = container.querySelector<HTMLElement>(".clip-block");
    expect(block?.style.width).toBe("350px");
  });

  it("splits a mute region across the pieces it spans", () => {
    const { container } = draw({
      ...hole,
      mute_regions: [{ start_s: 1.5, end_s: 2.5 }],
    });
    const spans = container.querySelectorAll<HTMLElement>(".clip-mute-region");
    expect([...spans].map((s) => [s.style.left, s.style.width])).toEqual([
      ["75px", "25px"],
      ["150px", "25px"],
    ]);
  });

  it("puts a clipping tint past a hole where the timeline plays it", () => {
    const { container } = draw({
      ...hole,
      clipping_regions: [{ start_s: 3, end_s: 3.5 }],
    });
    const tint = container.querySelector<HTMLElement>(".clip-clipping-region");
    expect(tint?.style.left).toBe("200px");
  });
});

describe("ClipBlock with many pieces", () => {
  const manyPieces = (count: number): ClipRow => ({
    ...untimed,
    source_start: 0,
    source_end: count,
    timeline_end: 1 + count + (count - 1) * 0.5,
    timing: timing(
      Array.from({ length: count - 1 }, (_, i) => ({
        at: i + 1,
        delta_sec: 0.5,
      })),
    ),
  });
  const mounted = (count: number, scrollLeft: number) => {
    useDawStore.setState({ scrollLeft, timelineViewportWidth: 100 });
    return draw(manyPieces(count)).layers.map((l) => l.mediaStartSec);
  };

  it.each([19, 20])("mounts every piece of %i", (count) => {
    expect(mounted(count, 0)).toEqual(
      Array.from({ length: count }, (_, i) => i),
    );
  });

  it("starts culling at 21 pieces and keeps the visible run", () => {
    const starts = mounted(21, 0);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.length).toBeLessThan(21);
    expect(starts).toEqual(Array.from({ length: starts.length }, (_, i) => i));
  });

  it("mounts every piece before the viewport is measured", () => {
    useDawStore.setState({ scrollLeft: 0, timelineViewportWidth: 0 });
    expect(draw(manyPieces(60)).layers).toHaveLength(60);
  });

  it("follows the scroll position", () => {
    const starts = mounted(60, 1500);
    expect(starts[0]).toBeGreaterThan(0);
    expect(starts.at(-1)).toBeLessThan(59);
    expect(starts).toEqual(
      Array.from({ length: starts.length }, (_, i) => starts[0]! + i),
    );
  });
});

describe("ClipBlockView snap ticks on a timed clip", () => {
  it("puts a tick past the hole where the timeline plays it", () => {
    const geometry = clipBlockGeometry({
      clip: hole,
      zoomPxPerSec: 50,
      rollPreview: null,
      trimPreview: null,
      fadePreview: null,
      previewTimelineStart: null,
    });
    const { container } = render(
      <ClipBlockView
        clip={hole}
        {...{ role: "dialogue" }}
        zoomPxPerSec={50}
        color="var(--color-clip-dialogue-0)"
        selected={false}
        geometry={geometry}
        nextClip={null}
        showHandles={false}
        snapTicks={[1, 3]}
      />,
    );
    const ticks = [
      ...container.querySelectorAll<HTMLElement>(".clip-waveform-snap"),
    ];
    expect(ticks.map((t) => t.style.left)).toEqual(["50px", "200px"]);
  });
});

describe("visiblePieceRange", () => {
  const pieces = Array.from({ length: PIECE_CULL_MIN * 5 }, (_, i) => ({
    srcA: i,
    srcB: i + 1,
    tlA: i,
  }));
  const view = { pieces, leftCss: 0, zoom: 10 };

  it("keeps the pieces within a viewport of the view", () => {
    expect(
      visiblePieceRange({ ...view, scrollLeft: 500, viewportWidth: 100 }),
    ).toEqual([39, 70]);
  });

  it("is empty for a view far from the clip", () => {
    const [lo, hi] = visiblePieceRange({
      ...view,
      scrollLeft: 50000,
      viewportWidth: 100,
    });
    expect(hi).toBeLessThan(lo);
  });
});
