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

const rule = (selector: string) =>
  css.slice(
    css.indexOf(`${selector} {`),
    css.indexOf("}", css.indexOf(`${selector} {`)),
  );

const idle = rule(".sys-headphones-choice > .ui-control");
const pressed = rule(
  '.sys-headphones-choice > .ui-control[aria-pressed="true"]',
);
const token = (block: string, prop: string) =>
  new RegExp(`${prop}:[^;]*var\\((--[\\w-]+)\\)`).exec(block)?.[1] ?? "";

describe("headphones choice buttons", () => {
  it.each<ThemeName>(["light", "dark"])(
    "keep both answers at full text contrast and mark the pressed one by %s border, check and weight",
    (theme) => {
      const tokens = themeTokens(theme);
      const at = (name: string) => resolveToken(tokens, name);
      const surface = at("--color-bg-overlay");
      const text = at(token(idle, "color"));
      expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(at(token(idle, "border")), surface),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(at(token(pressed, "border-color")), surface),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(text, at(token(pressed, "background"))),
      ).toBeGreaterThanOrEqual(4.5);
      expect(pressed).toContain("font-weight: 600");
    },
  );
});
