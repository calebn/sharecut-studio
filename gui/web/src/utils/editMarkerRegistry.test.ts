import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appliedKind,
  EDIT_MARKERS,
  type EditMarkerKind,
  joinKind,
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
  it("gives every kind a label and a type", () => {
    expect(KINDS).toHaveLength(9);
    expect(TYPES).toHaveLength(5);
    for (const kind of KINDS) {
      expect(markerLabel(kind).length).toBeGreaterThan(0);
    }
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

  it("types an applied tick by its mute flag", () => {
    expect(appliedKind({ mute: false })).toBe("applied-edge");
    expect(appliedKind({ mute: true })).toBe("applied-mute");
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
      for (const type of TYPES.filter(
        (t) => t !== "fade" && t !== "crossfade",
      )) {
        const defined = css.match(
          new RegExp(`^\\s*--color-mark-${type}:`, "gm"),
        );
        expect(defined, `${type} in a theme file`).toHaveLength(count);
      }
    }
  });
});
