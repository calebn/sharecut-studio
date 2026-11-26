import type { ExportedFileKind, ExportedTranscriptFormat } from "../../api";
import { formatBytes } from "../../models";

export type ExportedFile = {
  /** Folder-relative name, opaque to the client. */
  id: string;
  name: string;
  kind: ExportedFileKind;
  /** What the file is for, in words: "Listening file", "Captions". */
  label: string;
  bytes: number;
  /** Producer freshness judgment; false does not identify what changed. */
  current: boolean;
  /** Exact transcript format when supplied by the server. */
  format?: ExportedTranscriptFormat | null;
  /** Download address; absent in the desktop app, which reveals instead. */
  href?: string;
};

export type ExportArchive = {
  name: string;
  count: number;
  bytes: number;
  href: string;
};

export function archiveLabel({ count, bytes }: ExportArchive): string {
  return `Download all ${count} ${count === 1 ? "file" : "files"}, ${formatBytes(bytes)}`;
}

export const RUNNING_REASON = "Exporting now. Download when it finishes.";

export type FileAccess = "download" | "reveal";

const KIND_TITLES: Record<ExportedFileKind, string> = {
  audio: "Audio",
  transcript: "Transcript",
  chapters: "Chapters",
  feed: "Feed",
  bounce: "Exports of a selection",
  daw: "DAW sessions",
};

/** Files from the same kind sit together; inside a kind the order the server sent is kept. */
export function groupByKind(files: readonly ExportedFile[]) {
  const order: ExportedFileKind[] = [
    "audio",
    "transcript",
    "chapters",
    "feed",
    "bounce",
    "daw",
  ];
  return order
    .map((kind) => ({
      kind,
      title: KIND_TITLES[kind],
      files: files.filter((file) => file.kind === kind),
    }))
    .filter((group) => group.files.length > 0);
}

const LARGE_FILE_BYTES = 200 * 1024 * 1024;

export function hasLargeFile(files: readonly ExportedFile[]): boolean {
  return files.some((file) => file.bytes >= LARGE_FILE_BYTES);
}
