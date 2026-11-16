import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  resolveToken,
  type ThemeName,
  themeTokens,
} from "../test/themeTokens";

const css = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../styles/partials/system-record.css",
  ),
  "utf8",
);

describe("Join sheet still-to-do ring", () => {
  const ring =
    /\.sys-status\[data-state="queued"\] \.sys-glyph\s*\{\s*color:\s*var\((--[\w-]+)\)/.exec(
      css,
    );

  it("uses a color token", () => {
    expect(ring).not.toBeNull();
  });

  it.each<ThemeName>(["light", "dark"])(
    "reaches 3:1 against the sheet surface in %s",
    (theme) => {
      const tokens = themeTokens(theme);
      const ratio = contrastRatio(
        resolveToken(tokens, ring?.[1] ?? ""),
        resolveToken(tokens, "--color-bg-overlay"),
      );
      expect(ratio).toBeGreaterThanOrEqual(3);
    },
  );
});
