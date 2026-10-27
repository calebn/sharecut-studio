import { describe, expect, it } from "vitest";
import {
  canSendNote,
  isRestrictedNote,
  type NoteItem,
  noteSnippet,
  sortNotes,
  visibleNotes,
} from "./notesRailModel";

const note = (over: Partial<NoteItem> & { id: string }): NoteItem => ({
  kind: "note",
  author: { name: "Rosa" },
  text: "Hi",
  time: "12:04",
  visibility: "everyone",
  ...over,
});

describe("sortNotes", () => {
  it("orders by the recording clock, not by arrival", () => {
    const sorted = sortNotes([
      note({ id: "c", time: "12:10" }),
      note({ id: "a", time: "9:59" }),
      note({ id: "b", time: "10:00" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("puts a session-level note first, at the session start", () => {
    const sorted = sortNotes([
      note({ id: "timed", time: "00:30" }),
      note({ id: "session", time: null }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["session", "timed"]);
  });

  it("breaks a tie on the id so the order is deterministic", () => {
    const sorted = sortNotes([
      note({ id: "z", time: "12:04" }),
      note({ id: "m", time: "12:04" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["m", "z"]);
  });

  it("reads hours and does not mix up 10:00 and 9:00", () => {
    const sorted = sortNotes([
      note({ id: "ten", time: "10:00" }),
      note({ id: "nine", time: "9:00" }),
      note({ id: "hours", time: "1:02:03" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["nine", "ten", "hours"]);
  });

  it("does not change its input", () => {
    const input = [
      note({ id: "b", time: "12:10" }),
      note({ id: "a", time: "12:01" }),
    ];
    sortNotes(input);
    expect(input.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("visibleNotes", () => {
  const items: NoteItem[] = [
    note({
      id: "mark",
      kind: "marker",
      text: undefined,
      author: { name: "Jon" },
    }),
    note({ id: "all", visibility: "everyone", author: { name: "Rosa" } }),
    note({ id: "hosts", visibility: "hosts", author: { name: "Rosa" } }),
    note({ id: "mine", visibility: "hosts", author: { name: "Maya" } }),
  ];

  it("shows hosts and producers every row", () => {
    expect(visibleNotes(items, "host", "Maya")).toHaveLength(4);
    expect(visibleNotes(items, "producer", "Jon")).toHaveLength(4);
  });

  it("shows a guest the markers, everyone-notes and their own notes", () => {
    expect(visibleNotes(items, "guest", "Maya").map((item) => item.id)).toEqual(
      ["mark", "all", "mine"],
    );
  });

  it("hides another guest's hosts-only note from a guest", () => {
    expect(visibleNotes(items, "guest", "Sam").map((item) => item.id)).toEqual([
      "mark",
      "all",
    ]);
  });

  it("matches the guest's own name ignoring surrounding spaces", () => {
    expect(
      visibleNotes(
        [note({ id: "p", visibility: "hosts", author: { name: "Maya" } })],
        "guest",
        "  Maya ",
      ).map((item) => item.id),
    ).toEqual(["p"]);
  });

  it("shows a guest nothing private when they have no name", () => {
    expect(visibleNotes(items, "guest", "  ").map((item) => item.id)).toEqual([
      "mark",
      "all",
    ]);
  });
});

describe("noteSnippet and restriction", () => {
  it("reads a marker as Marker and a note as its text", () => {
    expect(
      noteSnippet(note({ id: "m", kind: "marker", text: undefined })),
    ).toBe("Marker");
    expect(noteSnippet(note({ id: "n", text: "  Keep this.  " }))).toBe(
      "Keep this.",
    );
    expect(noteSnippet(note({ id: "e", text: undefined }))).toBe("");
  });

  it("restricts only a hosts-only text note", () => {
    expect(isRestrictedNote(note({ id: "h", visibility: "hosts" }))).toBe(true);
    expect(isRestrictedNote(note({ id: "e", visibility: "everyone" }))).toBe(
      false,
    );
    expect(
      isRestrictedNote(note({ id: "m", kind: "marker", text: undefined })),
    ).toBe(false);
  });
});

describe("canSendNote", () => {
  it("needs a word that is not only spaces", () => {
    expect(canSendNote("")).toBe(false);
    expect(canSendNote("   \n ")).toBe(false);
    expect(canSendNote(" ok ")).toBe(true);
  });
});
