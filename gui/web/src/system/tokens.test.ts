import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

/** tokens.css as it stood before the stage layout block: every value is frozen. */
const FROZEN: readonly (readonly [string, readonly string[]])[] = [
  ["--wordbar-waveform-height", ["6rem"]],
  ["--wordbar-handle-size", ["1rem"]],
  ["--wordbar-label-height", ["2rem"]],
  ["--font-size-micro", ["0.625rem"]],
  ["--font-size-caption", ["0.6875rem"]],
  ["--font-size-small", ["0.75rem"]],
  ["--font-size-ui", ["0.8125rem"]],
  ["--font-size-body", ["0.875rem"]],
  ["--font-size-emphasis", ["0.9375rem"]],
  ["--font-size-review", ["1rem"]],
  ["--font-size-heading", ["1.125rem"]],
  ["--font-size-transport-time", ["1.5rem"]],
  ["--font-size-transport-total", ["0.875rem"]],
  ["--font-size-field-min", ["0rem", "1rem"]],
  [
    "--font-size-field",
    ["max(var(--font-size-ui), var(--font-size-field-min))"],
  ],
  [
    "--font-size-field-small",
    ["max( var(--font-size-small), var(--font-size-field-min) )"],
  ],
  ["--font-size-field-current", ["max(1em, var(--font-size-field-min))"]],
  ["--s3", ["calc(var(--s2) * var(--ratio))"]],
  ["--space-0", ["0.125rem"]],
  ["--space-1", ["0.25rem"]],
  ["--space-3", ["0.5rem"]],
  ["--space-4", ["0.75rem"]],
  ["--space-5", ["1rem"]],
  ["--space-6", ["1.5rem"]],
  ["--radius-xs", ["0.125rem"]],
  ["--radius-sm", ["0.1875rem"]],
  ["--radius-xl", ["0.5rem"]],
  ["--motion-press", ["80ms"]],
  ["--motion-hover", ["150ms"]],
  ["--motion-toggle", ["200ms"]],
  ["--motion-panel", ["200ms"]],
  ["--motion-state", ["250ms"]],
  ["--motion-ease-out", ["cubic-bezier(0.2, 0.8, 0.2, 1)"]],
  ["--motion-long-press", ["500ms"]],
  ["--motion-hold-to-stop", ["600ms"]],
  ["--motion-loop-pipeline", ["1.2s"]],
  ["--motion-loop-skeleton", ["1.6s"]],
  ["--motion-loop-rec", ["1.8s"]],
  ["--shadow-raised", ["0 1px 0.25rem var(--color-shadow)"]],
  ["--shadow-floating", ["0 0.5rem 1.5rem var(--color-shadow)"]],
  ["--shadow-floating-up", ["0 -0.5rem 1.5rem var(--color-shadow)"]],
  ["--shadow-modal", ["0 1rem 3rem var(--color-shadow)"]],
  ["--focus-ring-width", ["0.125rem"]],
  ["--focus-ring-offset", ["0.125rem"]],
  ["--z-timeline-edge", ["0"]],
  ["--z-content", ["1"]],
  ["--z-clip", ["1"]],
  ["--z-clip-overlay", ["2"]],
  ["--z-local-chrome", ["2"]],
  ["--z-fade", ["2"]],
  ["--z-overlay", ["3"]],
  ["--z-edit-overlay", ["4"]],
  ["--z-handle", ["4"]],
  ["--z-status-overlay", ["5"]],
  ["--z-join", ["5"]],
  ["--z-bubble", ["6"]],
  ["--z-moving-clip", ["6"]],
  ["--z-timeline-interaction", ["8"]],
  ["--z-timeline-chrome", ["9"]],
  ["--z-playhead", ["10"]],
  ["--z-track-header", ["12"]],
  ["--z-timeline-popover", ["20"]],
  ["--z-shell-status", ["30"]],
  ["--z-sheet", ["40"]],
  ["--z-shell-chrome", ["50"]],
  ["--z-presence-ghost", ["51"]],
  ["--z-sheet-docked", ["55"]],
  ["--z-menu", ["60"]],
  ["--z-toast", ["70"]],
  ["--z-command-palette", ["80"]],
  ["--lane-height", ["72px"]],
  ["--ruler-height", ["24px"]],
  ["--marker-lane-height", ["72px"]],
  ["--clip-inset-top", ["12px"]],
  ["--clip-inset-bottom", ["8px"]],
  ["--join-hit-min", ["calc(2 * var(--clip-inset-top))"]],
  ["--header-width", ["11.25rem"]],
  ["--inspector-width", ["17.5rem"]],
  ["--stage-lane-min", ["22rem"]],
  ["--stage-script-floor", ["12rem"]],
  ["--player-height", ["3.5rem"]],
  ["--control-height", ["2rem"]],
  ["--control-height-compact", ["1.75rem"]],
  ["--pill-height", ["1.5rem"]],
  ["--touch-min", ["2.75rem"]],
  ["--mix-row-height", ["3.5rem"]],
  ["--mix-identity-size", ["1.5rem"]],
  ["--mix-volume-width", ["6rem"]],
  ["--mute-waveform-opacity", ["0.5"]],
  ["--inspector-column-width", ["clamp(16rem, 32vw, 22rem)"]],
  ["--menu-available-height", ["90dvh"]],
  ["--menu-available-width", ["calc(100dvw - 2 * var(--menu-edge-margin))"]],
  ["--menu-edge-margin", ["var(--space-3)"]],
  ["--menu-anchor-gap", ["var(--space-1)"]],
  ["--pending-review-feedback-max-height", ["30dvh"]],
  ["--shadow-playhead-playing", ["0 0 0.5rem var(--color-timeline-playhead)"]],
  [
    "--bg-ruler-glow",
    [
      "radial-gradient( ellipse at center, color-mix(in srgb, var(--color-timeline-playhead) 35%, transparent), transparent 72% )",
    ],
  ],
  [
    "--bg-timeline-edge-start",
    ["linear-gradient( to right, var(--color-timeline-edge), transparent )"],
  ],
  [
    "--bg-timeline-edge-end",
    ["linear-gradient( to left, var(--color-timeline-edge), transparent )"],
  ],
  [
    "--bg-empty-stage-card",
    ["color-mix( in srgb, var(--color-timeline-lane) 80%, transparent )"],
  ],
  [
    "--bg-empty-stage-ghost",
    [
      "repeating-linear-gradient( to right, transparent 0 0.375rem, var(--color-timeline-text) 0.375rem 0.5rem, transparent 0.5rem 0.75rem )",
    ],
  ],
  [
    "--shadow-empty-stage-hover",
    [
      "inset 0 0 4rem var(--color-timeline-vignette), 0 0 1.5rem var(--color-transport-play-glow)",
    ],
  ],
  [
    "--bg-scroll-shadows-raised",
    [
      "linear-gradient(var(--color-bg-raised) 30%, transparent) top / 100% 2rem no-repeat local, linear-gradient(transparent, var(--color-bg-raised) 70%) bottom / 100% 2rem no-repeat local, radial-gradient(farthest-side at 50% 0, var(--color-shadow), transparent) top / 100% 0.5rem no-repeat, radial-gradient(farthest-side at 50% 100%, var(--color-shadow), transparent) bottom / 100% 0.5rem no-repeat",
    ],
  ],
  [
    "--bg-timeline-skeleton",
    [
      "linear-gradient( 100deg, transparent 30%, var(--color-hover) 50%, transparent 70% )",
    ],
  ],
  [
    "--bg-timeline-clip-sheen",
    [
      "linear-gradient( to bottom, var(--color-overlay-white-15), transparent 55%, var(--color-overlay-black-22) )",
    ],
  ],
  [
    "--clipping-hatch",
    [
      "repeating-linear-gradient( 45deg, var(--color-danger) 0 0.125rem, transparent 0.125rem 0.5rem )",
    ],
  ],
  ["--clipping-tint", ["var(--clipping-hatch), var(--color-clipping-region)"]],
  [
    "--clipping-edges",
    [
      "inset 0 0.1875rem 0 var(--color-danger), inset 0 -0.1875rem 0 var(--color-danger)",
    ],
  ],
  ["--color-brand-mark-ink", ["var(--color-text-primary)", "CanvasText"]],
  ["--color-brand-mark-accent", ["var(--color-accent)", "CanvasText"]],
];

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
