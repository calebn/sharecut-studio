import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { partial, rule, rules } from "../test/cssRules";

const here = dirname(fileURLToPath(import.meta.url));

describe("timeline styles", () => {
  it("keeps the playhead in timeline.css, unlit until playing", () => {
    const playhead = rule(partial("timeline.css"), ".playhead");
    expect(playhead).not.toMatch(/box-shadow/);
    expect(playhead).toMatch(/will-change:\s*transform/);
    expect(partial("inspector.css")).not.toMatch(/\.playhead\b/);
  });

  it("sizes the ruler and marker rows from the px vars TimelineView sets", () => {
    const css = partial("timeline.css");
    expect(rule(css, ".time-ruler")).toMatch(/height:\s*var\(--ruler-height\)/);
    const row = rule(css, ".marker-row");
    expect(row).toMatch(/flex:\s*0 0 var\(--marker-row-height\)/);
    expect(row).toMatch(/height:\s*var\(--marker-row-height\)/);
    for (const marker of [
      ".chapter-marker",
      ".social-marker",
      ".comment-marker",
    ]) {
      expect(rule(css, marker)).toMatch(/height:\s*var\(--marker-row-height\)/);
      expect(rule(css, marker)).not.toMatch(/1\.5rem/);
    }
  });

  it("reserves the scrollbar gutter so fit-to-window cannot oscillate", () => {
    expect(rule(partial("layout.css"), ".timeline-scroll")).toMatch(
      /scrollbar-gutter:\s*stable/,
    );
  });

  it("puts the waveform layer and its overlays on the clip's border box", () => {
    const css = partial("timeline.css");
    const shared = rule(css, ".clip-waveform,\n.clip-waveform-overlays");
    expect(shared).toMatch(/left:\s*-1px/);
    expect(shared).toMatch(/right:\s*-1px/);
    expect(rule(css, ".clip-waveform")).toMatch(/overflow:\s*hidden/);
    expect(rule(css, ".clip-mute-region")).toMatch(/margin-left:\s*-1px/);
  });

  it("puts fade curves on the border box and fade handles at the top corners", () => {
    const css = partial("timeline.css");
    const curves = rule(css, ".clip-fade-curves");
    expect(curves).toMatch(/left:\s*-1px/);
    expect(curves).toMatch(/right:\s*-1px/);
    expect(curves).toMatch(/pointer-events:\s*none/);
    const corner = rule(css, ".fade-corner");
    expect(corner).toMatch(/top:\s*0/);
    expect(corner).toMatch(/z-index:\s*var\(--z-join\)/);
    expect(partial("layout.css")).toMatch(
      /\.timeline-blade-mode \.fade-corner\s*[,{]/,
    );
    const dir = join(here, "../styles/partials");
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".css")) {
        expect(partial(name), name).not.toMatch(
          /\.fade-(handle|region|in-region|out-region)\b/,
        );
      }
    }
    expect(css).not.toMatch(/\.fade-(in|out)\s*[,{]/);
  });

  it("keeps the fade readout legible over any lane color", () => {
    const readout = rule(partial("timeline.css"), ".fade-readout");
    expect(readout).toMatch(/background:\s*var\(--color-overlay-black-90\)/);
    expect(readout).toMatch(/color:\s*var\(--color-clip-label\)/);
    expect(readout).toMatch(/top:\s*0\.75rem/);
  });

  it("keeps hidden trim strips and zero-length fade corners focusable", () => {
    const css = partial("timeline.css");
    const trim = rule(css, ".trim-handle");
    expect(trim).toMatch(/opacity:\s*0;/);
    expect(trim).toMatch(/pointer-events:\s*none/);
    expect(trim).toMatch(/top:\s*0/);
    expect(trim).toMatch(/bottom:\s*0/);
    expect(trim).not.toMatch(/height:/);
    expect(trim).not.toMatch(/visibility/);
    expect(trim).toMatch(/z-index:\s*var\(--z-handle\)/);
    const zero = rule(css, ".fade-corner.zero");
    expect(zero).toMatch(/opacity:\s*0;/);
    expect(zero).toMatch(/pointer-events:\s*none/);
    expect(zero).not.toMatch(/visibility/);
    expect(rule(css, ".fade-corner")).not.toMatch(/visibility|opacity/);
    const reveal = rule(
      css,
      ".clip-block:focus-within .trim-handle, .clip-block:focus-within .fade-corner.zero, .clip-block.selected .trim-handle, .clip-block.selected .fade-corner.zero, .clip-block.trim-dragging .trim-handle, .clip-block.fade-dragging .fade-corner",
    );
    expect(reveal).toMatch(/opacity:\s*1/);
    expect(reveal).toMatch(/pointer-events:\s*auto/);
  });

  it("reveals clip handles on hover only with a fine pointer", () => {
    const css = partial("timeline.css");
    expect(css).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.clip-block:hover \.trim-handle,\s*\.clip-block:hover \.fade-corner\.zero \{\s*opacity: 1;\s*pointer-events: auto;\s*\}\s*\}/,
    );
    // rules() sees only top-level rules: no unguarded :hover reveal.
    for (const [sel] of rules(css)) {
      expect(sel).not.toMatch(/\.clip-block:hover/);
    }
  });

  it("draws join badges at the top of the seam, a button above the clips", () => {
    const css = partial("timeline.css");
    const badge = rule(css, ".join-badge");
    expect(badge).toMatch(/top:\s*0/);
    // Inside the lane's top gutter (clip top inset): clear of the fade corners, the join diamond and the marker lane above.
    expect(badge).toMatch(/translate:\s*-50%\s+0;/);
    expect(badge).toMatch(/height:\s*var\(--clip-inset-top\)/);
    expect(badge).toMatch(/width:\s*1rem/);
    expect(badge).toMatch(/z-index:\s*var\(--z-join\)/);
    expect(badge).toMatch(/pointer-events:\s*auto/);
    // One px token sizes the clip's top inset, the badge and its glyph, so they line up at any root font size.
    const clip = rule(css, ".clip-block");
    expect(clip).toMatch(/top:\s*var\(--clip-inset-top\)/);
    expect(clip).toMatch(
      /height:\s*calc\(var\(--lane-height\) - 2 \* var\(--clip-inset-top\)\)/,
    );
    expect(rule(css, ".join-badge-glyph")).toMatch(
      /height:\s*calc\(var\(--clip-inset-top\) - 1px - 1px\)/,
    );
    expect(
      readFileSync(join(here, "../styles/theme/tokens.css"), "utf8"),
    ).toMatch(/--clip-inset-top:\s*8px;/);
    expect(rule(css, ".join-badge--blocked")).toMatch(
      /border-color:\s*var\(--warning\)/,
    );
    // Declared after `.lane-inner > *` (pointer-events: auto) so it wins at equal specificity.
    expect(css.indexOf(".join-badge {")).toBeGreaterThan(
      css.indexOf(".lane-inner > * {"),
    );
    // A --join-hit-min (24 px, px canvas) wide hit area inside the gutter (WCAG 2.5.8), never taller than the badge.
    // Source text only: the negative inset (100% minus the target) is what grows it. e2e/join-popover.spec.ts
    // (expectHitAreaReaches24px, at the default and a 12px root) is the test that checks the geometry.
    const hit = rule(css, ".join-badge::before");
    expect(hit).toMatch(/inset-block:\s*0/);
    expect(hit).toMatch(
      /inset-inline:\s*calc\(\(100% - var\(--join-hit-min\)\) \/ 2\)/,
    );
    expect(
      readFileSync(join(here, "../styles/theme/tokens.css"), "utf8"),
    ).toMatch(/--join-hit-min:\s*calc\(3 \* var\(--clip-inset-top\)\);/);
  });

  it("fixes the join popover above the shell at the menu layer", () => {
    const css = partial("timeline.css");
    const popover = rule(css, ".join-popover");
    expect(popover).toMatch(/position:\s*fixed/);
    expect(popover).toMatch(/z-index:\s*var\(--z-menu\)/);
  });

  it("matches a grouped selector in any order or spacing", () => {
    expect(rule(".a,\n.b { x: 1 }", ".b, .a")).toBe(" x: 1 ");
    expect(rule("/* .a */\n.a, .b { x: 1 }", ".a,\n.b")).toBe(" x: 1 ");
    expect(() => rule(".a, .b { x: 1 }", ".a")).toThrow("No .a rule");
  });
});
