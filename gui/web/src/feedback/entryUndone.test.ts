import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId, ProjectView } from "../types/project";
import { entryUndone } from "./entryUndone";

const id = (v: string) => v as HistoryEntryId;

function history(
  head: string,
  groups: { before: string; after: string }[],
): ProjectView["history"] {
  return {
    ...minimalProject().history,
    head_id: id(head),
    groups: groups.map((g) => ({
      kind: "mutation",
      before_id: g.before,
      after_id: g.after,
    })),
  };
}

describe("entryUndone", () => {
  const groups = [
    { before: "e0", after: "e1" },
    { before: "e1", after: "e2" },
  ];

  it("is true when the head sits at the step before the entry", () => {
    expect(entryUndone(history("e0", groups), id("e1"))).toBe(true);
  });

  it("is false while the head is at the entry itself (Redo)", () => {
    expect(entryUndone(history("e1", groups), id("e1"))).toBe(false);
  });

  it("is false when a newer edit sits on top of the entry", () => {
    expect(entryUndone(history("e2", groups), id("e1"))).toBe(false);
  });

  it("is false when no group names the entry", () => {
    expect(entryUndone(history("e0", []), id("e1"))).toBe(false);
    expect(entryUndone(history("e0", groups), id("zz"))).toBe(false);
  });
});
