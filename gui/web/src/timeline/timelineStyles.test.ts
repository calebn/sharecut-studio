import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { partial, rule } from "../test/cssRules";

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

  it("shows trim strips and zero-length fade corners only on hover, focus or selection", () => {
    const css = partial("timeline.css");
    const trim = rule(css, ".trim-handle");
    expect(trim).toMatch(/visibility:\s*hidden/);
    expect(trim).toMatch(/top:\s*0/);
    expect(trim).toMatch(/bottom:\s*0/);
    expect(trim).not.toMatch(/height:/);
    expect(trim).toMatch(/z-index:\s*var\(--z-handle\)/);
    expect(rule(css, ".fade-corner.zero")).toMatch(/visibility:\s*hidden/);
    expect(rule(css, ".fade-corner")).not.toMatch(/visibility/);
    expect(
      rule(
        css,
        ".clip-block:hover .trim-handle, .clip-block:hover .fade-corner.zero, .clip-block:focus-within .trim-handle, .clip-block:focus-within .fade-corner.zero, .clip-block.selected .trim-handle, .clip-block.selected .fade-corner.zero, .clip-block.trim-dragging .trim-handle, .clip-block.fade-dragging .fade-corner",
      ),
    ).toMatch(/visibility:\s*visible/);
  });

  it("matches a grouped selector in any order or spacing", () => {
    expect(rule(".a,\n.b { x: 1 }", ".b, .a")).toBe(" x: 1 ");
    expect(rule("/* .a */\n.a, .b { x: 1 }", ".a,\n.b")).toBe(" x: 1 ");
    expect(() => rule(".a, .b { x: 1 }", ".a")).toThrow("No .a rule");
  });
});
