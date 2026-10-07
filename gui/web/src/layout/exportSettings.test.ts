import { describe, expect, it } from "vitest";
import {
  exportResultCopy,
  exportSettingsFromConfig,
  exportStartBlocker,
  masterMeasuredCopy,
  selectedFormats,
} from "./exportSettings";

describe("exportSettingsFromConfig", () => {
  it("lists configured formats first, checked, then offers FLAC", () => {
    const settings = exportSettingsFromConfig({
      export: {
        wav: true,
        formats: [
          { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 },
          { ext: ".opus", codec: "libopus", bitrate_kbps: 96 },
        ],
      },
      master: { integrated_lufs: -16, true_peak_db: -1.5 },
    });
    expect(settings).toEqual({
      wav: true,
      choices: [
        {
          key: "mp3",
          label: "MP3 · 128 kbps",
          spec: { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 },
        },
        {
          key: "opus",
          label: "OPUS · 96 kbps",
          spec: { ext: "opus", codec: "libopus", bitrate_kbps: 96 },
        },
        {
          key: "flac",
          label: "FLAC · lossless",
          spec: { ext: "flac", codec: "flac" },
        },
      ],
      configured: ["mp3", "opus"],
      target: { lufs: -16, truePeakDb: -1.5 },
    });
  });

  it("falls back to one MP3 at mp3_bitrate_kbps without a formats list", () => {
    const settings = exportSettingsFromConfig({
      export: { wav: false, mp3_bitrate_kbps: 192 },
    });
    expect(settings.wav).toBe(false);
    expect(settings.configured).toEqual(["mp3"]);
    expect(settings.choices.map((c) => c.label)).toEqual([
      "MP3 · 192 kbps",
      "FLAC · lossless",
    ]);
    expect(settings.target).toBeNull();
  });

  it("does not offer FLAC twice when it is configured", () => {
    const settings = exportSettingsFromConfig({
      export: { formats: [{ ext: "flac", codec: "flac" }] },
    });
    expect(settings.choices.map((c) => c.key)).toEqual(["flac"]);
  });
});

describe("export choices", () => {
  const settings = exportSettingsFromConfig({
    export: { wav: false, formats: [{ ext: "mp3", bitrate_kbps: 128 }] },
  });

  it("sends the checked specs in display order", () => {
    expect(selectedFormats(settings, ["flac", "mp3"])).toEqual([
      { ext: "mp3", bitrate_kbps: 128 },
      { ext: "flac", codec: "flac" },
    ]);
  });

  it("blocks an export that would write nothing", () => {
    expect(exportStartBlocker(settings, [])).toBe(
      "Choose at least one format.",
    );
    expect(exportStartBlocker(settings, ["mp3"])).toBeNull();
    expect(exportStartBlocker(null, [])).toBeNull();
  });
});

describe("export outcome copy", () => {
  it("counts files", () => {
    expect(exportResultCopy(["a.wav"])).toBe("Exported 1 file to export/");
    expect(exportResultCopy(["a.wav", "a.mp3"])).toBe(
      "Exported 2 files to export/",
    );
  });

  it("reads the measured master", () => {
    expect(
      masterMeasuredCopy({
        measured: { integrated_lufs: -16.04, true_peak_db: -1.52 },
      }),
    ).toBe("Measured −16.0 LUFS, true peak −1.5 dBTP.");
    expect(masterMeasuredCopy({ measured: {} })).toBeNull();
    expect(masterMeasuredCopy(null)).toBeNull();
  });
});
