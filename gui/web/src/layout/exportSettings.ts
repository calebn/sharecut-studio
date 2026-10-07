/**
 * Export deliverables settings, read from the Pipeline working set
 * (`GET /api/pipeline/config` → `config.export` and `config.master`), the same
 * config `PipelineService.export_audio` encodes with.
 */

/** One FFmpeg output spec, as `export.formats` stores it. */
export type ExportFormatSpec = {
  ext: string;
  codec?: string;
  bitrate_kbps?: number;
  [key: string]: unknown;
};

export type ExportFormatChoice = {
  /** The file extension: each format writes `<episode>.<ext>`. */
  key: string;
  label: string;
  spec: ExportFormatSpec;
};

export type ExportSettings = {
  /** `export.wav`: the mastered WAV is copied out on every export. */
  wav: boolean;
  /** Encoded formats a host can pick, configured ones first. */
  choices: ExportFormatChoice[];
  /** Keys of the configured formats, checked by default. */
  configured: string[];
  /** `master.integrated_lufs` / `master.true_peak_db`, when set. */
  target: { lufs: number; truePeakDb: number } | null;
};

/** Offered beside the configured formats: lossless, and in every FFmpeg build. */
const FLAC: ExportFormatSpec = { ext: "flac", codec: "flac" };

const LOSSLESS = new Set(["flac", "wav", "alac"]);

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

export function formatChoiceLabel(spec: ExportFormatSpec): string {
  const name = spec.ext.toUpperCase();
  if (typeof spec.bitrate_kbps === "number") {
    return `${name} · ${spec.bitrate_kbps} kbps`;
  }
  return LOSSLESS.has(spec.ext) ? `${name} · lossless` : name;
}

export function exportSettingsFromConfig(
  config: Record<string, unknown>,
): ExportSettings {
  const exportCfg = asRecord(config.export);
  // Without `formats`, export_audio writes one MP3 at `mp3_bitrate_kbps`.
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
  const specs = configuredSpecs.some((spec) => spec.ext === FLAC.ext)
    ? configuredSpecs
    : [...configuredSpecs, FLAC];
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

/** The `formats` body for `POST /api/export/deliverables`. */
export function selectedFormats(
  settings: ExportSettings,
  selected: readonly string[],
): ExportFormatSpec[] {
  return settings.choices
    .filter((choice) => selected.includes(choice.key))
    .map((choice) => choice.spec);
}

/** Why Export is disabled, or null when it can start. */
export function exportStartBlocker(
  settings: ExportSettings | null,
  selected: readonly string[],
): string | null {
  if (settings && !settings.wav && selected.length === 0) {
    return "Choose at least one format.";
  }
  return null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Shared by the dialog, the status announcement and the Activity chip copy. */
export function exportResultCopy(paths: readonly string[]): string {
  return `Exported ${plural(paths.length, "file", "files")} to export/`;
}

export function exportFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Signed loudness for UI copy: a true minus sign, one decimal. */
function db(value: number): string {
  const text = Math.abs(value).toFixed(1);
  return value < 0 ? `−${text}` : text;
}

export function loudnessTargetCopy(
  target: ExportSettings["target"],
): string | null {
  if (!target) {
    return null;
  }
  return `Mastered to ${db(target.lufs)} LUFS, peaks under ${db(target.truePeakDb)} dBTP.`;
}

/** What the master measured, from the job's `result.master` (`master_qc.json`). */
export function masterMeasuredCopy(master: unknown): string | null {
  const measured = asRecord(asRecord(master).measured);
  const lufs = measured.integrated_lufs;
  const peak = measured.true_peak_db;
  if (typeof lufs !== "number") {
    return null;
  }
  return typeof peak === "number"
    ? `Measured ${db(lufs)} LUFS, true peak ${db(peak)} dBTP.`
    : `Measured ${db(lufs)} LUFS.`;
}
