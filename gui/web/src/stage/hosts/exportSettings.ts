import type { ExportFormats } from "../../api";

type ExportFormatSpec = Record<string, unknown>;

type ParsedFormat = Readonly<{
  key: string;
  spec: ExportFormatSpec;
}>;

type ExportFormatChoice = ParsedFormat & Readonly<{ label: string }>;

type MasterAudioSettings = Readonly<{
  lufs: number;
  truePeakDb: number;
}>;

export type ExportSettings = {
  wav: boolean;
  choices: ExportFormatChoice[];
  configured: string[];
  master: Partial<MasterAudioSettings>;
};

const OFFERED: readonly ParsedFormat[] = [
  {
    key: "m4a",
    spec: { ext: "m4a", codec: "aac", format: "ipod", bitrate_kbps: 128 },
  },
  { key: "flac", spec: { ext: "flac", codec: "flac" } },
];

const LOSSLESS = new Set(["flac", "wav", "alac"]);
const FORMAT_SETTINGS_ERROR = "Could not read the configured export formats";

export function isLossless(ext: string): boolean {
  return LOSSLESS.has(ext);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatIdentity(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/^\.+/, "").toLowerCase() : "";
}

function formatKey({ ext, extension }: Readonly<ExportFormatSpec>): string {
  const key = formatIdentity(ext || extension);
  if (!key) throw new Error(FORMAT_SETTINGS_ERROR);
  return key;
}

function parseExportFormat(value: unknown): ParsedFormat {
  const spec = { ...asRecord(value) };
  return { key: formatKey(spec), spec };
}

function formatChoiceLabel({ key, spec }: ParsedFormat): string {
  const aac = key === "m4a" && (spec.codec ?? "aac") === "aac";
  const name = aac ? "M4A (AAC)" : key.toUpperCase();
  if (typeof spec.bitrate_kbps === "number") {
    return `${name} · ${spec.bitrate_kbps} kbps`;
  }
  return LOSSLESS.has(key) ? `${name} · lossless` : name;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function wavEnabled(value: unknown): boolean {
  // The producer uses Python truthiness, including for empty JSON collections.
  return value !== null && typeof value === "object"
    ? Object.keys(value).length > 0
    : Boolean(value);
}

export function exportSettingsFromConfig(
  config: Record<string, unknown>,
): ExportSettings {
  const exportCfg = asRecord(config.export);
  const { wav = true } = exportCfg;
  const configuredFormats =
    "formats" in exportCfg
      ? (exportCfg.formats ?? [])
      : [
          {
            ext: "mp3",
            codec: "libmp3lame",
            bitrate_kbps: Number(exportCfg.mp3_bitrate_kbps ?? 128),
          },
        ];
  if (!Array.isArray(configuredFormats)) throw new Error(FORMAT_SETTINGS_ERROR);
  const configuredSpecs = configuredFormats.map(parseExportFormat);
  const formats = [
    ...configuredSpecs,
    ...OFFERED.filter(
      (offered) =>
        !configuredSpecs.some((format) => format.key === offered.key),
    ),
  ];
  const master = asRecord(config.master);
  const lufs = finiteNumber(master.integrated_lufs);
  const truePeakDb = finiteNumber(master.true_peak_db);
  return {
    wav: wavEnabled(wav),
    choices: formats.map((format) => ({
      ...format,
      label: formatChoiceLabel(format),
    })),
    configured: configuredSpecs.map(({ key }) => key),
    master: {
      ...(lufs !== undefined && { lufs }),
      ...(truePeakDb !== undefined && { truePeakDb }),
    },
  };
}

function selectedChoices(
  settings: ExportSettings,
  selected: readonly string[],
): ExportFormatChoice[] {
  return settings.choices.filter((choice) => selected.includes(choice.key));
}

export function selectedFormats(
  settings: ExportSettings,
  selected: readonly string[],
): ExportFormatSpec[] {
  return selectedChoices(settings, selected).map(({ spec }) => spec);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  return value;
}

function sameStructure(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b))
  );
}

export function hasUnavailableFormats(
  settings: ExportSettings,
  selected: readonly string[],
): boolean {
  return selected.some(
    (key) => !settings.choices.some((choice) => choice.key === key),
  );
}

export function resolveExport(
  settings: ExportSettings | null,
  keys: readonly string[],
): ExportFormats {
  return settings === null
    ? null
    : structuredClone(selectedFormats(settings, keys));
}

export function sameExportFormats(a: ExportFormats, b: ExportFormats): boolean {
  if (a === null || b === null) return a === b;
  const grouped = (formats: NonNullable<ExportFormats>) =>
    formats
      .map((spec) => {
        const { ext, extension, ...options } = spec;
        const key = formatKey(spec);
        const conflict = [ext, extension].some((alias) =>
          alias === undefined || alias === ""
            ? false
            : typeof alias !== "string" || formatIdentity(alias) !== key,
        );
        return { key, options: conflict ? spec : options };
      })
      .sort(({ key: left }, { key: right }) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
  return sameStructure(grouped(a), grouped(b));
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

export function loudnessTargetCopy({
  lufs,
  truePeakDb,
}: Partial<MasterAudioSettings>): string | null {
  if (lufs === undefined || truePeakDb === undefined) return null;
  return `Project target preview is ${db(lufs)} LUFS, peaks under ${db(truePeakDb)} dBTP.`;
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
