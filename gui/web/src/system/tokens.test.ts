import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FROZEN } from "../test/frozenTokens";
import { themeTokens } from "../test/themeTokens";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../styles/theme");
const spec = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../docs/design/stages/design-system.md",
  ),
  "utf8",
);

/** A pixel size written in the design system, as rem at a 16px root. */
function specRem(pattern: RegExp): string {
  const match = pattern.exec(spec);
  if (!match) throw new Error(`design-system.md no longer says ${pattern}`);
  return `${Number(match[1]) / 16}rem`;
}

/** How selection looks (design system 4.8), read from the spec, not from the CSS. */
const SELECTION_FROM_SPEC: Readonly<Record<string, string>> = {
  "--selection-outline-width": specRem(
    /Selected object[^|]*\|\s*(\d+) px accent outline/,
  ),
  "--selection-row-edge-width": specRem(
    /accent-subtle fill[^|]*? with (\d+) px accent edges/,
  ),
  "--selection-remote-width": specRem(
    /Remote person's selection \|\s*(\d+) px outline/,
  ),
};

function declarations(file: string): Map<string, string[]> {
  const text = readFileSync(join(dir, file), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const out = new Map<string, string[]>();
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    const values = out.get(m[1]) ?? [];
    values.push(m[2].trim().replace(/\s+/g, " "));
    out.set(m[1], values);
  }
  return out;
}

const STAGE_LAYOUT: Readonly<Record<string, string>> = {
  "--app-header-height": "3rem",
  "--app-header-height-phone": "2.75rem",
  "--alert-slot-height": "2.75rem",
  "--script-pane-width": "25rem",
  "--script-pane-width-min": "20rem",
  "--script-pane-width-max": "40rem",
  "--script-pane-width-wide": "30rem",
  "--action-bar-height": "2.5rem",
  "--action-bar-height-touch": "2.75rem",
  "--action-dock-height": "4rem",
  "--tab-bar-height": "3.5rem",
  "--stage-tab-width": "6rem",
  "--stage-tab-width-tablet": "5.5rem",
  "--space-7": "2rem",
  "--space-8": "3rem",
  "--content-max-wide": "65rem",
  "--content-max-narrow": "47.5rem",
  "--sheet-peek-min": "4rem",
  "--sheet-peek-max": "7.5rem",
  "--sheet-detent-half": "50%",
  "--sheet-detent-full": "92%",
  "--sheet-grip-width": "2.25rem",
  "--sheet-grip-height": "0.3125rem",
  "--menu-width": "17.5rem",
  "--anchored-card-width": "20rem",
  "--side-panel-width": "25rem",
  "--centered-card-width": "25rem",
  "--palette-width": "35rem",
  "--target-dock-button": "3rem",
  "--target-dock-primary": "4rem",
  "--target-primary-phone": "3rem",
  "--target-primary-desktop": "2.25rem",
  "--target-primary-page": "2.5rem",
  "--handle-visual-width": "0.375rem",
  "--handle-visual-height": "1.5rem",
  "--font-size-card-title": "1.25rem",
  "--font-size-page-title": "1.75rem",
  "--font-size-reading-phone": "1.0625rem",
  ...SELECTION_FROM_SPEC,
};

const SHEET_CLEARANCE_TOKENS = [
  "--sheet-header-clearance",
  "--lane-height-touch",
  "--sheet-edit-row",
  "--sheet-chrome-clearance",
  "--sheet-lane-extra",
  "--sheet-lane-clearance",
];

const STACKED_EDIT_TOKENS = [
  "--stage-stacked-lanes-min",
  "--stage-stacked-lanes-want",
  "--stage-stacked-script-floor",
];

describe("theme tokens.css", () => {
  const current = declarations("tokens.css");

  it("keeps every existing declaration unchanged", () => {
    const changed = FROZEN.filter(
      ([name, values]) =>
        JSON.stringify(current.get(name)) !== JSON.stringify(values),
    ).map(([name]) => name);
    expect(changed).toEqual([]);
  });

  it("sizes the selection look as design system 4.8 says: 2, 2 and 1 px", () => {
    expect(SELECTION_FROM_SPEC).toEqual({
      "--selection-outline-width": "0.125rem",
      "--selection-row-edge-width": "0.125rem",
      "--selection-remote-width": "0.0625rem",
    });
    for (const [name, value] of Object.entries(SELECTION_FROM_SPEC)) {
      expect(current.get(name), name).toEqual([value]);
    }
  });

  it("declares each stage layout token once, in rem or percent", () => {
    for (const [name, value] of Object.entries(STAGE_LAYOUT)) {
      expect(current.get(name), name).toEqual([value]);
      expect(value, name).toMatch(/^[\d.]+(rem|%)$/);
    }
  });

  it("only adds the stage layout tokens", () => {
    const known = new Set([
      ...FROZEN.map(([name]) => name),
      ...Object.keys(STAGE_LAYOUT),
      ...SHEET_CLEARANCE_TOKENS,
      ...STACKED_EDIT_TOKENS,
    ]);
    expect([...current.keys()].filter((name) => !known.has(name))).toEqual([]);
  });

  it("keeps a ruler, a marker row and two lanes for the stacked Edit timeline", () => {
    const value = current.get("--stage-stacked-lanes-min")?.[0] ?? "";
    expect(value.replace(/\s+/g, " ")).toMatch(
      /2 \* var\(--ruler-height\) \+ 2 \* var\(--lane-height\)/,
    );
  });

  it("sums the phone chrome budget to 176px at a 16px root", () => {
    const rem = (name: string) =>
      Number.parseFloat(current.get(name)?.[0] ?? "NaN");
    const chrome =
      rem("--action-dock-height") +
      rem("--player-height") +
      rem("--tab-bar-height");
    expect(chrome * 16).toBe(176);
  });
});

describe("--sheet-lane-clearance", () => {
  const current = declarations("tokens.css");
  const px = (name: string) => {
    const value = current.get(name)?.[0] ?? "";
    return Number.parseFloat(value) * (value.endsWith("rem") ? 16 : 1);
  };

  it("is 18.5rem at the default size with the Edit rows shared, summed from the row tokens", () => {
    const row = px("--control-height") + 2 * px("--space-1");
    const clearance =
      px("--app-header-height") +
      row +
      px("--ruler-height") +
      px("--marker-lane-height") +
      px("--lane-height") +
      px("--control-height") +
      px("--space-3");
    expect(clearance).toBe(18.5 * 16);
  });

  it("counts the app header unless a phone's sheet starts below it", () => {
    expect(current.get("--sheet-header-clearance")?.[0]).toBe(
      "var(--app-header-height)",
    );
    expect(current.get("--sheet-chrome-clearance")?.[0]).toMatch(
      /^calc\(\s*var\(--sheet-header-clearance\)/,
    );
  });

  it("builds the clearance from the chrome clearance plus one lane", () => {
    expect(current.get("--sheet-lane-clearance")?.[0]).toMatch(
      /var\(--sheet-chrome-clearance\)\s*\+\s*var\(--sheet-lane-extra\)/,
    );
  });
});

describe("--color-record", () => {
  it.each(["dark", "light", "light-auto"] as const)(
    "is declared in the %s view on the danger primitive",
    (theme) => {
      const tokens = themeTokens(theme);
      expect(tokens.get("--color-record")).toBe(tokens.get("--color-danger"));
      expect(tokens.get("--color-record")).toMatch(/^var\(--primitive-red-/);
    },
  );
});
