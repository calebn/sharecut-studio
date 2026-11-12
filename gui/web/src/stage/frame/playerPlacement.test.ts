import { describe, expect, it } from "vitest";

import type { ShellBreakpoint } from "../../state/types";
import type { StageId, StageRole } from "../../types/stage";
import { type PlayerPlacement, playerPlacementOf } from "./playerPlacement";

type Row = [
  stage: StageId,
  shell: ShellBreakpoint,
  role: StageRole,
  short: boolean,
  placement: PlayerPlacement,
];

const TABLE: Row[] = [
  ["review", "phone", "commenter", false, "dock"],
  ["review", "phone", "commenter", true, "dock"],
  ["review", "phone", "viewer", false, "dock"],
  ["review", "phone", "viewer", true, "dock"],
  ["review", "phone", "editor", false, "bar"],
  ["review", "phone", "editor", true, "bar"],
  ["review", "phone", "host", false, "bar"],
  ["review", "tablet", "commenter", false, "card"],
  ["review", "tablet", "commenter", true, "bar"],
  ["review", "tablet", "viewer", false, "card"],
  ["review", "tablet", "editor", false, "card"],
  ["review", "tablet", "host", false, "bar"],
  ["review", "desktop", "commenter", false, "card"],
  ["review", "desktop", "commenter", true, "bar"],
  ["review", "desktop", "host", false, "bar"],
  ["edit", "phone", "editor", false, "bar"],
  ["edit", "phone", "host", false, "bar"],
  ["deliver", "phone", "editor", false, "bar"],
  ["deliver", "desktop", "host", false, "bar"],
  ["record", "phone", "commenter", false, "none"],
  ["record", "desktop", "host", false, "none"],
];

describe("playerPlacementOf", () => {
  it.each(TABLE)(
    "%s on a %s shell for a %s (short %s) gives %s",
    (stage, shell, role, short, placement) => {
      expect(playerPlacementOf({ stage, shell, role, short })).toBe(placement);
    },
  );
});
