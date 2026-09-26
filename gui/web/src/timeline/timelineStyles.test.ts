import { readdirSync, readFileSync } from "node:fs";
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

  it("keeps the zero-length fade-out handle at the clip end", () => {
    const css = partial("timeline.css");
    const out = rule(css, ".fade-handle-zero.out");
    expect(out).toMatch(/right:\s*0/);
    expect(out).toMatch(/left:\s*auto/);
    expect(rule(css, ".fade-handle-zero.in")).toMatch(/left:\s*0/);
    // Non-zero handles straddle their fade edge (no -0.5rem override elsewhere).
    expect(rule(css, ".fade-handle.end")).toMatch(/right:\s*-0\.25rem/);
    expect(rule(css, ".fade-handle.start")).toMatch(/left:\s*-0\.25rem/);
    expect(partial("layout.css")).toMatch(
      /\.timeline-blade-mode \.fade-handle\s*[,{]/,
    );
    const dir = join(here, "../styles/partials");
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".css") && name !== "timeline.css") {
        expect(partial(name), name).not.toMatch(/\.fade-handle\.(start|end)\b/);
      }
    }
    expect(css).not.toMatch(/\.fade-(in|out)\s*[,{]/);
  });

  it("keeps the fade readout legible over any lane color", () => {
    const readout = rule(partial("timeline.css"), ".fade-readout");
    expect(readout).toMatch(/background:\s*var\(--color-overlay-black-90\)/);
    expect(readout).toMatch(/color:\s*var\(--color-clip-label\)/);
  });

  it("matches a grouped selector in any order or spacing", () => {
    expect(rule(".a,\n.b { x: 1 }", ".b, .a")).toBe(" x: 1 ");
    expect(rule("/* .a */\n.a, .b { x: 1 }", ".a,\n.b")).toBe(" x: 1 ");
    expect(() => rule(".a, .b { x: 1 }", ".a")).toThrow("No .a rule");
  });
});
