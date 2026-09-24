import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function partial(name: string): string {
  return readFileSync(join(here, "../styles/partials", name), "utf8");
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match?.[1]) {
    throw new Error(`No ${selector} rule`);
  }
  return match[1];
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
});
