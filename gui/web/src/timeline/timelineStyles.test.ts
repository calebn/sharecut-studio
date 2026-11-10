import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { partial, rule, rules } from "../test/cssRules";

const here = dirname(fileURLToPath(import.meta.url));

describe("timeline styles", () => {
  it("keeps the session pill pressable: no overflow clip, its own width, a focus ring, a coarse-pointer target", () => {
    const css = partial("timeline.css");
    const pill = rule(css, ".timeline-session-pill");
    expect(pill).not.toMatch(/overflow/);
    expect(pill).not.toMatch(/min-inline-size|max-inline-size/);
    expect(rule(css, ".timeline-session-pill:focus-visible")).toMatch(
      /outline:\s*var\(--focus-ring-width\) solid var\(--color-accent\)/,
    );
    expect(css).toMatch(
      /@media \(pointer: coarse\)[^}]*\{[^}]*\.timeline-session-pill/s,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)[^}]*\{[^}]*\.timeline-ruler \.sys-ruler-session/s,
    );
  });

  it("keeps the playhead in timeline.css, unlit until playing", () => {
    const playhead = rule(partial("timeline.css"), ".playhead");
    expect(playhead).not.toMatch(/box-shadow/);
    expect(playhead).toMatch(/will-change:\s*transform/);
    expect(partial("inspector.css")).not.toMatch(/\.playhead\b/);
  });

  it("sizes the ruler and marker rows from the px vars TimelineView sets", () => {
    const css = partial("timeline.css");
    expect(rule(css, ".timeline-ruler")).toMatch(
      /height:\s*var\(--ruler-height\)/,
    );
    const row = rule(css, ".marker-row");
    expect(row).toMatch(/flex:\s*0 0 var\(--marker-row-height\)/);
    expect(row).toMatch(/height:\s*var\(--marker-row-height\)/);
    expect(rule(css, ".clipping-marker")).toMatch(
      /height:\s*var\(--marker-row-height\)/,
    );
  });

  it("pins the ruler and marker row above lanes but below the playhead", () => {
    const css = partial("timeline.css");
    const tokens = readFileSync(
      join(here, "../styles/theme/tokens.css"),
      "utf8",
    );
    const ruler = rule(css, ".timeline-ruler");
    expect(ruler).toMatch(/position:\s*sticky/);
    expect(ruler).toMatch(/top:\s*0/);
    expect(ruler).toMatch(/z-index:\s*var\(--z-timeline-chrome\)/);

    const markerLane = rule(css, ".marker-lane");
    expect(markerLane).toMatch(/position:\s*sticky/);
    expect(markerLane).toMatch(/top:\s*var\(--ruler-height\)/);
    expect(markerLane).toMatch(/z-index:\s*var\(--z-timeline-chrome\)/);
    expect(tokens).toMatch(/--z-bubble:\s*6;/);
    expect(tokens).toMatch(/--z-timeline-chrome:\s*9;/);
    expect(tokens).toMatch(/--z-playhead:\s*10;/);
    expect(tokens).toMatch(/--z-track-header:\s*12;/);
  });

  it("keeps named timeline roles at their established stack levels", () => {
    const tokens = readFileSync(
      join(here, "../styles/theme/tokens.css"),
      "utf8",
    );
    const roles: ReadonlyArray<readonly [string, number]> = [
      ["--z-content", 1],
      ["--z-clip-overlay", 2],
      ["--z-local-chrome", 2],
      ["--z-overlay", 3],
      ["--z-edit-overlay", 4],
      ["--z-status-overlay", 5],
      ["--z-moving-clip", 6],
      ["--z-timeline-interaction", 8],
      ["--z-timeline-chrome", 9],
      ["--z-playhead", 10],
      ["--z-track-header", 12],
      ["--z-timeline-popover", 20],
      ["--z-menu", 60],
      ["--z-command-palette", 80],
    ];
    for (const [role, level] of roles) {
      expect(tokens).toMatch(new RegExp(`${role}:\\s*${level};`));
    }
  });

  it("keeps the sticky track-header chrome attached to the timeline scroller", () => {
    const layout = partial("layout.css");
    expect(rule(layout, ".track-headers")).toMatch(/overflow:\s*clip/);

    const chrome = rule(layout, ".track-headers-chrome");
    expect(chrome).toMatch(/position:\s*sticky/);
    expect(chrome).toMatch(/top:\s*0/);
    expect(chrome).toMatch(/z-index:\s*var\(--z-timeline-chrome\)/);
    expect(chrome).toMatch(/background:\s*var\(--color-bg-base\)/);
  });

  it("paints the remote presence layer one step above the sticky ruler and marker lane", () => {
    const layer = rule(partial("presence.css"), ".timeline-presence-window");
    expect(layer).toMatch(
      /z-index:\s*calc\(var\(--z-timeline-chrome\)\s*\+\s*1\)/,
    );
    expect(layer).toMatch(/pointer-events:\s*none/);
    // Not sticky: under a vertical scroll the layer moves with the lanes while
    // the ruler and marker lane stay pinned (the documented option A).
    expect(layer).not.toMatch(/sticky/);
  });

  it("keeps desktop scrollbar width steady without an empty stable gutter", () => {
    expect(rule(partial("layout.css"), ".timeline-scroll")).toMatch(
      /overflow-y:\s*scroll/,
    );
    expect(rule(partial("layout.css"), ".timeline-scroll")).not.toMatch(
      /scrollbar-gutter:\s*stable/,
    );
    expect(
      rule(
        partial("responsive.css"),
        ".timeline-area--fixed-playhead .timeline-scroll",
      ),
    ).toMatch(/overflow-y:\s*auto/);
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
    expect(corner).toMatch(/cursor:\s*ew-resize/);
    expect(partial("layout.css")).not.toMatch(
      /\.timeline-(?:blade|comment)-mode \.fade-corner\s*[,{]/,
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

  it("draws seam marks at the top of the seam, above the clips", () => {
    const css = partial("timeline.css");
    const mark = rule(css, ".seam-mark");
    expect(mark).toMatch(/top:\s*0/);
    expect(mark).toMatch(/translate:\s*-50%\s+0;/);
    expect(mark).toMatch(/z-index:\s*var\(--z-join\)/);
    expect(mark).toMatch(/pointer-events:\s*auto/);
    const clip = rule(css, ".clip-block");
    expect(clip).toMatch(/top:\s*var\(--clip-inset-top\)/);
    expect(clip).toMatch(
      /height:\s*calc\(\s*var\(--lane-height\) -\s*var\(--clip-inset-top\) -\s*var\(--clip-inset-bottom\)\s*\)/,
    );
    expect(
      readFileSync(join(here, "../styles/theme/tokens.css"), "utf8"),
    ).toMatch(/--clip-inset-top:\s*12px;[\s\S]*--clip-inset-bottom:\s*8px;/);
    // Declared after `.lane-inner > *` (pointer-events: auto) so it wins at equal specificity.
    expect(css.indexOf(".seam-mark {")).toBeGreaterThan(
      css.indexOf(".lane-inner > * {"),
    );
    // A --join-hit-min (24 px, px canvas) wide hit area (WCAG 2.5.8), never taller than the gutter.
    const hit = rule(css, ".seam-mark .sys-seam-hit");
    expect(hit).toMatch(/inline-size:\s*var\(--join-hit-min\)/);
    expect(hit).toMatch(/block-size:\s*var\(--clip-inset-top\)/);
    expect(
      readFileSync(join(here, "../styles/theme/tokens.css"), "utf8"),
    ).toMatch(/--join-hit-min:\s*calc\(2 \* var\(--clip-inset-top\)\);/);
  });

  it("sizes the bleed pick strip from the bottom clip inset, not the top gutter", () => {
    const css = readFileSync(join(here, "BleedAttenuationOverlay.css"), "utf8");
    const pick = rule(css, ".bleed-attenuation-pick.ui-control");
    expect(pick).toMatch(/block-size:\s*var\(--clip-inset-bottom\)/);
    expect(css).not.toMatch(/--clip-inset-top/);
  });

  it("keeps the join editor's anchored dialog fixed at the menu layer", () => {
    const css = partial("command-palette.css");
    const layer = rule(css, ".ui-dialog-root--anchored");
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/z-index:\s*var\(--z-menu\)/);
  });

  it("matches a grouped selector in any order or spacing", () => {
    expect(rule(".a,\n.b { x: 1 }", ".b, .a")).toBe(" x: 1 ");
    expect(rule("/* .a */\n.a, .b { x: 1 }", ".a,\n.b")).toBe(" x: 1 ");
    expect(() => rule(".a, .b { x: 1 }", ".a")).toThrow("No .a rule");
  });
});
