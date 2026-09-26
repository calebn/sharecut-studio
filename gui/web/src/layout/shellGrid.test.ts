import { describe, expect, it } from "vitest";
import { partial, rule, rules } from "../test/cssRules";

const layoutCss = partial("layout.css");
const responsiveCss = partial("responsive.css");
const AREAS = ["banners", "follow", "transport", "main", "tabs", "status"];
const LAYOUT_SELECTOR =
  /daw-shell--layout-|daw-shell--attention|daw-shell-guest|daw-shell--following/;

describe("shell grid areas", () => {
  const shell = rule(layoutCss, ".daw-shell");

  it("declares the named areas in order", () => {
    const areas = /grid-template-areas:([^;]*);/.exec(shell)?.[1] ?? "";
    expect([...areas.matchAll(/"([a-z]+)"/g)].map((m) => m[1])).toEqual(AREAS);
  });

  it("has six row tracks with variable main/tabs", () => {
    const rows = /grid-template-rows:([^;]*);/.exec(shell)?.[1] ?? "";
    const tracks = rows.trim().split(/\s+(?![^(]*\))/);
    expect(tracks).toHaveLength(6);
    expect(tracks[2]).toBe("var(--transport-height)");
    expect(tracks[3]).toBe("var(--shell-main-row)");
    expect(tracks[4]).toBe("var(--shell-tabs-row)");
  });

  it("never lets a layout or banner class re-declare the grid", () => {
    for (const css of [layoutCss, responsiveCss]) {
      for (const [sel, body] of rules(css)) {
        if (LAYOUT_SELECTOR.test(sel)) {
          expect(body, sel).not.toMatch(/grid-template-(rows|areas)/);
        }
      }
    }
  });

  it("lets focus layouts set only the main/tabs track sizes", () => {
    for (const mode of ["timeline", "text", "review"]) {
      const body = rule(responsiveCss, `.daw-shell--layout-${mode}`);
      const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) {
        expect(["--shell-main-row", "--shell-tabs-row"]).toContain(p);
      }
    }
  });

  it("places every area, including the phone nav", () => {
    for (const area of [...AREAS, "nav"]) {
      const placed = rules(layoutCss).some(
        ([sel, body]) =>
          sel.startsWith(".daw-shell >") &&
          new RegExp(`grid-area:\\s*${area}\\b`).test(body),
      );
      expect(placed, area).toBe(true);
    }
    expect(rule(responsiveCss, ".daw-shell--phone")).toContain('"nav"');
  });
});
