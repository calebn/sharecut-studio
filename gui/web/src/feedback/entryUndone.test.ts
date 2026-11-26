import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import type {
  HistoryEntryId,
  HistoryEntryView,
  ProjectView,
} from "../types/project";
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

/** The live /api/project shape: ordered `entries`, snapshot-kind groups with `id` and `index` only. */
function realHistory(head: string, ids: string[]): ProjectView["history"] {
  const entries: HistoryEntryView[] = ids.map((entryId, index) => ({
    index,
    id: id(entryId),
    label: `step ${index}`,
    current: entryId === head,
  }));
  return {
    ...minimalProject().history,
    head_id: id(head),
    entries,
    groups: entries.map((e) => ({
      kind: "snapshot",
      index: e.index,
      id: e.id,
      label: e.label,
    })),
  };
}

describe("entryUndone on the real history shape", () => {
  const ids = ["s0", "s1", "render", "approve"];

  it("is true when the head sits before the entry in entries", () => {
    expect(entryUndone(realHistory("render", ids), id("approve"))).toBe(true);
    expect(entryUndone(realHistory("s0", ids), id("approve"))).toBe(true);
  });

  it("is false at the entry itself or past it", () => {
    expect(entryUndone(realHistory("approve", ids), id("approve"))).toBe(false);
    expect(entryUndone(realHistory("approve", ids), id("render"))).toBe(false);
  });

  it("is false when the entry is not among the entries", () => {
    expect(entryUndone(realHistory("render", ids), id("gone"))).toBe(false);
  });

  it("is false when the head is not among the entries", () => {
    expect(entryUndone(realHistory("elsewhere", ids), id("approve"))).toBe(
      false,
    );
  });
});

describe("entryUndone from groups alone (the document-sync shape)", () => {
  const withGroups = (head: string): ProjectView["history"] => ({
    ...minimalProject().history,
    head_id: id(head),
    groups: [
      {
        kind: "mutation",
        before_index: 0,
        after_index: 1,
        before_id: "s0",
        after_id: "s1",
      },
      { kind: "snapshot", index: 2, id: "render" },
      { kind: "snapshot", index: 3, id: "approve" },
    ],
  });

  it("is true once the head is before the entry, false at or past it", () => {
    expect(entryUndone(withGroups("render"), id("approve"))).toBe(true);
    expect(entryUndone(withGroups("s0"), id("approve"))).toBe(true);
    expect(entryUndone(withGroups("approve"), id("approve"))).toBe(false);
    expect(entryUndone(withGroups("render"), id("gone"))).toBe(false);
  });
});
