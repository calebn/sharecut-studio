import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appliedKind,
  EDIT_GLYPH_PATH,
  EDIT_MARKERS,
  type EditMarkerKind,
  JOIN_KINDS,
  JOIN_MODE_OPTIONS,
  joinKind,
  joinMarkLabel,
  markerLabel,
  markerVariant,
  pendingKind,
} from "./editMarkerRegistry";
import { pendingTypeLabel } from "./pendingEditLabels";

const here = dirname(fileURLToPath(import.meta.url));
const theme = (name: string) =>
  readFileSync(join(here, "../styles/theme", name), "utf8");

const KINDS = Object.keys(EDIT_MARKERS) as EditMarkerKind[];
const TYPES = [...new Set(KINDS.map((kind) => EDIT_MARKERS[kind].type))];

describe("edit marker registry", () => {
  it("gives every kind a label and a type, and every join kind a glyph", () => {
    expect(KINDS).toHaveLength(9);
    expect(TYPES).toHaveLength(5);
    for (const kind of KINDS) {
      expect(markerLabel(kind).length).toBeGreaterThan(0);
    }
    for (const kind of JOIN_KINDS) {
      expect(EDIT_GLYPH_PATH[EDIT_MARKERS[kind].type]).toMatch(/^M/);
    }
  });

  it("draws one distinct glyph per join type", () => {
    expect(new Set(Object.values(EDIT_GLYPH_PATH)).size).toBe(3);
    expect(EDIT_GLYPH_PATH.cut).toBe("M6 1V11");
    expect(EDIT_GLYPH_PATH.fade).toBe("M1 2L6 10L11 2");
    expect(EDIT_GLYPH_PATH.crossfade).toBe("M1 1L11 11M11 1L1 11");
  });

  it("derives the join mode options in cut, fade, crossfade order", () => {
    expect(JOIN_MODE_OPTIONS).toEqual([
      { value: "cut", label: "Cut (no fade)", short: "Cut" },
      { value: "fade", label: "Fade at join (dip)", short: "Fade" },
      {
        value: "crossfade",
        label: "Crossfade (overlap both clips)",
        short: "Crossfade",
      },
    ]);
  });

  it.each([
    ["join-crossfade", 120, "Crossfade 120 ms"],
    ["join-crossfade", 0, "Crossfade"],
    ["join-fade", 80, "Fade 80 ms"],
    ["join-fade", 0, "Fade"],
    ["join-cut", 80, "Cut"],
    ["join-fade", 79.6, "Fade 80 ms"],
  ] as const)("labels a %s of %f ms as %s", (kind, ms, text) => {
    expect(joinMarkLabel(kind, ms)).toBe(text);
  });

  it("reads an unknown join mode as fade, as render does", () => {
    expect(joinKind({ join_in_mode: "cut" })).toBe("join-cut");
    expect(joinKind({ join_in_mode: "crossfade" })).toBe("join-crossfade");
    expect(joinKind({ join_in_mode: "fade" })).toBe("join-fade");
    expect(
      joinKind({ join_in_mode: "weird" as "fade" | "cut" | "crossfade" }),
    ).toBe("join-fade");
  });

  it("draws an unknown pending type as a removal", () => {
    expect(pendingKind("remove")).toBe("pending-remove");
    expect(pendingKind("mute")).toBe("pending-mute");
    expect(pendingKind("split")).toBe("pending-split");
    expect(pendingKind("toString")).toBe("pending-remove");
    expect(pendingKind("weird")).toBe("pending-remove");
  });

  it("names a pending type through the registry and capitalizes the unknown", () => {
    expect(pendingTypeLabel("remove")).toBe("Cut");
    expect(pendingTypeLabel("mute")).toBe("Mute");
    expect(pendingTypeLabel("split")).toBe("Split");
    expect(pendingTypeLabel("trim")).toBe("Trim");
  });

  it("types an applied tick by its mute flag first, then its kind", () => {
    expect(appliedKind({ kind: "seam", mute: false })).toBe("applied-seam");
    expect(appliedKind({ kind: "edge", mute: false })).toBe("applied-edge");
    expect(appliedKind({ kind: "seam", mute: true })).toBe("applied-mute");
    expect(appliedKind({ kind: "edge", mute: true })).toBe("applied-mute");
  });

  it("strips the state prefix for a class name", () => {
    expect(markerVariant("pending-remove")).toBe("remove");
    expect(markerVariant("applied-mute")).toBe("mute");
    expect(markerVariant("join-crossfade")).toBe("crossfade");
  });

  it("defines each type's color token in every theme block", () => {
    const blocks = [
      [theme("theme-dark.css"), 1],
      [theme("theme-light.css"), 2],
    ] as const;
    for (const [css, count] of blocks) {
      for (const type of TYPES) {
        const defined = css.match(
          new RegExp(`^\\s*--color-mark-${type}:`, "gm"),
        );
        expect(defined, `${type} in a theme file`).toHaveLength(count);
      }
    }
  });
});
