import type { SegmentImportPreview, SegmentSaveResult } from "../api";
import {
  ADD_LABEL,
  ADDING_LABEL,
  CANCEL_LABEL,
  CHOOSE_AGAIN_LABEL,
  CLOSE_LABEL,
  checkingMessage,
  IMPORT_FAILED,
} from "../system/importSheet/importCopy";
import type { ExportOutcome } from "../utils/shareOrSave";

export {
  ADD_LABEL,
  ADDING_LABEL,
  CANCEL_LABEL,
  CHOOSE_AGAIN_LABEL,
  CLOSE_LABEL,
  checkingMessage,
  IMPORT_FAILED,
};

export const IMPORT_TITLE = "Import a segment";
export const SHOW_LABEL = "Show in library";
export const PLAY_FAILED = "Couldn't play this file";

export function outcomeLine(preview: SegmentImportPreview): string {
  if (preview.outcome === "unchanged") return "Already in your library";
  if (preview.outcome === "new_version")
    return `Adds as ${preview.name} v${preview.version}`;
  return `Adds ${preview.name}`;
}

export function importedMessage(
  name: string,
  result: SegmentSaveResult,
): string {
  if (result.status === "unchanged")
    return `${name} is already in your library`;
  if (result.status === "new_version")
    return `Added ${name} as version ${result.version}`;
  return `Added ${name} to your library`;
}

export function lengthLine(preview: SegmentImportPreview): string {
  return preview.clip_count > 1 ? `${preview.clip_count} clips` : "";
}

export function exportedMessage(name: string, outcome: ExportOutcome): string {
  if (outcome.kind === "shared") return `Shared ${name}`;
  if (outcome.kind === "cancelled") return `Export of ${name} cancelled`;
  return outcome.afterShare
    ? `Saved ${outcome.filename}. This browser would not open the share sheet, so the file was saved instead.`
    : `Saved ${outcome.filename}`;
}
