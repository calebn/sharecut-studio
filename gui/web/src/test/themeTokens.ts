import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../styles/theme");

export type ThemeName = "dark" | "light" | "light-auto";

const read = (name: string) =>
  readFileSync(join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const LIGHT_MEDIA = "@media (prefers-color-scheme: light)";

function sources(theme: ThemeName): string[] {
  const brand = read("brand-tokens.css");
  const lightBrand = brand.indexOf(':root[data-theme="light"]');
  const brandMedia = brand.indexOf(LIGHT_MEDIA);
  const light = read("theme-light.css");
  const lightMedia = light.indexOf(LIGHT_MEDIA);
  const primitives = read("primitives.css");
  switch (theme) {
    case "dark":
      return [primitives, brand.slice(0, lightBrand), read("theme-dark.css")];
    case "light":
      return [
        primitives,
        brand.slice(lightBrand, brandMedia),
        light.slice(0, lightMedia),
      ];
    case "light-auto":
      return [primitives, brand.slice(brandMedia), light.slice(lightMedia)];
  }
}

/** The theme's custom properties as declared, later declarations winning. */
export function themeTokens(theme: ThemeName): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const text of sources(theme)) {
    for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
      tokens.set(m[1], m[2].trim());
    }
  }
  return tokens;
}

/** A token's value with every custom-property reference followed down to its literal. */
export function resolveToken(
  tokens: ReadonlyMap<string, string>,
  name: string,
  depth = 0,
): string {
  const value = tokens.get(name);
  if (value == null || depth > 12) {
    throw new Error(`Unresolved token ${name}`);
  }
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolveToken(tokens, ref[1], depth + 1) : value;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (m == null) {
    throw new Error(`Not a #rrggbb color: ${hex}`);
  }
  const n = Number.parseInt(m[1], 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

/** WCAG 2.x contrast ratio of two #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
