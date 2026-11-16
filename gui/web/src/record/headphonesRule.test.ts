import { describe, expect, it } from "vitest";
import { headphonesRule, readHeadphonesEnv } from "./headphonesRule";

describe("headphonesRule", () => {
  it.each([
    ["iPhone portrait", true, 390, 844, "choice"],
    ["iPhone landscape", true, 844, 390, "choice"],
    ["Pixel portrait", true, 412, 915, "choice"],
    ["the widest phone short side", true, 599, 1200, "choice"],
    ["a 600 px short side", true, 600, 1200, "required"],
    ["iPad Mini", true, 768, 1024, "required"],
    ["Galaxy Tab S4", true, 712, 1138, "required"],
    ["an unfolded foldable", true, 884, 1104, "required"],
    ["a fine pointer on a phone-sized screen", false, 390, 844, "required"],
    ["a laptop", false, 1280, 800, "required"],
    [
      "a touch laptop with a fine primary pointer",
      false,
      1440,
      900,
      "required",
    ],
    ["a coarse pointer with a zero screen", true, 0, 0, "required"],
  ] as const)("%s", (_name, coarsePrimary, width, height, rule) => {
    expect(
      headphonesRule({
        coarsePrimary,
        screenShortSide: Math.min(width, height),
      }),
    ).toBe(rule);
  });
});

describe("readHeadphonesEnv", () => {
  const win = (
    matches: boolean | null,
    screen: { width: number; height: number },
  ) =>
    ({
      screen,
      matchMedia:
        matches === null
          ? undefined
          : (query: string) => ({
              matches: matches && query === "(pointer: coarse)",
            }),
    }) as unknown as Window;

  it("reads the primary pointer and the screen's short side", () => {
    expect(readHeadphonesEnv(win(true, { width: 844, height: 390 }))).toEqual({
      coarsePrimary: true,
      screenShortSide: 390,
    });
  });

  it("is not a phone without matchMedia or a screen", () => {
    expect(readHeadphonesEnv(win(null, { width: 0, height: 0 }))).toEqual({
      coarsePrimary: false,
      screenShortSide: 0,
    });
  });
});
