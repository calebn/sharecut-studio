import { describe, expect, it, vi } from "vitest";
import { type DeliverFiles, filesOfKinds } from "./deliverFiles";
import type { ExportedFile } from "./exportedFileModel";

const file = (id: string, kind: ExportedFile["kind"]): ExportedFile => ({
  id,
  name: id,
  kind,
  label: kind,
  bytes: 1,
  current: true,
});

describe("filesOfKinds", () => {
  const onReveal = vi.fn();
  const onStarted = vi.fn();
  const source: DeliverFiles = {
    files: [
      file("ep.mp3", "audio"),
      file("ep.srt", "transcript"),
      file("ep.chapters.json", "chapters"),
      file("ep.feed.xml", "feed"),
    ],
    access: "download",
    onReveal,
    onStarted,
  };

  it("keeps only the kinds a section owns, in the server's order", () => {
    const list = filesOfKinds(source, ["audio", "chapters"], false);
    expect(list.files.map((f) => f.id)).toEqual(["ep.mp3", "ep.chapters.json"]);
  });

  it("carries the access, the handlers and the running flag", () => {
    const list = filesOfKinds(source, ["feed"], true);
    expect(list).toMatchObject({
      access: "download",
      running: true,
      onReveal,
      onStarted,
    });
    expect(list.files.map((f) => f.id)).toEqual(["ep.feed.xml"]);
  });

  it("is empty when the folder holds none of the kinds", () => {
    expect(
      filesOfKinds({ ...source, files: [] }, ["audio"], false).files,
    ).toEqual([]);
  });
});
