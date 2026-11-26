import { useRef } from "react";
import {
  cancelKitImport,
  commitKitImport,
  KIT_IMPORT_RETRY_CODES,
  type KitImportPreview,
  type KitImportResult,
  NETWORK_ERROR_CODE,
  partialImport,
  previewKitImport,
} from "../api";
import { IMPORT_FAILED } from "../system/importSheet/importCopy";
import {
  type CommitFailure,
  type StagedImport,
  type StagedImportState,
  useStagedImport,
} from "../system/importSheet/useStagedImport";
import { ApiError, errorMessage } from "../utils/apiError";
import {
  alreadyThere,
  importedMessage,
  isUnchangedKit,
  KIT_EXPIRED,
  markLanded,
  partialMessage,
} from "./importMessages";

export type KitImportState = StagedImportState<KitImportPreview>;

export type KitImport = StagedImport<KitImportPreview>;

type Options = {
  /** Segments or the kit may have changed: read both lists again. Called after any add, even a partial one. */
  onChanged: () => void;
  /** Said once the file is in the library, with the first segment it added, if any. */
  onDone: (message: string, firstSegmentId: string | null) => void;
};

/** The kit import: one staged file, committed by token, retried by the same token. */
export function useKitImport({ onChanged, onDone }: Options): KitImport {
  // Segments that landed in earlier tries of the file waiting now; the server counts only a try's own.
  const landed = useRef({ added: 0, total: 0 });
  return useStagedImport<KitImportPreview, KitImportResult>({
    stage: previewKitImport,
    commit: (preview) => commitKitImport(preview.token),
    cancel: cancelKitImport,
    settleWithoutCommit: (preview) =>
      isUnchangedKit(preview)
        ? () => onDone(`${preview.name} is already in your library`, null)
        : null,
    onChosen: () => {
      landed.current = { added: 0, total: 0 };
    },
    onCommitted: (preview, result) => {
      const earlier = landed.current.added;
      landed.current = { added: 0, total: 0 };
      const fresh = result.segments.find(
        (segment) =>
          segment.status === "added" || segment.status === "new_version",
      );
      onDone(
        importedMessage(preview.name, result, {
          earlier,
          total: preview.entry_count,
        }),
        fresh?.id ?? null,
      );
    },
    onCommitFailed: (failure, waiting): CommitFailure<KitImportPreview> => {
      const partial = partialImport(failure);
      if (partial && partial.added > 0) {
        landed.current = {
          added: landed.current.added + partial.added,
          total: partial.total,
        };
        onChanged();
      }
      const preview = markLanded(waiting, partial?.added ?? 0);
      const detail = errorMessage(failure, IMPORT_FAILED);
      const { added: sofar, total } = landed.current;
      const said =
        sofar > 0 && total > 0 ? ` ${partialMessage(sofar, total)}` : "";
      if (
        failure instanceof ApiError &&
        KIT_IMPORT_RETRY_CODES.has(failure.code)
      )
        return { phase: "preview", notice: `${detail}${said}`, preview };
      const dropped =
        !(failure instanceof ApiError) ||
        failure.code === null ||
        failure.code === NETWORK_ERROR_CODE;
      if (dropped)
        return { phase: "preview", notice: `${detail}${said}`, preview };
      if (failure.code === "kit_import_unknown")
        return {
          phase: "error",
          message:
            sofar > 0
              ? `${KIT_EXPIRED} ${alreadyThere(sofar, total)}`
              : KIT_EXPIRED,
        };
      const added =
        sofar > 0
          ? ` ${sofar} ${sofar === 1 ? "segment was" : "segments were"} added to your library first.`
          : "";
      return { phase: "error", message: `${detail}${added}` };
    },
  });
}
