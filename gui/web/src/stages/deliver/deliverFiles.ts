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
