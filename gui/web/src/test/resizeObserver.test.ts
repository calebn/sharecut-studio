import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "./resizeObserver";

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FakeResizeObserver", () => {
  it("reports every watched target in one batch on a bare fire()", () => {
    const cb = vi.fn();
    const ro = new FakeResizeObserver(cb);
    const a = document.createElement("div");
    const b = document.createElement("div");
    ro.observe(a);
    ro.observe(b);

    ro.fire();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(
      cb.mock.calls[0][0].map((e: ResizeObserverEntry) => e.target),
    ).toEqual([a, b]);

    ro.fire(b, { contentRect: { width: 5 } as DOMRectReadOnly });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0]).toEqual([
      { target: b, contentRect: { width: 5 } },
    ]);
  });

  it("reports nothing on a bare fire() once disconnected", () => {
    const cb = vi.fn();
    const ro = new FakeResizeObserver(cb);
    ro.observe(document.createElement("div"));
    ro.disconnect();
    ro.fire();
    expect(cb).not.toHaveBeenCalled();
  });

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
