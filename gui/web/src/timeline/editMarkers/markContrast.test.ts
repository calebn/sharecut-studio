import { describe, expect, it } from "vitest";
import { partial, rule } from "../../test/cssRules";
import {
  contrastRatio,
  resolveToken,
  type ThemeName,
  themeTokens,
} from "../../test/themeTokens";
import type { EditType } from "../../utils/editMarkerRegistry";

const TYPES: readonly EditType[] = [
  "cut",
  "fade",
  "crossfade",
  "mute",
  "split",
];
const TIERS = ["narrow", "middle", "wide"] as const;
const THEMES: readonly ThemeName[] = ["dark", "light", "light-auto"];

describe("edit mark glyph contrast (WCAG 1.4.11)", () => {
  const css = partial("timeline.css");

  it.each(TIERS)(
    "draws the %s tier at full strength: size and stroke weight only",
    (tier) => {
      const tierRule =
        tier === "narrow" ? "" : rule(css, `.edit-mark[data-tier="${tier}"]`);
      expect(tierRule).not.toMatch(/opacity|--edit-mark-color|color:/);
      expect(rule(css, ".edit-mark-face")).not.toMatch(/opacity/);
      expect(rule(css, ".edit-mark-glyph")).not.toMatch(/opacity/);
    },
  );

  it("keeps every mark hue at 3:1 or better on the tag face in both themes", () => {
    for (const theme of THEMES) {
      const tokens = themeTokens(theme);
      const face = resolveToken(tokens, "--color-bg-overlay");
      for (const type of TYPES) {
        const glyph = resolveToken(tokens, `--color-mark-${type}`);
        expect(
          contrastRatio(glyph, face),
          `${theme} ${type}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("computes the WCAG ratio", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#2a9a8e", "#ffffff")).toBeCloseTo(3.44, 1);
  });
});
