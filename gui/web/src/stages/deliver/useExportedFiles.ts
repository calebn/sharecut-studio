import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ExportedFileEntry,
  exportedFileHref,
  listExportedFiles,
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

type Options = {
  /** `download` gives each row a link; `reveal` leaves it to the app. */
  access: FileAccess;
  /** Read again when this changes, such as the finish of an export. */
  refreshKey?: string;
};

/**
 * What the export folder holds for one project path or share key, read from the server's
 * listing and never from the last job. A failed or cancelled export leaves its files listed.
 * It reads again when `refreshKey` changes and when the window regains focus.
 */
export function useExportedFiles(
  projectPath: string | null,
  { access, refreshKey }: Options,
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
    listExportedFiles(path, controller.signal).then(
      (files) => {
        if (controller.signal.aborted) return;
        setListed({ path, files });
        setSettled({ read, load: "ready" });
      },
      (error) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setSettled({ read, load: "error" });
      },
    );
    return () => controller.abort();
  }, [read]);

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
