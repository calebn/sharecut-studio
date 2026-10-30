import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  resolveToken,
  type ThemeName,
  themeTokens,
} from "../test/themeTokens";

const THEMES: readonly ThemeName[] = ["dark", "light", "light-auto"];
const GROUNDS = [
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
});
