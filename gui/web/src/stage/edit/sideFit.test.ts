import { describe, expect, it } from "vitest";
import { lengthPx, type SideSizes, sideYield } from "./sideFit";

const rem = (n: number, root: number) => n * root;

function sizes(root: number, inlineRem: number): SideSizes {
  return {
    inlinePx: rem(inlineRem, root),
    lanePx: rem(22, root),
    headersPx: rem(11.25, root),
    scriptPx: rem(12, root),
    inspectorPx: rem(17.5, root),
    dividerPx: rem(0.5, root),
  };
}

describe("lengthPx", () => {
  it("resolves rem against the root size and passes px through", () => {
    expect(lengthPx("22rem", 24)).toBe(528);
    expect(lengthPx(" 0.5rem ", 16)).toBe(8);
    expect(lengthPx("12px", 24)).toBe(12);
  });

  it("is NaN for anything that is not a plain length", () => {
    expect(lengthPx("", 16)).toBeNaN();
    expect(lengthPx("calc(1rem + 2px)", 16)).toBeNaN();
  });
});

describe("sideYield", () => {
  it("keeps everything when the four sizes fit", () => {
    expect(sideYield(sizes(16, 63.25), true, false)).toBeNull();
    expect(sideYield(sizes(24, 63.25), true, false)).toBeNull();
  });

  it("yields the Script when the Inspector is open and they do not fit", () => {
    expect(sideYield(sizes(16, 63.2), true, false)).toBe("script");
  });

  it("tracks the root font size: the same window fits at 16px, not at 24px", () => {
    const window = 1280;
    const at = (root: number): SideSizes => ({
      ...sizes(root, 0),
      inlinePx: window,
    });
    expect(sideYield(at(16), true, false)).toBeNull();
    expect(sideYield(at(24), true, false)).toBe("script");
  });

  it("yields nothing while the Inspector is closed", () => {
    expect(sideYield(sizes(24, 30), false, false)).toBeNull();
  });

  it("yields the Inspector instead when Script has the focus", () => {
    expect(sideYield(sizes(16, 29), true, true)).toBe("inspector");
    expect(sideYield(sizes(16, 30), true, true)).toBeNull();
  });

  it("never yields on an unmeasured size", () => {
    expect(
      sideYield({ ...sizes(16, 10), inlinePx: 0 }, true, false),
    ).toBeNull();
    expect(
      sideYield({ ...sizes(16, 10), lanePx: Number.NaN }, true, false),
    ).toBeNull();
  });
});
