import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "./resizeObserver";

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FakeResizeObserver", () => {
  it("of() finds the observer watching an element and throws when none does", () => {
    const watched = document.createElement("div");
    const ro = new FakeResizeObserver(vi.fn());
    ro.observe(watched);
    expect(FakeResizeObserver.of(watched)).toBe(ro);
    expect(() => FakeResizeObserver.of(document.createElement("span"))).toThrow(
      /no FakeResizeObserver watches <span/,
    );
  });
});
