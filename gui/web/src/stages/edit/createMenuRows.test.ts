import { describe, expect, it } from "vitest";
import { SYSTEM_ICON_NAMES } from "../../system/icons";
import { verbOf } from "../../system/verbDisplay";
import {
  type CreateFacts,
  createMenuRows,
  rowKeyShortcuts,
  rowShortcut,
} from "./createMenuRows";

const here: CreateFacts = {
  lane: true,
  envelopeShown: true,
  clipboardHasAudio: false,
};
const ids = (facts: CreateFacts) => createMenuRows(facts).map((row) => row.id);

describe("createMenuRows", () => {
  it("lists Split, Comment, Add chapter and Add volume point on a lane with the envelope showing", () => {
    expect(ids(here)).toEqual([
      "split",
      "comment",
      "addChapter",
      "addVolumePoint",
    ]);
  });

  it("names the rows as the spec does", () => {
    expect(
      createMenuRows({ ...here, clipboardHasAudio: true }).map(
        (row) => row.label,
      ),
    ).toEqual([
      "Split here",
      "Comment here",
      "Add chapter here",
      "Add volume point",
      "Paste",
    ]);
  });

  it("leaves the volume point out off a lane, and while the envelope is hidden, instead of disabling it", () => {
    expect(ids({ ...here, lane: false })).toEqual([
      "split",
      "comment",
      "addChapter",
    ]);
    expect(ids({ ...here, envelopeShown: false })).toEqual([
      "split",
      "comment",
      "addChapter",
    ]);
  });

  it("adds Paste only when the clipboard has audio, last", () => {
    expect(ids(here)).not.toContain("paste");
    expect(ids({ ...here, clipboardHasAudio: true }).at(-1)).toBe("paste");
    expect(
      ids({ lane: false, envelopeShown: false, clipboardHasAudio: true }),
    ).toEqual(["split", "comment", "addChapter", "paste"]);
  });

  it("starts a group only at the lane's own row", () => {
    const rows = createMenuRows({ ...here, clipboardHasAudio: true });
    expect(rows.filter((row) => row.startsGroup).map((row) => row.id)).toEqual([
      "addVolumePoint",
    ]);
  });

  it("takes the verb rows' icons and keys from the verb table, and gives the local rows icons that exist", () => {
    const rows = createMenuRows({ ...here, clipboardHasAudio: true });
    const row = (id: string) => rows.find((entry) => entry.id === id);
    expect(row("split")?.icon).toBe(verbOf("split").icon);
    expect(row("split")?.keys).toBe(verbOf("split").keys);
    expect(row("comment")?.icon).toBe(verbOf("comment").icon);
    expect(row("addChapter")?.icon).toBe(verbOf("addChapter").icon);
    expect(row("addVolumePoint")?.icon).toBe("spline");
    expect(row("paste")?.icon).toBe("clipboard-paste");
    const names = new Set<string>(SYSTEM_ICON_NAMES);
    expect(rows.filter((entry) => !names.has(entry.icon))).toEqual([]);
  });

  it("shows the first chord on a row and announces every chord", () => {
    const rows = createMenuRows({ ...here, clipboardHasAudio: true });
    const row = (id: string) => {
      const found = rows.find((entry) => entry.id === id);
      if (!found) throw new Error(`No ${id} row`);
      return found;
    };
    expect(rowShortcut(row("split"))).toBe("S");
    expect(rowShortcut(row("comment"))).toBe("C");
    expect(rowShortcut(row("addChapter"))).toBe("⇧ C");
    expect(rowShortcut(row("addVolumePoint"))).toBeUndefined();
    expect(rowKeyShortcuts(row("split"), false)).toBe("S Control+K");
    expect(rowKeyShortcuts(row("split"), true)).toBe("S Meta+K");
    expect(rowKeyShortcuts(row("addChapter"), false)).toBe("Shift+C");
    expect(rowKeyShortcuts(row("paste"), false)).toBeUndefined();
  });

  it("carries no command id, so the host maps ids to commands with the held time", () => {
    for (const row of createMenuRows({ ...here, clipboardHasAudio: true })) {
      expect(Object.keys(row).sort()).not.toContain("commandId");
    }
  });
});
