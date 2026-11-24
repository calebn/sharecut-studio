import { describe, expect, it, vi } from "vitest";
import { afterExportOf, type DeliverFiles, filesOfKinds } from "./deliverFiles";
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
    archive: null,
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

describe("afterExportOf", () => {
  const stale = { ...file("old.mp3", "audio"), current: false };
  const archive = { name: "ep-export.zip", count: 2, bytes: 9, href: "#all" };
  const source = (
    files: ExportedFile[],
    access: DeliverFiles["access"] = "reveal",
  ): DeliverFiles => ({
    files,
    access,
    archive: access === "download" ? archive : null,
  });

  it("offers the first current audio file to reveal once the export is finished", () => {
    const got = afterExportOf(
      source([file("ep.srt", "transcript"), file("ep.mp3", "audio")]),
      true,
    );
    expect(got).toMatchObject({ kind: "reveal", file: { id: "ep.mp3" } });
  });

  it("offers the archive to download, whatever audio the listing holds", () => {
    const onStarted = vi.fn();
    const got = afterExportOf({ ...source([], "download"), onStarted }, true);
    expect(got).toEqual({ kind: "archive", archive, onStarted });
  });

  it("offers nothing before an export finishes or without files", () => {
    const files = source([file("ep.mp3", "audio")]);
    expect(afterExportOf(files, false)).toBeUndefined();
    expect(afterExportOf(undefined, true)).toBeUndefined();
    expect(afterExportOf(source([]), true)).toBeUndefined();
  });

  it("skips stale audio and non-audio files to reveal", () => {
    expect(
      afterExportOf(source([stale, file("ep.srt", "transcript")]), true),
    ).toBeUndefined();
  });

  it("offers nothing to download when the server lists no archive", () => {
    expect(
      afterExportOf(
        { ...source([file("ep.mp3", "audio")], "download"), archive: null },
        true,
      ),
    ).toBeUndefined();
  });
});
