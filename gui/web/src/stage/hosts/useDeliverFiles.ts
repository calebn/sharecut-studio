import { isTauri } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { revealExportedFile } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import type {
  DeliverFiles,
  NamedExportFiles,
} from "../../stages/deliver/deliverFiles";
import type {
  ExportedFile,
  FileAccess,
} from "../../stages/deliver/exportedFileModel";
import {
  type ExportedFilesLoad,
  useExportedFiles,
} from "../../stages/deliver/useExportedFiles";
import { useDawStore } from "../../state/dawStore";
import { ApiError } from "../../utils/apiError";
import { type ExportReceipt, exportTargetLabel } from "./exportReceipt";

const STARTED = "Download started. Check your downloads.";
const REVEAL_ERRORS = new Map([
  [
    "export_file_gone",
    "That export file is gone. Export it again to show it in its folder.",
  ],
  [
    "reveal_unavailable",
    "This computer couldn't open its file manager. Open the episode's folder directly.",
  ],
]);
const REVEAL_FAILED = "Studio couldn't show that export file. Try again.";

export function hostFileAccess(): FileAccess {
  return isTauri() ? "reveal" : "download";
}

/**
 * The export folder's files for one project path or share key, with what a row does on press.
 * A guest only downloads; the host reveals in the app and downloads in a browser.
 */
export function useDeliverFiles(
  projectPath: string | null,
  access: FileAccess,
  refreshKey?: string,
): DeliverFiles & {
  load: ExportedFilesLoad;
  currentLoad: ExportedFilesLoad;
  reload: () => void;
} {
  const { files, load, currentLoad, reload } = useExportedFiles(projectPath, {
    access,
    refreshKey,
  });
  const mounted = useMountedRef();
  return useMemo(
    () => ({
      files,
      load,
      currentLoad,
      reload,
      access,
      onStarted: () =>
        useDawStore.getState().announceStatus(STARTED, { toast: false }),
      onReveal: (file: ExportedFile) => {
        if (projectPath === null) return;
        const { projectEpoch } = useDawStore.getState();
        revealExportedFile(projectPath, file.id).catch((error: unknown) => {
          const state = useDawStore.getState();
          if (
            !mounted.current ||
            state.stage !== "deliver" ||
            state.projectPath !== projectPath ||
            state.projectEpoch !== projectEpoch
          )
            return;
          const message =
            error instanceof ApiError && error.code !== null
              ? REVEAL_ERRORS.get(error.code)
              : undefined;
          state.announceStatus(message ?? REVEAL_FAILED, { tone: "error" });
        });
      },
    }),
    [files, load, currentLoad, reload, access, projectPath, mounted],
  );
}

export function namedExportFiles(
  receipt: Extract<ExportReceipt, { kind: "named" }>,
  inventory: ReturnType<typeof useDeliverFiles>,
): NamedExportFiles {
  const label = `${exportTargetLabel(receipt.target)} files`;
  if (inventory.currentLoad === "loading") return { label, state: "loading" };
  if (inventory.currentLoad === "error")
    return { label, state: "error", reload: inventory.reload };
  const byId = new Map(inventory.files.map((file) => [file.id, file]));
  const files: ExportedFile[] = [];
  for (const id of receipt.fileIds) {
    const file = byId.get(id);
    if (!file) return { label, state: "missing", reload: inventory.reload };
    files.push(file);
  }
  return { label, state: "ready", rows: { ...inventory, files } };
}
