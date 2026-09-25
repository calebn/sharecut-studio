import { describe, expect, it } from "vitest";
import {
  dataTilesFor,
  drawLevel,
  heightDevice,
  pcmBlocksFor,
  placeholderMapping,
  rasterMode,
  renderScale,
  samplesPerDevicePx,
  styleKey,
  tileFrames,
  tileGroup,
  tileKey,
  tileOrigin,
  tileRect,
  visibleTileRange,
} from "./renderTiles";

describe("renderScale", () => {
  it.each([
    [1, 1, 512],
    [1.5, 1.5, 768],
    [2, 2, 1024],
    [3, 2, 1024],
    [1.33, 1.375, 704],
  ])("dpr %s paints at %s (%s device px per tile)", (dpr, d, tileDev) => {
    expect(renderScale(dpr)).toEqual({ d, tileDev });
    expect(Number.isInteger(tileDev)).toBe(true);
  });
});

describe("tileOrigin", () => {
  it("puts media time 0 at the clip's media start, snapped to device px", () => {
    // Media starts 10 s in at 50 px/s: time 0 is 500 css px left of the clip.
    expect(
      tileOrigin({ clipLeftCss: 200, mediaStartSec: 10, zoom: 50, dprReal: 1 }),
    ).toBe(-500);
    // 0.3 css px is 0.6 device px at dpr 2: snapped to 0.5 css px.
    const o = tileOrigin({
      clipLeftCss: 200.3,
      mediaStartSec: 10,
      zoom: 50,
      dprReal: 2,
    });
    expect(o + 200.3).toBeCloseTo(-299.5, 9);
    expect(
      tileOrigin({ clipLeftCss: 0, mediaStartSec: 1, zoom: 3, dprReal: 0 }),
    ).toBe(-3);
  });
});

describe("visibleTileRange", () => {
  it("covers the view plus 512 px overscan on each side, inside the clip", () => {
    // A 5000 px clip at x 1000, media from 0 (origin 0); view 3000..3800.
    expect(
      visibleTileRange({
        origin: 0,
        clipLeftCss: 1000,
        clipWidthCss: 5000,
        scrollLeft: 3000,
        viewportWidth: 800,
      }),
    ).toEqual([2, 6]);
  });

  it("is null off screen and starts at tile 0", () => {
    expect(
      visibleTileRange({
        origin: 0,
        clipLeftCss: 9000,
        clipWidthCss: 100,
        scrollLeft: 0,
        viewportWidth: 800,
      }),
    ).toBeNull();
    expect(
      visibleTileRange({
        origin: -700,
        clipLeftCss: 0,
        clipWidthCss: 300,
        scrollLeft: 0,
        viewportWidth: 800,
      }),
    ).toEqual([1, 1]);
  });
});

describe("tileRect", () => {
  it.each([1, 1.5, 2])("clips a partial first tile at dpr %s", (d) => {
    // Media starts 100 css px into tile 0: the canvas starts at the clip edge.
    const r = tileRect(0, -100, 1000, d)!;
    expect(r.left).toBe(0);
    expect(r.sx).toBe(100 * d);
    expect(r.sw).toBe(412 * d);
    expect(r.width).toBe(412);
  });

  it.each([1, 1.5, 2])("clips a partial last tile at dpr %s", (d) => {
    const r = tileRect(1, -100, 700.3, d)!;
    // L = 412; b = 700.3: sw rounds out to cover the fractional px.
    expect(r.sx).toBe(0);
    expect(r.left).toBe(412);
    expect(r.sw).toBe(Math.ceil(288.3 * d));
    expect(r.width).toBeCloseTo(Math.ceil(288.3 * d) / d, 9);
  });

  it("keeps a whole middle tile and snaps a fractional origin outward", () => {
    expect(tileRect(2, -100, 5000, 1.5)).toEqual({
      left: 924,
      width: 512,
      sx: 0,
      sw: 768,
    });
    const r = tileRect(0, -0.4, 1000, 1.5)!;
    expect(r.sx).toBe(0);
    expect(r.left).toBeCloseTo(-0.4, 9);
  });

  it("is null outside the clip", () => {
    expect(tileRect(5, 0, 1000, 1)).toBeNull();
    expect(tileRect(0, -600, 1000, 1)).toBeNull();
  });
});

