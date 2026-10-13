import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Appearance, withAppearance } from "./theme";

const here = path.dirname(fileURLToPath(import.meta.url));
const specDirectories = [here, path.join(here, "..", "e2e-compat")];

/**
 * Appearance axes (theme, motion, root text size) are not crossed with
 * viewport cells: a spec gets its appearance from `withAppearance`. A loop over
 * a literal list of one of these axes is allowed only where the loop is the
 * subject of the check, and the reason is written here (docs/testing.md,
 * "Appearance grids").
 */
const AXIS_LOOP_REASONS: Record<string, string> = {
  "design-polish.spec.ts":
    "each test reads computed colors, which differ per theme",
  "review-surface.spec.ts":
    "axe contrast for two different screens, each in both themes",
  "theme-semantic-equivalence.spec.ts": "the theme equivalence is the subject",
  "touch-chooser.spec.ts":
    "axe contrast on the chooser, reduced motion on its own cell",
  "compact-history-persistence.spec.ts":
    "16 and 32 px root text are the two boundary sizes",
  "touch-grammar.spec.ts":
    "the create-menu sweep over text sizes is the subject",
  "touch-peek.spec.ts": "16 and 32 px root text are the two boundary sizes",
};
const AXIS_LOOP =
  /for \(const (?:theme|reduced|reducedMotion|rootFont|rootPx) of \[/;

function specFiles(): string[] {
  return specDirectories.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".spec.ts"))
      .map((name) => path.join(directory, name)),
  );
}

describe("withAppearance", () => {
  const key = (a: Appearance) => `${a.theme}/${a.reducedMotion}`;

  it("gives a single cell the light, full-motion appearance", () => {
    expect(withAppearance(["only"]).map(key)).toEqual(["light/false"]);
  });

  it("runs both themes and both motion settings on two cells", () => {
    const cells = withAppearance(["a", "b"]);
    expect(cells.map((c) => c.cell)).toEqual(["a", "b"]);
    expect(cells.map(key)).toEqual(["light/false", "dark/true"]);
  });

  it("runs every theme and motion pairing on four cells", () => {
    expect(new Set(withAppearance([1, 2, 3, 4]).map(key))).toEqual(
      new Set(["light/false", "dark/true", "light/true", "dark/false"]),
    );
  });

  it("does not tie a second axis to the theme", () => {
    const sizes = withAppearance(
      [16, 32].flatMap((root) => [1, 2, 3, 4, 5].map(() => root)),
    );
    for (const root of [16, 32]) {
      const themes = sizes.filter((c) => c.cell === root).map((c) => c.theme);
      expect(new Set(themes)).toEqual(new Set(["light", "dark"]));
    }
  });

  it("rotates the cycle with an offset", () => {
    expect(withAppearance(["x"], 1).map(key)).toEqual(["dark/true"]);
  });
});

describe("browser spec appearance grids", () => {
  it("loops over a theme, motion or text-size list only where the reason is recorded", () => {
    const found = new Set(
      specFiles()
        .filter((file) => AXIS_LOOP.test(fs.readFileSync(file, "utf8")))
        .map((file) => path.basename(file)),
    );
    expect([...found].sort()).toEqual(Object.keys(AXIS_LOOP_REASONS).sort());
  });
});
