import type { ComponentProps } from "react";
import type { ExportedFileKind } from "../../api";
import type { ExportedFiles } from "./ExportedFiles";
import type { ExportedFile, FileAccess } from "./exportedFileModel";

export type DeliverFiles = {
  /** Every file the export folder holds; a section keeps the kinds it owns. */
  files: readonly ExportedFile[];
  access: FileAccess;
  onReveal?: (file: ExportedFile) => void;
  onStarted?: (file: ExportedFile) => void;
};

export type NamedExportFiles =
  | { state: "unpublished" }
  | ({ label: string } & (
      | { state: "ready"; rows: DeliverFiles }
      | { state: "loading" }
      | { state: "error" | "missing"; reload: () => void }
    ));

export type FileListProps = ComponentProps<typeof ExportedFiles>;

export function filesOfKinds(
  source: DeliverFiles,
  kinds: readonly ExportedFileKind[],
  running: boolean,
): FileListProps {
  return {
    files: source.files.filter((file) => kinds.includes(file.kind)),
    access: source.access,
    running,
    onReveal: source.onReveal,
    onStarted: source.onStarted,
  };
}

export type AfterExport = {
  access: FileAccess;
  file: ExportedFile;
  onReveal?: (file: ExportedFile) => void;
  onStarted?: (file: ExportedFile) => void;
};

/** What a finished, current export offers first: its main audio file, revealed or downloaded. */
export function afterExportOf(
  source: DeliverFiles | undefined,
  finished: boolean,
): AfterExport | undefined {
  if (!finished || !source) return undefined;
  const file = source.files.find(
    (candidate) =>
      candidate.kind === "audio" &&
      candidate.current &&
      (source.access === "reveal" || candidate.href),
  );
  if (!file) return undefined;
  return {
    access: source.access,
    file,
    onReveal: source.onReveal,
    onStarted: source.onStarted,
  };
}