describe("keys and modes", () => {
  const id = {
    mediaKey: "abc",
    zoom: 40.123456789123,
    d: 2,
    heightDev: 144,
    styleKey: "s",
    ampZoom: 1.5,
  };

  it("keys tiles by media, zoom, dpr, height, style, amp and index", () => {
    expect(tileKey(id, 7)).toBe("abc|40.1234568|2|144|s|1.5|7");
    expect(tileGroup(id)).toBe("abc|s|144|2|1.5");
    expect(heightDevice(71.6, 1.5)).toBe(107);
    expect(
      styleKey({
        core: new Float32Array([1, 0.5, 0, 1]),
        edge: new Float32Array([1, 0.5, 0, 0.6]),
      }),
    ).toBe("1.0000,0.5000,0.0000,1.0000,1.0000,0.5000,0.0000,0.6000");
  });

  it("picks pyramid, pcm or line by samples per device px", () => {
    expect(rasterMode(64, 64, true)).toBe("pyramid");
    expect(rasterMode(10, 64, false)).toBe("pyramid");
    expect(rasterMode(10, 64, true)).toBe("pcm");
    expect(rasterMode(3.9, 64, true)).toBe("line");
    expect(samplesPerDevicePx(48000, 1000, 2)).toBe(24);
  });

  it("draws guests from level 0 below the pyramid", () => {
    const meta = {
      levels: [
        { spp: 64, bins: 10 },
        { spp: 256, bins: 3 },
      ],
    };
    expect(drawLevel(meta, 10)).toBe(0);
    expect(drawLevel(meta, 300)).toBe(1);
  });
});

describe("tile frames, data tiles and PCM blocks", () => {
  it("maps tile k to media frames", () => {
    expect(tileFrames(3, 48000, 512, 2)).toEqual({
      frameStart: 144000,
      frames: 48000,
      sppDev: 46.875,
      cols: 1024,
    });
  });

  it("lists the data tiles holding a tile's bins", () => {
    const meta = { bins_per_tile: 4096, levels: [{ spp: 64, bins: 10000 }] };
    expect(dataTilesFor(meta, 0, 0, 64 * 4096)).toEqual([0, 0]);
    expect(dataTilesFor(meta, 0, 64 * 4000, 64 * 200)).toEqual([0, 1]);
    expect(dataTilesFor(meta, 0, 64 * 20000, 64)).toBeNull();
  });

  it("lists the PCM blocks, one frame past the edge", () => {
    expect(pcmBlocksFor(0, 65535, 1e6)).toEqual([0, 0]);
    expect(pcmBlocksFor(0, 65536, 1e6)).toEqual([0, 1]);
    expect(pcmBlocksFor(0, 100, 1e6)).toEqual([0, 0]);
    expect(pcmBlocksFor(70000, 10, 70005)).toEqual([1, 1]);
    expect(pcmBlocksFor(80000, 10, 70000)).toBeNull();
  });
});

describe("placeholderMapping", () => {
  it("maps a coarser tile's overlap into the target tile", () => {
    // Source: tile 0 at 256 px/s (0..2 s, 512 device px). Target: tile 1 at
    // 512 px/s (1..2 s): the right half of the source fills the target.
    expect(
      placeholderMapping(
        { zoom: 256, tile: 0, width: 512 },
        { zoom: 512, tile: 1 },
      ),
    ).toEqual({ sx: 256, sw: 256, dx: 0, dw: 512 });
    expect(
      placeholderMapping(
        { zoom: 256, tile: 5, width: 512 },
        { zoom: 512, tile: 1 },
      ),
    ).toBeNull();
  });
});
