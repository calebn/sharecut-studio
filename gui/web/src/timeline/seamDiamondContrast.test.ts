import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  resolveToken,
  type ThemeName,
  themeTokens,
} from "../test/themeTokens";

const THEMES: readonly ThemeName[] = ["dark", "light", "light-auto"];

describe("Seam diamond contrast (WCAG 1.4.11)", () => {
  it("keeps the cut and split hues at 3:1 or better on the lane background in every theme", () => {
    for (const theme of THEMES) {
      const tokens = themeTokens(theme);
      const lane = resolveToken(tokens, "--color-timeline-lane");
      for (const type of ["cut", "split"]) {
        const hue = resolveToken(tokens, `--color-mark-${type}`);
        expect(
          contrastRatio(hue, lane),
          `${theme} ${type}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
