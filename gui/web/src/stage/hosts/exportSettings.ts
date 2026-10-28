type ExportFormatSpec = {
  ext: string;
  codec?: string;
  bitrate_kbps?: number;
  [key: string]: unknown;
};

type ExportFormatChoice = {
  key: string;
  label: string;
  spec: ExportFormatSpec;
};

export type ExportSettings = {
  wav: boolean;
  choices: ExportFormatChoice[];
  configured: string[];
  target: { lufs: number; truePeakDb: number } | null;
};

const FLAC: ExportFormatSpec = { ext: "flac", codec: "flac" };

const M4A: ExportFormatSpec = {
  ext: "m4a",
  codec: "aac",
  format: "ipod",
  bitrate_kbps: 128,
};

const OFFERED: readonly ExportFormatSpec[] = [M4A, FLAC];

const LOSSLESS = new Set(["flac", "wav", "alac"]);

export function isLossless(ext: string): boolean {
  return LOSSLESS.has(ext);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asSpec(value: unknown): ExportFormatSpec | null {
  const rec = asRecord(value);
  const raw = rec.ext ?? rec.extension;
  const ext =
    typeof raw === "string" ? raw.replace(/^\./, "").toLowerCase() : "";
  return ext ? { ...rec, ext } : null;
}

function formatChoiceLabel(spec: ExportFormatSpec): string {
  const aac = spec.ext === "m4a" && (spec.codec ?? "aac") === "aac";
  const name = aac ? "M4A (AAC)" : spec.ext.toUpperCase();
  if (typeof spec.bitrate_kbps === "number") {
    return `${name} · ${spec.bitrate_kbps} kbps`;
  }
  return LOSSLESS.has(spec.ext) ? `${name} · lossless` : name;
}

export function exportSettingsFromConfig(
  config: Record<string, unknown>,
): ExportSettings {
  const exportCfg = asRecord(config.export);
  const configuredSpecs =
    "formats" in exportCfg
      ? (Array.isArray(exportCfg.formats) ? exportCfg.formats : [])
          .map(asSpec)
          .filter((spec): spec is ExportFormatSpec => spec != null)
      : [
          {
            ext: "mp3",
            codec: "libmp3lame",
            bitrate_kbps: Number(exportCfg.mp3_bitrate_kbps ?? 128),
          },
        ];
  const specs = [
    ...configuredSpecs,
    ...OFFERED.filter(
      (offered) => !configuredSpecs.some((spec) => spec.ext === offered.ext),
    ),
  ];
  const master = asRecord(config.master);
  const lufs = master.integrated_lufs;
  const truePeakDb = master.true_peak_db;
  return {
    wav: exportCfg.wav !== false,
    choices: specs.map((spec) => ({
      key: spec.ext,
      label: formatChoiceLabel(spec),
      spec,
    })),
    configured: configuredSpecs.map((spec) => spec.ext),
    target:
      typeof lufs === "number" && typeof truePeakDb === "number"
        ? { lufs, truePeakDb }
        : null,
  };
}

export function selectedFormats(
  settings: ExportSettings,
  selected: readonly string[],
): ExportFormatSpec[] {
  return settings.choices
    .filter((choice) => selected.includes(choice.key))
    .map((choice) => choice.spec);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function exportResultCopy(paths: readonly string[]): string {
  return `Exported ${plural(paths.length, "file", "files")} to export/`;
}

export function exportFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function db(value: number): string {
  const text = Math.abs(value).toFixed(1);
  return value < 0 ? `−${text}` : text;
}

export function masterTargetKey(
  target: ExportSettings["target"],
): string | undefined {
  return target ? `${target.lufs}/${target.truePeakDb}` : undefined;
}

export function loudnessTargetCopy(
  target: ExportSettings["target"],
): string | null {
  if (!target) {
    return null;
  }
  return `Mastered to ${db(target.lufs)} LUFS, peaks under ${db(target.truePeakDb)} dBTP.`;
}

export function masterMeasured(
  master: unknown,
): { lufs: number; truePeak?: number } | null {
  const measured = asRecord(asRecord(master).measured);
  const lufs = measured.integrated_lufs;
  const peak = measured.true_peak_db;
  if (typeof lufs !== "number") {
    return null;
  }
  return typeof peak === "number" ? { lufs, truePeak: peak } : { lufs };
}

export function masterMeasuredCopy(master: unknown): string | null {
  const measured = masterMeasured(master);
  if (!measured) {
    return null;
  }
  return measured.truePeak !== undefined
    ? `Measured ${db(measured.lufs)} LUFS, true peak ${db(measured.truePeak)} dBTP.`
    : `Measured ${db(measured.lufs)} LUFS.`;
}
