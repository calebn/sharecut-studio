import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinVisual } from "../edit/joinRender";
import { clipRow } from "../test/fixtures";
import { JoinBlend, type JoinWaveSides } from "./JoinBlend";

const layers = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
}));
vi.mock("./WaveformLayer", () => ({
  WaveformLayer: (props: Record<string, unknown>) => {
    layers.calls.push(props);
    return <div data-testid="layer" />;
  },
}));

const left = clipRow({ id: "l", source_end: 5 });
const right = (ms: number, extra = {}) =>
  clipRow({
    id: "r",
    source_start: 5,
    timeline_start: 5,
    join_in_mode: "crossfade",
    join_left_clip_id: "l",
    join_crossfade_ms: ms,
    ...extra,
  });
const waves: JoinWaveSides = {
  leftRef: "source:a",
  rightRef: "source:b",
  role: "dialogue",
  gainDb: -3,
};
function mount(row = right(200), zoom = 100) {
  return render(
    <JoinBlend
      visual={joinVisual(row, zoom)}
      left={left}
      right={row}
      waves={waves}
      zoomPxPerSec={zoom}
    />,
  );
}

describe("JoinBlend overlap waveforms", () => {
  beforeEach(() => {
    layers.calls = [];
  });

  it.each([
    [25, 5, 0],
    [39, 7.8, 0],
    [40, 8, 1],
    [100, 20, 1],
    [4000, 800, 1],
  ] as const)(
    "at %f px/s draws the 200 ms overlap %f px wide with %i X path",
    (zoom, widthPx, paths) => {
      const row = right(200);
      const { container } = render(
        <JoinBlend
          visual={joinVisual(row, zoom)}
          left={left}
          right={row}
          zoomPxPerSec={zoom}
        />,
      );
      const svg = container.querySelector<SVGElement>(".join-blend");
      expect(Number.parseFloat(svg?.style.width ?? "")).toBeCloseTo(widthPx, 9);
      expect(svg?.style.left).toBe(`${5 * zoom - widthPx / 2}px`);
      expect(container.querySelectorAll(".join-blend path")).toHaveLength(
        paths,
      );
    },
  );

  it("draws the left tail and right head across exactly the overlap box", () => {
    const { container } = mount();
    expect(container.querySelector(".join-blend-waves")).toHaveStyle({
      left: "490px",
      width: "20px",
    });
    expect(container.querySelector(".join-blend")).toHaveStyle({
      left: "490px",
      width: "20px",
    });
    expect(layers.calls).toHaveLength(2);
    const [l, r] = layers.calls;
    expect(l).toMatchObject({
      mediaRef: "source:a",
      kind: "raw",
      mediaStartSec: 4.9,
      clipLeftCss: 490,
      clipWidthCss: 20,
      colorVar: "join-blend-left",
      minWidthCss: 1,
      zoom: 100,
    });
    expect(r).toMatchObject({
      mediaRef: "source:b",
      mediaStartSec: 4.9,
      colorVar: "join-blend-right",
      minWidthCss: 1,
    });
  });

  it("follows a draft length through the same visual", () => {
    mount(right(400));
    expect(layers.calls[0]).toMatchObject({
      mediaStartSec: 4.8,
      clipWidthCss: 40,
    });
  });

  it("draws a one-device-pixel seam hairline below 1 css px and no layers", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { container } = mount(right(20), 20);
    const seam = container.querySelector<HTMLElement>(".join-blend-seam");
    expect(seam).toHaveAttribute("data-exact-px", "0.4");
    expect(seam).toHaveStyle({ width: "0.5px" });
    expect(seam?.children).toHaveLength(2);
    expect(container.querySelector(".join-blend-waves")).toBeNull();
    expect(layers.calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it.each([
    right(200, { join_in_mode: "fade" }),
    right(200, { join_crossfade_blocked: "no_headroom" }),
    right(0),
  ])("draws nothing for a non-blending join", (row) => {
    const { container } = mount(row);
    expect(container.innerHTML).toBe("");
  });
});
