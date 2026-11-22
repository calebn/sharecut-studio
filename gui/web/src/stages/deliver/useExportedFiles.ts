import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ExportedFileEntry,
  exportedFileHref,
  listExportedFiles,
  readGuestExportedFiles,
} from "../../api";
import { isAbortError } from "../../utils/apiError";
import type { ExportedFile, FileAccess } from "./exportedFileModel";

export type ExportedFilesLoad = "loading" | "ready" | "error";

export type ExportedFilesData = {
  files: readonly ExportedFile[];
  load: ExportedFilesLoad;
  currentLoad: ExportedFilesLoad;
  reload: () => void;
};

type InventoryRead = { path: string | null; again: string };

const VISIBLE_REFRESH_MS = 30_000;

export type ExportedFilesOptions = {
  /** `download` gives each row a link; `reveal` leaves it to the app. */
  access: FileAccess;
  /** Read again when this changes, such as the finish of an export. */
  refreshKey?: string;
  watchGuestPublication?: boolean;
};

/**
 * What the export folder holds for one project path or share key, read from the server's
 * listing and never from the last job. A failed or cancelled export leaves its files listed.
 * It reads again when `refreshKey` changes and when the window regains focus.
 * The open guest Files page can also check for completed exports without resetting its status.
 */
export function useExportedFiles(
  projectPath: string | null,
  { access, refreshKey, watchGuestPublication = false }: ExportedFilesOptions,
): ExportedFilesData {
  const [listed, setListed] = useState<{
    path: string;
    files: readonly ExportedFileEntry[];
  } | null>(null);
  const [settled, setSettled] = useState<{
    read: InventoryRead;
    load: "ready" | "error";
  } | null>(null);
  const [reads, setReads] = useState(0);
  const reload = useCallback(() => setReads((n) => n + 1), []);

  const read = useMemo(
    () => ({ path: projectPath, again: `${refreshKey ?? ""}|${reads}` }),
    [projectPath, refreshKey, reads],
  );
  useEffect(() => {
    const { path } = read;
    if (path === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: number | undefined;
    let revision: string | null = null;
    const schedule = () => {
      if (signal.aborted || !revision) return;
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") void loadFiles("quiet");
        else schedule();
      }, VISIBLE_REFRESH_MS);
    };
    const loadFiles = async (mode: "foreground" | "quiet") => {
      try {
        const result = watchGuestPublication
          ? await readGuestExportedFiles(path, revision ?? "", signal)
          : { files: await listExportedFiles(path, signal), revision: null };
        if (signal.aborted) return;
        if (result.files !== null) setListed({ path, files: result.files });
        revision = result.revision;
        if (mode === "foreground") setSettled({ read, load: "ready" });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        if (mode === "foreground") setSettled({ read, load: "error" });
      }
      schedule();
    };
    void loadFiles("foreground");
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [read, watchGuestPublication]);

  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  const files = useMemo(
    () =>
      listed && listed.path === projectPath
        ? listed.files.map(
            ({ ticket, ...file }): ExportedFile =>
              access === "download" && projectPath !== null
                ? {
                    ...file,
                    href: exportedFileHref(projectPath, {
                      id: file.id,
                      ticket,
                    }),
                  }
                : file,
          )
        : [],
    [listed, projectPath, access],
  );
  return {
    files,
    load: projectPath === null ? "loading" : (settled?.load ?? "loading"),
    currentLoad: settled?.read === read ? settled.load : "loading",
    reload,
  };
}
