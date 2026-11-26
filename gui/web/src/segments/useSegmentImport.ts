import {
  cancelSegmentImport,
  commitSegmentImport,
  previewSegmentImport,
  type SegmentImportPreview,
  type SegmentSaveResult,
} from "../api";
import {
  type StagedImport,
  type StagedImportState,
  useStagedImport,
} from "../system/importSheet/useStagedImport";
import { importedMessage } from "./importMessages";

export type SegmentImportState = StagedImportState<SegmentImportPreview>;

export type SegmentImport = StagedImport<SegmentImportPreview>;

type Options = {
  /** The row to show once the file is in the library (or already was), and what to say. */
  onDone: (id: string, message: string) => void;
};

export function useSegmentImport({ onDone }: Options): SegmentImport {
  return useStagedImport({
    stage: previewSegmentImport,
    commit: (preview: SegmentImportPreview) =>
      commitSegmentImport(preview.token),
    cancel: cancelSegmentImport,
    onCommitted: (preview: SegmentImportPreview, result: SegmentSaveResult) =>
      onDone(result.id, importedMessage(preview.name, result)),
    settleWithoutCommit: (preview: SegmentImportPreview) =>
      preview.outcome === "unchanged" && preview.existing_id !== null
        ? () =>
            onDone(
              preview.existing_id as string,
              importedMessage(preview.name, {
                status: "unchanged",
                id: preview.existing_id as string,
                version: preview.version,
              }),
            )
        : null,
  });
}
