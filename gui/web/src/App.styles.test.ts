import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("App styles", () => {
  it("imports daw.css so Home is styled before a project opens", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "App.tsx"), "utf8");
    expect(src).toMatch(/import ["']\.\/styles\/daw\.css["']/);
  });

  it("sizes follow chrome with rem and @container, not viewport media", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "styles/partials/presence.css"),
      "utf8",
    );
    expect(src).not.toMatch(/@media\s*\(/);
    expect(src).toMatch(/@container app \(inline-size < 68\.75rem\)/);
    const px = [...src.matchAll(/(?<![\d.])(\d+)px\b/g)].map((m) =>
      Number(m[1]),
    );
    expect(px.every((n) => n <= 1)).toBe(true);
  });

  it("caps Dialog and Menu overlays to dvh with internal scroll", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const palette = readFileSync(
      join(here, "styles/partials/command-palette.css"),
      "utf8",
    );
    expect(palette).toMatch(/max-height:\s*min\(\s*90dvh/);
    expect(palette).toMatch(
      /\.command-palette-body\s*\{[^}]*overflow-y:\s*auto/s,
    );
    expect(palette).not.toMatch(
      /\.share-dialog-body\s*\{[^}]*overflow-y:\s*auto/s,
    );
    expect(palette).not.toMatch(
      /\.share-dialog-scroller\s*\{[^}]*overflow:\s*auto/s,
    );
    expect(palette).not.toMatch(
      /\.command-palette-panel\.share-dialog-panel\s*\{[^}]*overflow:\s*hidden/s,
    );
    const ui = readFileSync(join(here, "styles/partials/ui.css"), "utf8");
    expect(ui).toMatch(/\.ui-menu-panel\s*\{[^}]*overflow-y:\s*auto/s);
    expect(ui).toMatch(/--menu-available-height/);
    expect(ui).not.toMatch(/100dvh - var\(--player-height\)/);
  });

  it("keeps badge content on one line", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "styles/partials/layout.css"), "utf8");
    const badgeRule = src.match(/\.badge\s*\{(?<declarations>[^}]*)\}/);

    expect(badgeRule?.groups?.declarations).toMatch(/white-space:\s*nowrap/);
  });

  it("makes FocusPull reduced motion an instant visual cut", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const ui = readFileSync(join(here, "styles/partials/ui.css"), "utf8");

    expect(ui).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(ui).toMatch(/\.focus-pull-exit\s*\{[^}]*display:\s*none/s);
    expect(ui).toMatch(
      /\.focus-pull-pending,[\s\S]*?\.focus-pull-enter\s*\{[^}]*opacity:\s*1/s,
    );
    expect(ui).toMatch(/\.focus-pull-pending\s*\{[^}]*visibility:\s*hidden/s);
    expect(ui).toMatch(
      /\.focus-pull-pending,[\s\S]*?\.focus-pull-enter\s*\{[^}]*visibility:\s*visible/s,
    );
  });

  it("paints menu focus rings inside scrolling panels", () => {
    // .ui-menu-panel scrolls (overflow-y: auto); a focus outline with a
    // positive offset would clip at the scrollport edge (#184), so the
    // focus-visible rule must paint the ring inside the item instead.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "styles/partials/ui.css"), "utf8");
    const rule = src.match(/\.ui-menu-panel[^{]*:focus-visible\s*{([^}]*)}/);
    expect(rule).toBeTruthy();
    const body = rule![1] ?? "";
    expect(body).toMatch(/box-shadow:\s*inset/);
    expect(body).not.toMatch(/outline-offset/);
  });

  it("gives the lane header's Mute and Solo the touch target on a coarse pointer (#1028)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "styles/partials/layout.css"), "utf8");
    const coarse = src.match(
      /@media \(pointer: coarse\) \{\s*\.track-transport-btns \.trk-btn \{([^}]*)\}/,
    );
    expect(coarse).toBeTruthy();
    const body = coarse![1] ?? "";
    expect(body).toMatch(/min-inline-size:\s*var\(--touch-min\)/);
    expect(body).toMatch(/min-block-size:\s*var\(--touch-min\)/);
  });

  it("gives the Range word controls the touch target on a coarse pointer (#1029)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const words = readFileSync(
      join(here, "styles/partials/layout.css"),
      "utf8",
    ).match(
      /@media \(pointer: coarse\) \{\s*\.range-word-step,\s*\.range-word-ignore \{([^}]*)\}/,
    );
    expect(words).toBeTruthy();
    expect(words![1]).toMatch(/min-block-size:\s*var\(--touch-min\)/);
  });

  it("gives every ui-control variant and action pill the touch target on a coarse pointer (#1315, #1388)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "styles/partials/ui.css"), "utf8");
    const coarse = src.match(
      /@media \(pointer: coarse\) \{\s*\.ui-control,\s*button\.pill\.pill--action \{([^}]*)\}/,
    );
    expect(coarse).toBeTruthy();
    const body = coarse![1] ?? "";
    expect(body).toMatch(/min-block-size:\s*var\(--touch-min\)/);
    expect(body).toMatch(/min-inline-size:\s*var\(--touch-min\)/);
    expect(
      src.indexOf("@media (pointer: coarse) {\n  .ui-control,"),
    ).toBeGreaterThan(src.indexOf(".ui-control--compact {"));
  });

  it("sizes the segmented track to its container on a coarse pointer (#1388)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (f: string) => readFileSync(join(here, f), "utf8");
    const ui = read("styles/partials/ui.css");
    const track = ui.match(
      /@media \(pointer: coarse\) \{[^@]*?\.ui-segmented \{([^}]*)\}/,
    );
    expect(track).toBeTruthy();
    expect(track![1]).toMatch(/block-size:\s*auto/);
    expect(track![1]).toMatch(/min-block-size:\s*var\(--control-height\)/);
  });

  it("keeps the native text selection out of the transcript in Select mode on touch (#1029)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "styles/partials/panels.css"), "utf8");
    expect(css).toMatch(
      /@media \(pointer: coarse\) \{[\s\S]*?\[data-transcript-intent="select"\] \.utterance-turn \{\s*user-select: none;/,
    );
  });

  it("paints dialog focus rings inside the scrolling body", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "styles/partials/command-palette.css"),
      "utf8",
    );
    const rule = src.match(
      /\.command-palette-body\s+:is\([^)]*\):focus-visible\s*\{([^}]*)}/,
    );
    expect(rule).toBeTruthy();
    const body = rule![1] ?? "";
    expect(body).toMatch(/box-shadow:\s*inset/);
    expect(body).not.toMatch(/outline-offset/);
  });

  it("keeps iOS Safari's native selection off transcript words and Select-mode turns with the prefixed property", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "styles/partials/panels.css"), "utf8");
    for (const selector of [
      ".utterance-word,\n  .comment-card-main",
      '[data-transcript-intent="select"] .utterance-turn',
    ]) {
      const at = css.indexOf(`${selector} {`);
      expect(at).toBeGreaterThan(-1);
      const body = css.slice(at, css.indexOf("}", at));
      expect(body).toMatch(/-webkit-user-select:\s*none/);
    }
  });
});
