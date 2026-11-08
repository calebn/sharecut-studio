import { describe, expect, it } from "vitest";
import { SAMPLE_PREVIEW } from "./transcriptFixtures";
import {
  exportLabel,
  filesSummary,
  previewFooter,
  TRANSCRIPT_DEFAULTS,
  TRANSCRIPT_FORMATS,
  toggleFormat,
  transcriptBlocker,
  transcriptClock,
  transcriptStaleOf,
} from "./transcriptLogic";

describe("transcriptClock", () => {
  it("cuts to the whole second and adds hours from one hour", () => {
    expect(transcriptClock(0)).toBe("0:00");
    expect(transcriptClock(59.9)).toBe("0:59");
    expect(transcriptClock(3125)).toBe("52:05");
    expect(transcriptClock(3600)).toBe("1:00:00");
    expect(transcriptClock(-4)).toBe("0:00");
  });
});

describe("toggleFormat", () => {
  it("keeps chip order", () => {
    expect(toggleFormat(["srt"], "txt")).toEqual(["txt", "srt"]);
    expect(toggleFormat(["md", "srt"], "md")).toEqual(["srt"]);
  });

  it("offers a separate reading copy without changing the audio export defaults", () => {
    expect(TRANSCRIPT_FORMATS.map((format) => format.id)).toEqual([
      "txt",
      "md",
      "readable.txt",
      "srt",
      "vtt",
    ]);
    expect(TRANSCRIPT_DEFAULTS).toEqual(["md", "srt"]);
  });
});

describe("transcriptStaleOf", () => {
  const file = (format: "txt" | "md" | "srt" | "vtt", current: boolean) => ({
    name: `episode.${format}`,
    bytes: 900,
    format,
    current,
  });
  it.each([
    ["no files", [], false],
    ["outdated file of an unticked format", [file("txt", false)], false],
    ["outdated file of a ticked format", [file("srt", false)], true],
    ["current file of a ticked format", [file("srt", true)], false],
    ["ticked format with no file", [file("md", true)], false],
    [
      "outdated vtt while only md and srt are ticked",
      [file("vtt", false)],
      false,
    ],
  ] as const)("%s", (_name, files, expected) => {
    expect(transcriptStaleOf(files, ["md", "srt"])).toBe(expected);
  });

  it("is never stale with nothing ticked", () => {
    expect(transcriptStaleOf([file("md", false)], [])).toBe(false);
  });

  it("uses the listed transcript format when the project stem contains a format suffix", () => {
    const readable = {
      name: "Episode.readable.txt",
      current: false,
      format: "readable.txt" as const,
    };
    expect(transcriptStaleOf([readable], ["readable.txt"])).toBe(true);
    expect(transcriptStaleOf([readable], ["txt"])).toBe(false);

    const detailed = {
      name: "Episode.readable.txt",
      current: false,
      format: "txt" as const,
    };
    expect(transcriptStaleOf([detailed], ["txt"])).toBe(true);
    expect(transcriptStaleOf([detailed], ["readable.txt"])).toBe(false);
  });
});

describe("transcriptBlocker", () => {
  it("names why export cannot run", () => {
    const ready = { kind: "ready", preview: SAMPLE_PREVIEW } as const;
    expect(transcriptBlocker(ready, ["md"])).toBeNull();
    expect(transcriptBlocker(ready, [])).toBe("Choose at least one format.");
    expect(transcriptBlocker({ kind: "allCut" }, ["md"])).toMatch(/cut/);
    expect(transcriptBlocker({ kind: "loading" }, ["md"])).toMatch(/not ready/);
  });
});

describe("labels", () => {
  it("counts files and says again", () => {
    expect(exportLabel(1, false)).toBe("Export");
    expect(exportLabel(2, false)).toBe("Export 2 files");
    expect(exportLabel(3, true)).toBe("Export 3 files again");
  });

  it("summarises files and the preview footer", () => {
    const fmt = (b: number) => `${b} B`;
    expect(filesSummary([{ bytes: 1 }], fmt)).toBe("1 file · 1 B");
    expect(filesSummary([{ bytes: 1 }, { bytes: 2 }], fmt)).toBe(
      "2 files · 3 B",
    );
    expect(previewFooter(SAMPLE_PREVIEW)).toBe(
      "Showing 3 of 212 turns · 52:00 · English",
    );
    expect(previewFooter({ ...SAMPLE_PREVIEW, turns: 3 })).toMatch(/^3 turns/);
  });
});
