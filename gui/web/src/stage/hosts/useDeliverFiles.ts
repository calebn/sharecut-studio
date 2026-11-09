import { isTauri } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { revealExportedFile } from "../../api";
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
import { errorMessage } from "../../utils/apiError";
import { type ExportReceipt, exportTargetLabel } from "./exportReceipt";

const STARTED = "Download started. Check your downloads.";

const announce = (message: string, tone?: "error") =>
  useDawStore.getState().announceStatus(message, { toast: false, tone });

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
  return useMemo(
    () => ({
      files,
      load,
      currentLoad,
      reload,
      access,
      onStarted: () => announce(STARTED),
      onReveal: (file: ExportedFile) => {
        if (projectPath === null) return;
        revealExportedFile(projectPath, file.id).catch((error) =>
          announce(errorMessage(error), "error"),
        );
      },
    }),
    [files, load, currentLoad, reload, access, projectPath],
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
