import { type ExportEvidence, parseExportEvidence } from "../../api";
import { LOUDNESS, plural } from "../../stages/deliver/deliverLogic";
import type { LoudnessId, PipelineJobSnapshot } from "../../types/pipeline";
import { exportResultCopy } from "./exportSettings";

export type ExportReceipt = {
  readonly appliedSettings: ExportEvidence | null;
} & (
  | {
      kind: "canonical";
      paths: readonly string[];
      editHeadId?: string;
      master?: unknown;
    }
  | {
      kind: "named";
      target: LoudnessId;
      fileIds: readonly [string, ...string[]];
      editHeadId: string | null;
      master: {
        measured: Record<string, number | null>;
        within_tolerance: true;
      };
    }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMeasurement(value: unknown): value is Record<string, number | null> {
  return (
    isRecord(value) &&
    typeof value.integrated_lufs === "number" &&
    Number.isFinite(value.integrated_lufs) &&
    typeof value.true_peak_db === "number" &&
    Number.isFinite(value.true_peak_db) &&
    Object.values(value).every(
      (number) =>
        number === null ||
        (typeof number === "number" && Number.isFinite(number)),
    )
  );
}

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function readExportReceipt(
  job: PipelineJobSnapshot,
  target: LoudnessId | null,
): ExportReceipt | null {
  const result: unknown = job.result;
  const cancelled = job.status === "cancelled";
  if (cancelled && result == null) return null;
  const invalid =
    "The export result could not be verified. Try exporting again.";
  if (!isRecord(result)) throw new Error(invalid);
  const { edit_head_id: editHeadId, master } = result;
  const appliedSettings =
    job.status === "ok"
      ? parseExportEvidence(result.applied_settings, target)
      : null;
  if (target === null) {
    const { paths } = result;
    if (!Array.isArray(paths) || !paths.every(isNonblankString))
      throw new Error(invalid);
    if (cancelled && paths.length === 0) return null;
    return {
      kind: "canonical",
      appliedSettings,
      paths,
      editHeadId: typeof editHeadId === "string" ? editHeadId : undefined,
      master,
    };
  }
  const { file_ids: fileIds } = result;
  if (
    result.target !== target ||
    !Array.isArray(fileIds) ||
    !fileIds.every(isNonblankString) ||
    new Set(fileIds).size !== fileIds.length ||
    !(editHeadId === null || isNonblankString(editHeadId)) ||
    !isRecord(master) ||
    master.within_tolerance !== true ||
    !isMeasurement(master.measured)
  )
    throw new Error(invalid);
  const [first, ...rest] = fileIds;
  if (first === undefined) throw new Error(invalid);
  return {
    kind: "named",
    appliedSettings,
    target,
    fileIds: [first, ...rest],
    editHeadId,
    master: { measured: master.measured, within_tolerance: true },
  };
}

export function exportTargetLabel(target: LoudnessId): string {
  return LOUDNESS.find((choice) => choice.id === target)?.label ?? target;
}

export function receiptCopy(receipt: ExportReceipt): string {
  return receipt.kind === "canonical"
    ? exportResultCopy(receipt.paths)
    : `Exported ${plural(receipt.fileIds.length, `${exportTargetLabel(receipt.target)} audio file`)}.`;
}
