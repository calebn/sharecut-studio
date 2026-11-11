import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dbToY, gainToDb } from "../system/envelopeMath";
import { clipRow } from "../test/fixtures";
import { ClipGainDips } from "./ClipGainDips";

const LANE = 72;
const clip = clipRow({
  id: "c1",
  timeline_start: 0,
  timeline_end: 10,
  source_start: 0,
  fade_in_ms: 1000,
  fade_out_ms: 0,
});

const draw = (over: Partial<Parameters<typeof ClipGainDips>[0]> = {}) =>
  render(
    <ClipGainDips
      clips={[clip]}
      points={[]}
      start={0}
      pxPerSecond={20}
      width={400}
      height={LANE}
      {...over}
    />,
  );

const coords = (el: Element) =>
  el
    .getAttribute("points")!
    .split(" ")
    .map((pair) => pair.split(",").map(Number) as [number, number]);

const pathEnds = (el: Element) => {
  const points = coords(el.querySelector("polyline")!);
  return [points[0], points.at(-1)];
};

describe("ClipGainDips", () => {
  it("draws a clip's fade-in dashed, read-only, with the first dip labelled", () => {
    const { container } = draw({ points: [{ id: "p", time: 5, value: 1 }] });
    const dip = screen.getByTestId("clip-gain-dip");
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelectorAll("svg > :not(g)")).toHaveLength(0);
    expect(container.querySelectorAll("polyline")).toHaveLength(
      screen.getAllByTestId("clip-gain-dip").length,
    );
    expect(dip.querySelector("polyline")).toHaveAttribute(
      "stroke-dasharray",
      "3 2",
    );
    expect(screen.getByText("clip fade or mute")).toBeInTheDocument();
  });

  it("starts at the line's own floor, where the gain is 0", () => {
    draw();
    const [first] = coords(
      screen.getByTestId("clip-gain-dip").querySelector("polyline")!,
    );
    expect(first![1]).toBeCloseTo(dbToY(-60, LANE), 5);
  });

  it("follows the gain curve, not the chord, through a fade", () => {
    draw();
    const pts = coords(
      screen.getByTestId("clip-gain-dip").querySelector("polyline")!,
    );
    expect(pts.length).toBeGreaterThan(2);
    // Midway through the 1 s fade the gain is 0.5, which is -6 dB: far above the chord's midpoint.
    const mid = pts.find(([x]) => Math.abs(x - 10) < 0.6)!;
    const chord = (dbToY(-60, LANE) + dbToY(0, LANE)) / 2;
    expect(mid[1]).toBeLessThan(chord - 5);
    expect(mid[1]).toBeGreaterThan(dbToY(gainToDb(1), LANE));
  });

  it("culls a dip outside the window and labels the first one drawn", () => {
    const later = clipRow({
      id: "c2",
      timeline_start: 20,
      timeline_end: 30,
      source_start: 0,
      fade_in_ms: 1000,
      fade_out_ms: 0,
    });
    const view = draw({ clips: [clip, later], start: 19, width: 100 });
    expect(screen.getAllByTestId("clip-gain-dip")).toHaveLength(1);
    expect(screen.getAllByText("clip fade or mute")).toHaveLength(1);
    view.unmount();
    draw({ clips: [clip, later], start: 100, width: 100 });
    expect(screen.queryByTestId("clip-gain-dip")).toBeNull();
  });

  it("keeps coincident dips distinct while culling and restoring them on pan", () => {
    const withMutes = clipRow({
      id: "pan-clip",
      timeline_start: 0,
      timeline_end: 10,
      source_start: 0,
      fade_in_ms: 500,
      fade_out_ms: 0,
      mute_regions: [
        { start_s: 0, end_s: 1 },
        { start_s: 5, end_s: 6 },
      ],
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const view = render(
        <ClipGainDips
          clips={[withMutes]}
          points={[]}
          start={0}
          pxPerSecond={20}
          width={200}
          height={LANE}
        />,
      );
      const groupsAtStart = screen.getAllByTestId("clip-gain-dip");
      expect(groupsAtStart).toHaveLength(3);
      expect(groupsAtStart.map(pathEnds)).toEqual([
        [
          [0, 68],
          [10, 68],
        ],
        [
          [0, 68],
          [20, expect.closeTo(7.55, 2)],
        ],
        [
          [100, expect.closeTo(7.55, 2)],
          [120, expect.closeTo(7.55, 2)],
        ],
      ]);
      expect(screen.getAllByText("clip fade or mute")).toHaveLength(1);

      view.rerender(
        <ClipGainDips
          clips={[withMutes]}
          points={[]}
          start={4}
          pxPerSecond={20}
          width={200}
          height={LANE}
        />,
      );
      const pannedGroups = screen.getAllByTestId("clip-gain-dip");
      expect(pannedGroups).toHaveLength(1);
      expect(pathEnds(pannedGroups[0]!)).toEqual([
        [20, expect.closeTo(7.55, 2)],
        [40, expect.closeTo(7.55, 2)],
      ]);
      expect(screen.getAllByText("clip fade or mute")).toHaveLength(1);

      view.rerender(
        <ClipGainDips
          clips={[withMutes]}
          points={[]}
          start={0}
          pxPerSecond={20}
          width={200}
          height={LANE}
        />,
      );
      const restoredGroups = screen.getAllByTestId("clip-gain-dip");
      expect(restoredGroups).toHaveLength(3);
      expect(restoredGroups.map(pathEnds)).toEqual([
        [
          [0, 68],
          [10, 68],
        ],
        [
          [0, 68],
          [20, expect.closeTo(7.55, 2)],
        ],
        [
          [100, expect.closeTo(7.55, 2)],
          [120, expect.closeTo(7.55, 2)],
        ],
      ]);
      expect(screen.getAllByText("clip fade or mute")).toHaveLength(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps separate dips with identical bounds as separate rendered groups", () => {
    const sameBounds = clipRow({
      id: "same-bounds-clip",
      timeline_start: 0,
      timeline_end: 10,
      source_start: 0,
      fade_in_ms: 500,
      fade_out_ms: 0,
      mute_regions: [{ start_s: 0, end_s: 0.5 }],
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      draw({ clips: [sameBounds], width: 200 });
      const groups = screen.getAllByTestId("clip-gain-dip");
      expect(groups).toHaveLength(2);
      expect(groups.map(pathEnds)).toEqual([
        [
          [0, 68],
          [10, expect.closeTo(7.55, 2)],
        ],
        [
          [0, 68],
          [10, expect.closeTo(7.55, 2)],
        ],
      ]);
      expect(screen.getAllByText("clip fade or mute")).toHaveLength(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
