import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COARSE_POINTER_MQ,
  HANDHELD_SHORT_SIDE_PX,
  isHandheldScreen,
  readHandheld,
} from "./handheldScreen";

afterEach(() => vi.unstubAllGlobals());

const rows: [string, boolean, number, number, boolean][] = [
  ["iPhone 13 portrait", true, 390, 844, true],
  ["iPhone 13 landscape", true, 844, 390, true],
  ["Pixel 7", true, 412, 915, true],
  ["Pixel 8 Pro", true, 448, 998, true],
  ["Galaxy S24 Ultra", true, 480, 1040, true],
  ["foldable cover screen", true, 360, 800, true],
  ["iPad mini", true, 744, 1133, false],
  ["iPad", true, 820, 1180, false],
  ["fine pointer at 390", false, 390, 844, false],
];

describe("isHandheldScreen", () => {
  it("names the threshold as the short viewport height", () => {
    expect(HANDHELD_SHORT_SIDE_PX).toBe(480);
  });

  it.each(rows)("%s", (_name, coarse, width, height, expected) => {
    expect(isHandheldScreen(coarse, width, height)).toBe(expected);
  });

  it("is false one pixel past the threshold", () => {
    expect(isHandheldScreen(true, 481, 900)).toBe(false);
  });
});

describe("readHandheld", () => {
  function stub(coarse: boolean, width: number, height: number) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === COARSE_POINTER_MQ && coarse,
      media: query,
    }));
    vi.stubGlobal("screen", { width, height });
  }

  it("reads the coarse query and the screen's short side, whatever the orientation", () => {
    stub(true, 844, 390);
    expect(readHandheld()).toBe(true);
    stub(true, 390, 844);
    expect(readHandheld()).toBe(true);
    stub(true, 1133, 744);
    expect(readHandheld()).toBe(false);
    stub(false, 390, 844);
    expect(readHandheld()).toBe(false);
  });

  it("is false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    expect(readHandheld()).toBe(false);
  });

  it("is false without a screen", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("screen", undefined);
    expect(readHandheld()).toBe(false);
  });
});
