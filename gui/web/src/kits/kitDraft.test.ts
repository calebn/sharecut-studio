import { describe, expect, it } from "vitest";
import type { SegmentKind } from "../api";
import {
  type DraftAction,
  defaultAt,
  draftReducer,
  EMPTY_DRAFT,
  type KitDraft,
  MAX_ENTRIES,
  startsAfterStart,
  usesOf,
} from "./kitDraft";

function run(...actions: DraftAction[]): KitDraft {
  return actions.reduce(draftReducer, EMPTY_DRAFT);
}

const add = (segmentId: string, kind: SegmentKind = "other"): DraftAction => ({
  type: "add",
  segmentId,
  kind,
});

const ids = (draft: KitDraft) => draft.entries.map((entry) => entry.segmentId);

describe("defaultAt", () => {
  it("puts an intro at the start and every other kind at the end", () => {
    expect(defaultAt("intro")).toBe("start");
    for (const kind of ["outro", "sponsor", "sting", "other"] as const) {
      expect(defaultAt(kind)).toBe("end");
    }
  });
});

describe("draftReducer", () => {
  it("adds in order with stable uids and the kind's default placement", () => {
    const draft = run(add("a", "intro"), add("b", "outro"), add("a", "intro"));
    expect(draft.entries).toEqual([
      { uid: 1, segmentId: "a", at: "start" },
      { uid: 2, segmentId: "b", at: "end" },
      { uid: 3, segmentId: "a", at: "start" },
    ]);
  });

  it("holds at most 32 entries", () => {
    const full = run(
      ...Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => add(`s${i}`)),
    );
    expect(full.entries).toHaveLength(MAX_ENTRIES);
    expect(draftReducer(full, add("more"))).toBe(full);
  });

  it("moves an entry and leaves the ends where they are", () => {
    const draft = run(add("a"), add("b"), add("c"));
    expect(ids(draftReducer(draft, { type: "move", uid: 2, by: -1 }))).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(ids(draftReducer(draft, { type: "move", uid: 2, by: 1 }))).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(draftReducer(draft, { type: "move", uid: 1, by: -1 })).toBe(draft);
    expect(draftReducer(draft, { type: "move", uid: 3, by: 1 })).toBe(draft);
    expect(draftReducer(draft, { type: "move", uid: 99, by: 1 })).toBe(draft);
  });

  it("removes one entry by uid, even when a segment is in the kit twice", () => {
    const draft = run(add("a"), add("b"), add("a"));
    const next = draftReducer(draft, { type: "remove", uid: 1 });
    expect(next.entries.map((entry) => entry.uid)).toEqual([2, 3]);
    expect(usesOf(next.entries, "a")).toBe(1);
  });

  it("sets Start or End on one entry and resets to empty", () => {
    const draft = run(add("a"), { type: "setAt", uid: 1, at: "start" });
    expect(draft.entries[0].at).toBe("start");
    expect(run(add("a"), { type: "reset" })).toBe(EMPTY_DRAFT);
  });
});

describe("startsAfterStart", () => {
  it("names each Start entry that follows another and the one before it", () => {
    const draft = run(
      add("a", "intro"),
      add("b"),
      add("c", "intro"),
      add("d", "intro"),
    );
    expect([...startsAfterStart(draft.entries)]).toEqual([
      [3, 1],
      [4, 3],
    ]);
  });

  it("is empty for one Start entry among End entries", () => {
    const draft = run(add("a", "intro"), add("b"), add("c", "outro"));
    expect(startsAfterStart(draft.entries).size).toBe(0);
  });

  it("changes when a Start entry moves ahead", () => {
    const draft = run(add("a"), add("b", "intro"), add("c", "intro"));
    expect(startsAfterStart(draft.entries).get(3)).toBe(2);
    const swapped = draftReducer(draft, { type: "move", uid: 3, by: -1 });
    expect(startsAfterStart(swapped.entries).get(2)).toBe(3);
  });
});
