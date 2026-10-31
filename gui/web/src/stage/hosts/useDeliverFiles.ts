import { isTauri } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { revealExportedFile } from "../../api";
import type { DeliverFiles } from "../../stages/deliver/deliverFiles";
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
): DeliverFiles & { load: ExportedFilesLoad } {
  const { files, load } = useExportedFiles(projectPath, { access, refreshKey });
  return useMemo(
    () => ({
      files,
      load,
      access,
      onStarted: () => announce(STARTED),
      onReveal: (file: ExportedFile) => {
        if (projectPath === null) return;
        revealExportedFile(projectPath, file.id).catch((error) =>
          announce(errorMessage(error), "error"),
        );
      },
    }),
    [files, load, access, projectPath],
  );
}
