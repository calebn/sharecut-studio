import { describe, expect, it } from "vitest";
import { probeScript } from "./scriptScrollProbe";

describe("script scroll observation", () => {
  it("reads the measured element's current text on every scroll write and restores native geometry", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "getBoundingClientRect",
    );
    const body = document.createElement("div");
    const word = document.createElement("span");
    word.textContent = "before measurement";
    const probe = probeScript(body, 123);
    try {
      expect(body.getBoundingClientRect().height).toBe(200);
      expect(word.getBoundingClientRect().top).toBe(123);
      word.textContent = "after measurement";
      body.scrollTop = 42;
      word.textContent = "after first scroll";
      body.scrollTop = 64;
      expect(probe.calls).toEqual([
        ["after measurement", 42],
        ["after first scroll", 64],
      ]);
      probe.clear();
      expect(probe.calls).toEqual([]);
      expect(body.scrollTop).toBe(0);
    } finally {
      probe.restore();
    }
    expect(
      Object.getOwnPropertyDescriptor(
        Element.prototype,
        "getBoundingClientRect",
      ),
    ).toEqual(descriptor);
    expect(word.getBoundingClientRect().top).toBe(0);
  });
});
