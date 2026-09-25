import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function partial(name: string): string {
  return readFileSync(join(here, "../styles/partials", name), "utf8");
}

/** A selector list, trimmed, whitespace-collapsed and sorted, for comparison. */
function selectorList(list: string): string {
  return list
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .sort()
    .join(",");
}

/**
 * The body of the first top-level rule whose selector list equals `selector`,
 * ignoring selector order, spacing and comments.
 */
function rule(css: string, selector: string): string {
  const want = selectorList(selector);
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of bare.matchAll(/(?:^|\n)([^\s{}@][^{}]*?)\{([^}]*)\}/g)) {
    if (match[2] && selectorList(match[1] ?? "") === want) {
      return match[2];
    }
  }
  throw new Error(`No ${selector} rule`);
}

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

  it("matches a grouped selector in any order or spacing", () => {
    expect(rule(".a,\n.b { x: 1 }", ".b, .a")).toBe(" x: 1 ");
    expect(rule("/* .a */\n.a, .b { x: 1 }", ".a,\n.b")).toBe(" x: 1 ");
    expect(() => rule(".a, .b { x: 1 }", ".a")).toThrow("No .a rule");
  });
});
