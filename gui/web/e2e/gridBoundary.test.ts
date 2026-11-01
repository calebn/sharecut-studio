import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Appearance, withAppearance } from "./theme";

const here = path.dirname(fileURLToPath(import.meta.url));
const specDirectories = [here, path.join(here, "..", "e2e-compat")];

/**
 * Appearance axes (theme, motion, root text size) are not crossed with
 * viewport cells: a spec gets its appearance from `withAppearance`. A `for`
 * loop over one of these axes is allowed only where the loop is the subject of
 * the check, and the file, the number of loops and the reason are written here
 * (docs/testing.md, "Appearance grids").
 */
const AXIS_LOOPS: Record<string, { loops: number; reason: string }> = {
  "brand-forced-colors.spec.ts": {
    loops: 1,
    reason:
      "the forced light and dark palettes resolve CanvasText differently, so both are the subject",
  },
  "design-polish.spec.ts": {
    loops: 5,
    reason: "each test reads computed colors, which differ per theme",
  },
  "modelGate.spec.ts": {
    loops: 1,
    reason:
      "the model gate acceptance asks for contrast-enabled axe on the prompt at three viewports in both themes (#2046)",
  },
  "guest-name.spec.ts": {
    loops: 1,
    reason:
      "the name field must fit and read in both themes at each of four phone sizes, screenshots and axe included (#2164)",
  },
  "models.spec.ts": {
    loops: 2,
    reason:
      "the models acceptance asks for screenshots and contrast-enabled axe at three viewports in both themes (#2046)",
  },
  "review-surface.spec.ts": {
    loops: 1,
    reason: "axe contrast for two different screens, each in both themes",
  },
  "theme-semantic-equivalence.spec.ts": {
    loops: 2,
    reason: "the theme equivalence is the subject",
  },
  "touch-chooser.spec.ts": {
    loops: 2,
    reason: "axe contrast on the chooser, reduced motion on its own cell",
  },
  "touch-grammar.spec.ts": {
    loops: 2,
    reason: "the create-menu sweep over text sizes is the subject",
  },
  "touch-peek.spec.ts": {
    loops: 1,
    reason: "16 and 32 px root text are the two boundary sizes",
  },
  "precision-boundary-timeout.spec.ts": {
    loops: 2,
    reason: "axe contrast for the timeout alert in both themes",
  },
  "envelope-creation.spec.ts": {
    loops: 2,
    reason: "hand-picked viewport and theme profiles, one per boundary cell",
  },
  "feedback-gesture.spec.ts": {
    loops: 1,
    reason: "the armed card is themed, so both looks of it are checked",
  },
  "inventory-audit.spec.ts": {
    loops: 1,
    reason: "hand-picked viewport and theme profiles, one per boundary cell",
  },
  "prepare.spec.ts": {
    loops: 1,
    reason:
      "#2908 requires readable desktop and phone screenshot receipts in light and dark for real selected processing and sound-action/session preferences",
  },
  "edit-boundary-precision.spec.ts": {
    loops: 1,
    reason:
      "screenshot receipts for the desktop and phone cells in both themes",
  },
  "edit-markers.spec.ts": {
    loops: 2,
    reason:
      "the marks take one themed hue per edit type, so each viewport's screenshot receipt, and the zoom ladder's wide-tier receipt, are taken in both themes",
  },
  "touch-nudge.spec.ts": {
    loops: 1,
    reason: "axe contrast for the nudge controls in both themes",
  },
};

/** A loop is over an axis when its binding is named for one or its list holds the axis values. */
const AXIS_BINDING =
  /\b(?:themes?|motions?|reduced|reducedMotion|rootFont|rootPx)\b/;
const AXIS_VALUES =
  /["'](?:light|dark|reduce|no-preference)["']|\[\s*16\s*,\s*32\s*\]/;

type Loop = { binding: string; iterable: string };

/** The `for (const <binding> of <iterable>)` headers in a source file. */
function forOfLoops(source: string): Loop[] {
  const loops: Loop[] = [];
  for (const start of source.matchAll(/\bfor \((?:const|let) /g)) {
    const from = start.index + start[0].length;
    let depth = 1;
    let end = from;
    while (depth > 0 && end < source.length) {
      const char = source[end++];
      if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    const parts = /^([\s\S]*?)\s+of\s+([\s\S]*)$/.exec(
      source.slice(from, end - 1),
    );
    if (parts) loops.push({ binding: parts[1]!, iterable: parts[2]! });
  }
  return loops;
}

/** Follow a bare constant name to its declaration, so `of themes` is read as its list. */
function iterableText(source: string, iterable: string): string {
  const name = /^[A-Za-z_]\w*$/.exec(iterable.trim())?.[0];
  if (!name) return iterable;
  const declaration = new RegExp(
    `\\b(?:const|let) ${name}\\b[^=]*=([\\s\\S]*?);`,
  ).exec(source);
  return declaration?.[1] ?? iterable;
}

function isAxisLoop(source: string, loop: Loop): boolean {
  if (loop.iterable.trim().startsWith("withAppearance(")) return false;
  return (
    AXIS_BINDING.test(loop.binding) ||
    AXIS_VALUES.test(iterableText(source, loop.iterable))
  );
}

function axisLoopCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const directory of specDirectories) {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".spec.ts")) continue;
      const source = fs.readFileSync(path.join(directory, name), "utf8");
      const count = forOfLoops(source).filter((loop) =>
        isAxisLoop(source, loop),
      ).length;
      if (count) counts[name] = count;
    }
  }
  return counts;
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
    const allowed = Object.fromEntries(
      Object.entries(AXIS_LOOPS).map(([file, { loops }]) => [file, loops]),
    );
    expect(axisLoopCounts()).toEqual(allowed);
  });

  it("recognizes literal, named and differently named axis loops", () => {
    const source = `
      const sizes = [16, 32];
      const themes = ["dark", "light"] as const;
      for (const motion of [false, true]) {}
      for (const t of themes) {}
      for (const px of sizes) {}
      for (const mode of ["reduce", "no-preference"]) {}
      for (const { theme } of withAppearance([1, 2])) {}
      for (const width of [1280, 390]) {}`;
    expect(
      forOfLoops(source)
        .filter((loop) => isAxisLoop(source, loop))
        .map((loop) => loop.binding),
    ).toEqual(["motion", "t", "px", "mode"]);
  });
});
