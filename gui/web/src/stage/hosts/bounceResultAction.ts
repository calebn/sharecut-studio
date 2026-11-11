import {
  exportedFileHref,
  listExportedFiles,
  revealExportedFile,
} from "../../api";
import type { FileAccess } from "../../stages/deliver/exportedFileModel";
import { useDawStore } from "../../state/dawStore";
import type { ToastAction } from "../../state/types";
import { errorMessage } from "../../utils/apiError";

const fail = (error: unknown) =>
  useDawStore.getState().announceStatus(errorMessage(error), { tone: "error" });

function download(href: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function fileIdsOf(job: {
  result?: { [key: string]: unknown } | null;
}): string[] {
  const raw = job.result?.file_ids;
  return Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === "string")
    : [];
}

export function bounceResultAction(
  projectPath: string,
  fileIds: readonly string[],
  access: FileAccess,
): ToastAction | undefined {
  const first = fileIds[0];
  if (first === undefined) return undefined;
  if (access === "reveal")
    return {
      label: "Reveal",
      run: () => revealExportedFile(projectPath, first).catch(fail),
    };
  return {
    label: "Download",
    run: async () => {
      try {
        const listed = await listExportedFiles(projectPath);
        for (const id of fileIds) {
          const file = listed.find((entry) => entry.id === id);
          if (file) download(exportedFileHref(projectPath, file), file.name);
        }
      } catch (error) {
        fail(error);
      }
    },
  };
}
