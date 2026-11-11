import { describe, expect, it } from "vitest";
import { type ExportedFile, groupByKind } from "./exportedFileModel";

const file = (
  id: string,
  kind: ExportedFile["kind"],
  label = "Label",
): ExportedFile => ({
  id,
  name: id.split("/").pop() ?? id,
  kind,
  label,
  bytes: 10,
  current: true,
});

describe("groupByKind", () => {
  it("groups by kind in a fixed order and keeps the server order inside a kind", () => {
    const groups = groupByKind([
      file("a.srt", "transcript"),
      file("b.wav", "audio"),
      file("a.mp3", "audio"),
    ]);

    expect(groups.map((g) => [g.title, g.files.map((f) => f.id)])).toEqual([
      ["Audio", ["b.wav", "a.mp3"]],
      ["Transcript", ["a.srt"]],
    ]);
  });

  it("lists selection exports in their own group after the episode files", () => {
    const groups = groupByKind([
      file("bounces/range.wav", "bounce", "Unmastered export"),
      file("show.wav", "audio"),
    ]);

    expect(groups.map((g) => [g.title, g.files.map((f) => f.id)])).toEqual([
      ["Audio", ["show.wav"]],
      ["Exports of a selection", ["bounces/range.wav"]],
    ]);
  });
});
