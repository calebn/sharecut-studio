import { afterEach, describe, expect, it, vi } from "vitest";
import { readExportSettings, startExportJob } from "../api";
import type { LoudnessId } from "../types/pipeline";
import { parseExportEvidence, parseExportSettingsRead } from "./exportEvidence";

const EVIDENCE = {
  version: 1,
  basis: " opaque basis ",
  target: null,
  master_target: { integrated_lufs: -16, true_peak_db: -1.5, lra: 11 },
  qc_limits: { lufs_tolerance_lu: 0.5, true_peak_tolerance_db: 0.3 },
  audio_formats: [
    "other",
    "wav",
    "mp3",
    "mp3",
    "m4a",
    "aac",
    "opus",
    "ogg",
    "flac",
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("export settings evidence", () => {
  it("keeps the opaque basis exactly and accepts an empty audio plan", () => {
    expect(parseExportEvidence(EVIDENCE, null)).toEqual({
      basis: " opaque basis ",
      target: null,
    });
    expect(
      parseExportEvidence({ ...EVIDENCE, audio_formats: [] }, null),
    ).toEqual({
      basis: " opaque basis ",
      target: null,
    });
  });

  it.each([
    undefined,
    null,
    { ...EVIDENCE, version: 2 },
    { ...EVIDENCE, basis: " " },
    { ...EVIDENCE, target: undefined },
    { ...EVIDENCE, target: "podcast" },
    {
      ...EVIDENCE,
      master_target: { ...EVIDENCE.master_target, integrated_lufs: "-16" },
    },
    {
      ...EVIDENCE,
      master_target: { ...EVIDENCE.master_target, true_peak_db: NaN },
    },
    {
      ...EVIDENCE,
      master_target: { ...EVIDENCE.master_target, lra: undefined },
    },
    {
      ...EVIDENCE,
      qc_limits: { ...EVIDENCE.qc_limits, lufs_tolerance_lu: Infinity },
    },
    {
      ...EVIDENCE,
      qc_limits: { ...EVIDENCE.qc_limits, true_peak_tolerance_db: null },
    },
    { ...EVIDENCE, audio_formats: ["future"] },
    { ...EVIDENCE, audio_formats: "wav" },
  ])("leaves invalid evidence unknown (%j)", (value) => {
    expect(parseExportEvidence(value, null)).toBeNull();
  });

  it("requires an available envelope even when the response contains valid evidence", () => {
    expect(
      parseExportSettingsRead(
        { status: "available", settings: EVIDENCE },
        null,
      ),
    ).toEqual({
      basis: " opaque basis ",
      target: null,
    });
    expect(
      parseExportSettingsRead(
        { status: "unavailable", settings: EVIDENCE },
        null,
      ),
    ).toBeNull();
  });
});

const RAW = [
  { extension: ".MP3", options: { flags: ["first", "second"] } },
  { ext: "flac", codec: "flac" },
];
const NAMED = [
  { extension: ".MP3", codec: "libmp3lame", bitrate_kbps: 128 },
  { ext: "flac", codec: "flac" },
];
const TARGETS: LoudnessId[] = ["broadcast", "podcast", "streaming"];

describe("export settings transport", () => {
  it.each([
    { formats: null, target: null },
    { formats: [], target: null },
    { formats: RAW, target: null },
    ...TARGETS.map((target) => ({ formats: NAMED, target })),
  ])(
    "uses the same frozen start and read body for $formats and $target",
    async ({ formats, target }) => {
      const fetch = vi.fn(async (url: string, _init: RequestInit) =>
        url.endsWith("/settings")
          ? Response.json({
              status: "available",
              settings: { ...EVIDENCE, target },
            })
          : Response.json({ job_id: "synthetic" }),
      );
      vi.stubGlobal("fetch", fetch);
      const path = "/tmp/ep/episode.sharecut";
      const signal = new AbortController().signal;

      expect(await startExportJob(path, formats, target)).toMatchObject({
        id: "synthetic",
      });
      expect(await readExportSettings(path, formats, target, signal)).toEqual({
        basis: " opaque basis ",
        target,
      });

      const body = { path, formats, ...(target === null ? {} : { target }) };
      expect(
        fetch.mock.calls.map(([url, init]) => ({
          url,
          method: init.method,
          body: typeof init.body === "string" ? JSON.parse(init.body) : null,
          signal: init.signal,
        })),
      ).toEqual([
        {
          url: "/api/export/deliverables",
          method: "POST",
          body,
          signal: undefined,
        },
        {
          url: "/api/export/deliverables/settings",
          method: "POST",
          body,
          signal,
        },
      ]);
    },
  );

  it.each(["share:review", "record:recording"])(
    "keeps %s off the host settings route",
    async (key) => {
      const fetch = vi.fn(async () =>
        Response.json({ status: "available", settings: EVIDENCE }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        readExportSettings(key, null, null, new AbortController().signal),
      ).rejects.toThrow("This isn't available in a shared view.");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
