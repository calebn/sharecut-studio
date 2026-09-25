import { describe, expect, it, vi } from "vitest";
import { BitmapCache, type BitmapEntry, tileSeconds } from "./bitmapCache";

/** Each entry's bitmap `close` mock. */
const closes = new Map<BitmapEntry, ReturnType<typeof vi.fn>>();

function closeOf(e: BitmapEntry) {
  return closes.get(e)!;
}

function entry(
  over: Partial<BitmapEntry> & { zoom: number; tile: number },
): BitmapEntry {
  const close = vi.fn();
  const e: BitmapEntry = {
    bitmap: { close } as unknown as ImageBitmap,
    width: 10,
    height: 10,
    group: "g",
    provisional: false,
    ...over,
  };
  closes.set(e, close);
  return e;
}

describe("tileSeconds", () => {
  it("covers 512 css px of media per tile", () => {
    expect(tileSeconds(0, 512)).toEqual([0, 1]);
    expect(tileSeconds(3, 256)).toEqual([6, 8]);
  });
});

describe("BitmapCache", () => {
  it("evicts least recently used bitmaps past the budget and closes them", () => {
    const cache = new BitmapCache(() => 1000);
    const a = entry({ zoom: 10, tile: 0 });
    const b = entry({ zoom: 10, tile: 1 });
    const c = entry({ zoom: 10, tile: 2 });
    cache.set("a", a);
    cache.set("b", b);
    expect(cache.bytes).toBe(800);
    cache.get("a");
    cache.set("c", c);
    expect(cache.get("b")).toBeUndefined();
    expect(closeOf(b)).toHaveBeenCalledOnce();
    expect(closeOf(a)).not.toHaveBeenCalled();
    expect(cache.get("a")).toBe(a);
    cache.clear();
    expect(closeOf(a)).toHaveBeenCalledOnce();
    expect(closeOf(c)).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
  });

  it("closes a bitmap it replaces", () => {
    const cache = new BitmapCache(() => 1e6);
    const first = entry({ zoom: 10, tile: 0 });
    cache.set("k", first);
    cache.set("k", entry({ zoom: 10, tile: 0 }));
    expect(closeOf(first)).toHaveBeenCalledOnce();
  });

  it("never returns a provisional render as the exact hit", () => {
    const cache = new BitmapCache(() => 1e6);
    const prov = entry({ zoom: 10, tile: 0, provisional: true });
    cache.set("k", prov);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.placeholder("g", 10, 0)?.entry).toBe(prov);
    const exact = entry({ zoom: 10, tile: 0 });
    cache.set("k", exact);
    expect(cache.get("k")).toBe(exact);
    expect(closeOf(prov)).toHaveBeenCalledOnce();
  });

  it("stands in with the overlapping bitmap at the nearest zoom", () => {
    const cache = new BitmapCache(() => 1e6);
    // Tile 0 at 512 px/s covers 0..1 s; at 256 px/s, 0..2 s; at 1024, 0..0.5 s.
    const coarse = entry({ zoom: 256, tile: 0 });
    const fine = entry({ zoom: 1024, tile: 1 });
    const far = entry({ zoom: 600, tile: 9 });
    const other = entry({ zoom: 512, tile: 0, group: "other" });
    cache.set("coarse", coarse);
    cache.set("fine", fine);
    cache.set("far", far);
    cache.set("other", other);
    // Target: tile 0 at 512 (0..1 s). 256 and 1024 are equally near; the
    // finer one wins. Tile 9 at 600 (7.68..8.53 s) does not overlap.
    expect(cache.placeholder("g", 512, 0)).toEqual({
      entry: fine,
      startSec: 0.5,
      endSec: 1,
    });
    expect(cache.placeholder("g", 300, 0)?.entry).toBe(coarse);
    expect(cache.placeholder("g", 512, 40)).toBeNull();
    expect(cache.placeholder("none", 512, 0)).toBeNull();
  });

  it("forgets evicted bitmaps as placeholders", () => {
    const cache = new BitmapCache(() => 400);
    cache.set("a", entry({ zoom: 256, tile: 0 }));
    cache.set("b", entry({ zoom: 10, tile: 0, group: "h" }));
    expect(cache.placeholder("g", 512, 0)).toBeNull();
    cache.delete("b");
    expect(cache.size).toBe(0);
    cache.trim();
  });
});
