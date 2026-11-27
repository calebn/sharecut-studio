import { describe, expect, it } from "vitest";
import { applyElementRate } from "./elementRate";

type Flags = HTMLAudioElement & {
  webkitPreservesPitch?: boolean;
  mozPreservesPitch?: boolean;
};

describe("applyElementRate", () => {
  it("sets the rate with every pitch flag on", () => {
    const el: Flags = new Audio();
    el.preservesPitch = false;
    applyElementRate(el, 1.5);
    expect(el.playbackRate).toBe(1.5);
    expect(el.defaultPlaybackRate).toBe(1.5);
    expect(el.preservesPitch).toBe(true);
    expect(el.webkitPreservesPitch).toBe(true);
    expect(el.mozPreservesPitch).toBe(true);
  });

  it("still sets the rate when a flag cannot be written", () => {
    const el = new Audio();
    Object.defineProperty(el, "preservesPitch", {
      get: () => true,
      set: () => {
        throw new Error("read only");
      },
    });
    applyElementRate(el, 2);
    expect(el.playbackRate).toBe(2);
  });

  it("is idempotent", () => {
    const el = new Audio();
    applyElementRate(el, 1.25);
    applyElementRate(el, 1.25);
    expect(el.playbackRate).toBe(1.25);
  });
});
