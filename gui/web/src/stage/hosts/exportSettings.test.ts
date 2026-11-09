import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT } from "../../test/sourceFiles";
import {
  exportResultCopy,
  exportSettingsFromConfig,
  isLossless,
  loudnessTargetCopy,
  masterMeasured,
  masterMeasuredCopy,
  resolveExport,
  sameExportFormats,
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
          spec: { ext: ".opus", codec: "libopus", bitrate_kbps: 96 },
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
      master: { lufs: -16, truePeakDb: -1.5 },
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
    expect(settings.master).toEqual({});
  });

  it.each([
    ["missing", {}, true],
    ["false", { wav: false }, false],
    ["true", { wav: true }, true],
    ["null", { wav: null }, false],
    ["zero", { wav: 0 }, false],
    ["nonzero", { wav: -1 }, true],
    ["empty string", { wav: "" }, false],
    ["nonempty string", { wav: "false" }, true],
    ["empty sequence", { wav: [] }, false],
    ["nonempty sequence", { wav: [0] }, true],
    ["empty mapping", { wav: {} }, false],
    ["nonempty mapping", { wav: { enabled: false } }, true],
  ])("interprets the producer WAV flag for %s", (_name, config, expected) => {
    expect(exportSettingsFromConfig({ export: config }).wav).toBe(expected);
  });

  it.each([
    {
      name: "an all-dot primary extension",
      formats: [{ ext: "...", extension: "mp3" }],
    },
    {
      name: "a record without an extension",
      formats: [{ ext: "mp3" }, { codec: "flac" }],
    },
    { name: "a non-string extension", formats: [{ ext: 3 }] },
    { name: "a non-record entry", formats: ["mp3"] },
    { name: "a non-list formats value", formats: { ext: "mp3" } },
  ])("fails the settings read for $name", ({ formats }) => {
    expect(() => exportSettingsFromConfig({ export: { formats } })).toThrow(
      "Could not read the configured export formats",
    );
  });

  it.each([{ formats: null }, { formats: [] }])(
    "keeps explicit formats $formats empty",
    ({ formats }) => {
      const settings = exportSettingsFromConfig({ export: { formats } });
      expect(resolveExport(settings, settings.configured)).toEqual([]);
      expect(settings.choices.map(({ key }) => key)).toEqual(["m4a", "flac"]);
    },
  );

  it("retains only finite observed master settings, including zero true peak", () => {
    const partial = exportSettingsFromConfig({
      master: { integrated_lufs: NaN, true_peak_db: 0, lra: Infinity },
    });
    expect(partial.master).toEqual({ truePeakDb: 0 });
    expect(loudnessTargetCopy(partial.master)).toBeNull();

    const full = exportSettingsFromConfig({
      master: { integrated_lufs: -16, true_peak_db: 0, lra: 11 },
    });
    expect(loudnessTargetCopy(full.master)).toBe(
      "Project target preview is −16.0 LUFS, peaks under 0.0 dBTP.",
    );
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

describe("resolved hosted output settings", () => {
  const mp3Encoding = {
    codec: "libmp3lame",
    bitrate_kbps: 128,
    options: {
      channels: 2,
      flags: ["first", "second"],
      metadata: { title: "Episode", enabled: true, value: null },
    },
  };
  const mp3 = { ext: "mp3", ...mp3Encoding };
  const flac = { ext: "flac", codec: "flac" };
  const config = (formats: unknown[]) =>
    exportSettingsFromConfig({ export: { formats } });

  it.each([
    {
      name: "a lone extension alias",
      aliases: { extension: ".MP3" },
      expected: { extension: ".MP3" },
    },
    {
      name: "exactly agreeing raw aliases",
      aliases: { ext: ".MP3", extension: ".MP3" },
      expected: { ext: ".MP3", extension: ".MP3" },
    },
    {
      name: "conflicting string aliases",
      aliases: { ext: "mp3", extension: "flac" },
      expected: { ext: "mp3", extension: "flac" },
    },
    {
      name: "a null ext with an extension alias",
      aliases: { ext: null, extension: "mp3" },
      expected: { ext: null, extension: "mp3" },
    },
    {
      name: "an empty ext with an extension alias",
      aliases: { ext: "", extension: "mp3" },
      expected: { ext: "", extension: "mp3" },
    },
  ])(
    "preserves producer format fidelity for $name",
    ({ aliases, expected }) => {
      const settings = config([{ ...aliases, ...mp3Encoding }]);
      expect.soft(settings.configured).toEqual(["mp3"]);
      expect.soft(settings.choices[0].label).toBe("MP3 · 128 kbps");
      expect(resolveExport(settings, ["mp3"])).toEqual([
        { ...expected, ...mp3Encoding },
      ]);
    },
  );

  it("compares an extension conflict literally without losing it in the request", () => {
    const conflict = { ext: "mp3", extension: "flac", bitrate_kbps: 128 };
    const literal = resolveExport(config([conflict]), ["mp3"]);
    expect(literal).toEqual([conflict]);
    expect(
      sameExportFormats(literal, [
        { bitrate_kbps: 128, extension: "flac", ext: "mp3" },
      ]),
    ).toBe(true);
    expect(
      sameExportFormats(literal, [{ ext: "mp3", bitrate_kbps: 128 }]),
    ).toBe(false);
    expect(
      sameExportFormats(literal, [{ ...conflict, extension: ".FLAC" }]),
    ).toBe(false);
  });

  it.each([null, false, 0, [], {}, "."])(
    "retains an unsupported inactive alias %j as raw options",
    (extension) => {
      const raw = { ext: "mp3", extension, bitrate_kbps: 128 };
      const literal = resolveExport(config([raw]), ["mp3"]);
      expect(literal).toEqual([raw]);
      expect(
        sameExportFormats(literal, [{ ext: "mp3", bitrate_kbps: 128 }]),
      ).toBe(false);
      expect(sameExportFormats(literal, [raw])).toBe(true);
    },
  );

  it("compares a null ext conflict in the selected extension's sequence", () => {
    const conflict = { ext: null, extension: "mp3", bitrate_kbps: 96 };
    const original = resolveExport(config([conflict, flac, mp3]), [
      "mp3",
      "flac",
    ]);
    const reversed = resolveExport(config([flac, mp3, conflict]), [
      "mp3",
      "flac",
    ]);
    expect(sameExportFormats(original, reversed)).toBe(false);
  });

  it("compares complete specs independently of object and format order without reordering the payload", () => {
    const original = resolveExport(config([mp3, flac]), ["flac", "mp3"]);
    const reordered = resolveExport(
      config([
        flac,
        {
          options: {
            metadata: { value: null, enabled: true, title: "Episode" },
            flags: ["first", "second"],
            channels: 2,
          },
          bitrate_kbps: 128,
          codec: "libmp3lame",
          ext: "mp3",
        },
      ]),
      ["mp3", "flac"],
    );
    expect(original).toEqual([mp3, flac]);
    expect(reordered).toEqual([flac, mp3]);
    expect(sameExportFormats(original, reordered)).toBe(true);
  });

  it.each([
    { ...mp3, bitrate_kbps: 96 },
    { ...mp3, codec: "another-codec" },
    { ...mp3, format: "another-container" },
    { ...mp3, future: { enabled: true, values: [1, null, "x"] } },
    { ...mp3, options: { ...mp3.options, flags: ["second", "first"] } },
  ])(
    "marks a changed full encoding stale and restores its original request",
    (changed) => {
      const wrote = resolveExport(config([mp3, flac]), ["mp3", "flac"]);
      const current = resolveExport(config([changed, flac]), ["mp3", "flac"]);
      expect(sameExportFormats(wrote, current)).toBe(false);
      expect(
        sameExportFormats(
          wrote,
          resolveExport(config([mp3, flac]), ["flac", "mp3"]),
        ),
      ).toBe(true);
    },
  );

  it("retains duplicate format multiplicity", () => {
    const single = resolveExport(config([mp3]), ["mp3"]);
    const duplicate = resolveExport(config([mp3, mp3]), ["mp3"]);
    expect(duplicate).toEqual([mp3, mp3]);
    expect(sameExportFormats(single, duplicate)).toBe(false);
  });

  it.each(["mp3", ".MP3", "..MP3"])(
    "marks a canonical export stale when %s and mp3 encodes trade places",
    (ext) => {
      const low = { ext, bitrate_kbps: 96 };
      const high = { ext: "mp3", bitrate_kbps: 192 };
      const resolveDefaults = (formats: unknown[]) => {
        const settings = config(formats);
        return resolveExport(settings, settings.configured);
      };
      const original = resolveDefaults([low, flac, high]);
      const reversed = resolveDefaults([flac, high, low]);
      expect
        .soft(original)
        .toEqual([
          low,
          { ext: "flac", codec: "flac" },
          { ext: "mp3", bitrate_kbps: 192 },
        ]);
      expect
        .soft(reversed)
        .toEqual([
          { ext: "flac", codec: "flac" },
          { ext: "mp3", bitrate_kbps: 192 },
          low,
        ]);
      expect.soft(sameExportFormats(original, reversed)).toBe(false);
      const restored = resolveDefaults([flac, low, high]);
      expect(sameExportFormats(original, restored)).toBe(true);
    },
  );

  it("snapshots nested submitted specs and preserves unavailable settings and explicit empty formats", () => {
    const settings = config([mp3]);
    const options = structuredClone(mp3.options);
    settings.choices[0].spec.options = options;
    const resolved = resolveExport(settings, ["mp3"]);
    options.metadata.title = "Revised";
    options.flags.reverse();
    expect(resolved).toEqual([
      {
        ext: "mp3",
        codec: "libmp3lame",
        bitrate_kbps: 128,
        options: {
          channels: 2,
          flags: ["first", "second"],
          metadata: { title: "Episode", enabled: true, value: null },
        },
      },
    ]);
    expect(sameExportFormats(resolved, resolveExport(settings, ["mp3"]))).toBe(
      false,
    );
    expect(resolveExport(null, ["mp3"])).toBeNull();
    const empty = resolveExport(config([]), []);
    expect(empty).toEqual([]);
    expect(sameExportFormats(empty, resolveExport(null, []))).toBe(false);
  });
});
