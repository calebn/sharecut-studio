import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT } from "../../test/sourceFiles";
import {
  exportResultCopy,
  exportSettingsFromConfig,
  isLossless,
  masterMeasured,
  masterMeasuredCopy,
  selectedFormats,
} from "./exportSettings";

const M4A_PRESET = JSON.parse(
  readFileSync(
    join(SRC_ROOT, "../../../contracts/export-presets.json"),
    "utf-8",
  ),
).m4a;

describe("exportSettingsFromConfig", () => {
  it("lists configured formats first, checked, then offers M4A and FLAC", () => {
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
          key: "m4a",
          label: "M4A (AAC) · 128 kbps",
          spec: M4A_PRESET,
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
      "M4A (AAC) · 128 kbps",
      "FLAC · lossless",
    ]);
    expect(settings.target).toBeNull();
  });

  it("does not offer FLAC twice when it is configured", () => {
    const settings = exportSettingsFromConfig({
      export: { formats: [{ ext: "flac", codec: "flac" }] },
    });
    expect(settings.choices.map((c) => c.key)).toEqual(["flac", "m4a"]);
  });

  it("does not offer M4A twice, and keeps the configured M4A spec", () => {
    const configured = { ext: "m4a", codec: "alac" };
    const settings = exportSettingsFromConfig({
      export: { formats: [configured] },
    });
    expect(settings.choices.map((c) => c.key)).toEqual(["m4a", "flac"]);
    expect(settings.choices[0].spec).toEqual(configured);
    expect(settings.choices[0].label).toBe("M4A");
  });

  it("labels M4A as AAC only when the codec is AAC", () => {
    const label = (spec: { ext: string; codec?: string }) =>
      exportSettingsFromConfig({ export: { formats: [spec] } }).choices[0]
        .label;
    expect(label({ ext: "m4a" })).toBe("M4A (AAC)");
    expect(label({ ext: "flac", codec: "aac" })).toBe("FLAC · lossless");
    expect(label({ ext: "mp3", codec: "aac" })).toBe("MP3");
  });

  it("sends every checked format, M4A and FLAC together", () => {
    const settings = exportSettingsFromConfig({ export: { formats: [] } });
    expect(selectedFormats(settings, ["m4a", "flac"])).toEqual([
      M4A_PRESET,
      { ext: "flac", codec: "flac" },
    ]);
  });

  it("offers the M4A spec the server pins in contracts/export-presets.json", () => {
    const settings = exportSettingsFromConfig({ export: { formats: [] } });
    expect(settings.choices.find((c) => c.key === "m4a")?.spec).toEqual(
      M4A_PRESET,
    );
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

  it("hands the measured numbers over, true peak only when reported", () => {
    expect(
      masterMeasured({
        measured: { integrated_lufs: -16.04, true_peak_db: -1.52 },
      }),
    ).toEqual({ lufs: -16.04, truePeak: -1.52 });
    expect(masterMeasured({ measured: { integrated_lufs: -16 } })).toEqual({
      lufs: -16,
    });
    expect(masterMeasured({ measured: { true_peak_db: -1 } })).toBeNull();
  });

  it("knows which formats are lossless", () => {
    expect(["flac", "wav", "alac"].map(isLossless)).toEqual([true, true, true]);
    expect(["mp3", "m4a"].map(isLossless)).toEqual([false, false]);
  });
});
