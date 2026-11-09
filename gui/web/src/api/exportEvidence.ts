import type {
  ExportMasterTarget,
  ExportQcLimits,
  ExportSettingsEvidence,
} from "../types/project.generated";

export type ExportEvidence = Readonly<
  Pick<ExportSettingsEvidence, "basis" | "target">
>;

const AUDIO_FORMATS = {
  mp3: true,
  m4a: true,
  aac: true,
  opus: true,
  ogg: true,
  flac: true,
  wav: true,
  other: true,
} satisfies Record<ExportSettingsEvidence["audio_formats"][number], true>;

const MASTER_FIELDS = {
  integrated_lufs: true,
  true_peak_db: true,
  lra: true,
} satisfies Record<keyof ExportMasterTarget, true>;

const QC_FIELDS = {
  lufs_tolerance_lu: true,
  true_peak_tolerance_db: true,
} satisfies Record<keyof ExportQcLimits, true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFiniteFields(value: unknown, fields: object): boolean {
  return (
    isRecord(value) &&
    Object.keys(fields).every((key) => Number.isFinite(value[key]))
  );
}

export function parseExportEvidence(
  value: unknown,
  target: ExportEvidence["target"],
): ExportEvidence | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.basis !== "string" ||
    !value.basis.trim() ||
    value.target !== target ||
    !hasFiniteFields(value.master_target, MASTER_FIELDS) ||
    !hasFiniteFields(value.qc_limits, QC_FIELDS) ||
    !Array.isArray(value.audio_formats) ||
    !value.audio_formats.every(
      (format: unknown) =>
        typeof format === "string" && Object.hasOwn(AUDIO_FORMATS, format),
    )
  )
    return null;
  return { basis: value.basis, target };
}

export function parseExportSettingsRead(
  value: unknown,
  target: ExportEvidence["target"],
): ExportEvidence | null {
  return isRecord(value) && value.status === "available"
    ? parseExportEvidence(value.settings, target)
    : null;
}
