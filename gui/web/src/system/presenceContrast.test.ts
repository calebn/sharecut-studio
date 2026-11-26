import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  resolveToken,
  type ThemeName,
  themeTokens,
} from "../test/themeTokens";

const THEMES: readonly ThemeName[] = ["dark", "light", "light-auto"];
const GROUNDS = [
  "--color-timeline-well",
  "--color-timeline-lane",
  "--color-bg-sunken",
  "--color-track-muted",
] as const;

describe("presence colour contrast (WCAG 1.4.11)", () => {
  it.each(THEMES)(
    "keeps all eight person colours at 3:1 on the lane in %s",
    (theme) => {
      const tokens = themeTokens(theme);
      for (const ground of GROUNDS) {
        const back = resolveToken(tokens, ground);
        for (let index = 0; index < 8; index++) {
          const name = `--color-presence-${index}`;
          expect(
            contrastRatio(resolveToken(tokens, name), back),
            `${theme} ${name} on ${ground}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );

  it.each(THEMES)(
    "keeps the initial's ink at 4.5:1 on each person colour in %s",
    (theme) => {
      const tokens = themeTokens(theme);
      const ink = resolveToken(tokens, "--color-bg-canvas");
      for (let index = 0; index < 8; index++) {
        const name = `--color-presence-${index}`;
        expect(
          contrastRatio(ink, resolveToken(tokens, name)),
          `${theme} initial on ${name}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(THEMES)(
    "keeps the group flag's border at 3:1 on the ruler well and its count at 4.5:1 on its fill in %s",
    (theme) => {
      const tokens = themeTokens(theme);
      const border = resolveToken(tokens, "--color-border-strong");
      const well = resolveToken(tokens, "--color-timeline-well");
      expect(
        contrastRatio(border, well),
        `${theme} border`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(
          resolveToken(tokens, "--color-text-primary"),
          resolveToken(tokens, "--color-bg-elevated"),
        ),
        `${theme} count`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});
