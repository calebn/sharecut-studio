import type { ComponentProps } from "react";
import type { ExportedFileKind } from "../../api";
import type { ExportedFiles } from "./ExportedFiles";
import type {
  ExportArchive,
  ExportedFile,
  FileAccess,
} from "./exportedFileModel";

export type DeliverFiles = {
  /** Every file the export folder holds; a section keeps the kinds it owns. */
  files: readonly ExportedFile[];
  /** One download of every current file; null in the app, or when none is current. */
  archive: ExportArchive | null;
  access: FileAccess;
  onReveal?: (file: ExportedFile) => void;
  onStarted?: () => void;
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

export type AfterExport =
  | {
      kind: "reveal";
      file: ExportedFile;
      onReveal?: (file: ExportedFile) => void;
    }
  | { kind: "archive"; archive: ExportArchive; onStarted?: () => void };

/**
 * What a finished, current export offers first. The app reveals its main audio file. A
 * browser downloads every current file as one archive.
 */
export function afterExportOf(
  source: DeliverFiles | undefined,
  finished: boolean,
): AfterExport | undefined {
  if (!finished || !source) return undefined;
  if (source.access === "download")
    return source.archive
      ? {
          kind: "archive",
          archive: source.archive,
          onStarted: source.onStarted,
        }
      : undefined;
  const file = source.files.find(
    (candidate) => candidate.kind === "audio" && candidate.current,
  );
  return file ? { kind: "reveal", file, onReveal: source.onReveal } : undefined;
}
