import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

describe("ClipGainDips", () => {
  it("draws a clip's fade-in dashed, read-only, with the first dip labelled", () => {
    const { container } = draw();
    const dip = screen.getByTestId("clip-gain-dip");
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
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
});
