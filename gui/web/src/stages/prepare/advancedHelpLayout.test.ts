import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/styles/partials/system.css"),
  "utf8",
);

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("advanced field help line", () => {
  const layout =
    /\b(display|position|inline-size|block-size|height|width|margin|padding|overflow|clip-path|white-space|font-size|visibility)\s*:/;

  it("is laid out in flow while the field is not focused", () => {
    const resting = rule(".sys-adv-help");
    expect(resting).not.toMatch(/position:\s*absolute/);
    expect(resting).not.toMatch(/display:\s*none/);
    expect(resting).not.toMatch(/visibility:\s*hidden/);
    expect(resting).not.toMatch(/(block|inline)-size:\s*1px/);
  });

  it("changes only paint, never layout, on focus", () => {
    const focused = rule(".sys-adv-field:focus-within .sys-adv-help");
    expect(focused).not.toMatch(layout);
  });

  it("paints the language note in the secondary colour without focus", () => {
    const note = rule(".sys-adv-help.sys-adv-note");
    expect(note).toMatch(/color:\s*var\(--color-text-secondary\)/);
    expect(note).toMatch(/user-select:\s*auto/);
    expect(note).not.toMatch(layout);
  });
});
