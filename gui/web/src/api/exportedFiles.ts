import { reviewApiBase, shareTokenFromKey } from "../shareMode";
import { apiFetch, HOST_KEY } from "./http";

export type ExportedFileKind =
  | "audio"
  | "transcript"
  | "chapters"
  | "feed"
  | "bounce"
  | "daw";
export type ExportedTranscriptFormat =
  | "txt"
  | "md"
  | "readable.txt"
  | "srt"
  | "vtt";

/** One file an export left in the export folder, as the server lists it. No host path. */
export type ExportedFileEntry = {
  /** Folder-relative name, such as `clips/a.wav`. The server resolves it against its own listing. */
  id: string;
  name: string;
  kind: ExportedFileKind;
  label: string;
  bytes: number;
  current: boolean;
  /** Exact transcript format from the export inventory; absent or null for other file kinds. */
  format?: ExportedTranscriptFormat | null;
  /** Host listing only: a short-lived signed ticket that downloads this file as listed. */
  ticket?: string;
};

/** Everything the current files of an export pack into: counts and bytes, never a path. */
export type ExportArchiveEntry = {
  name: string;
  count: number;
  bytes: number;
  /** Host listing only: a short-lived signed ticket that downloads the archive as listed. */
  ticket?: string;
};

export type ExportedInventory = {
  files: ExportedFileEntry[];
  archive: ExportArchiveEntry | null;
};

/** A share key reaches the files through the review routes; a project path through the host's. */
function keyOf(projectPath: string): string {
  return shareTokenFromKey(projectPath) === null ? HOST_KEY : projectPath;
}

const encodeId = (id: string) =>
  id.split("/").map(encodeURIComponent).join("/");

const UNREADABLE = "The exported files list was not readable.";

function inventoryOf(body: {
  files?: ExportedFileEntry[];
  archive?: ExportArchiveEntry | null;
}): ExportedInventory | null {
  if (!Array.isArray(body.files)) return null;
  return { files: body.files, archive: body.archive ?? null };
}

export async function listExportedFiles(
  projectPath: string,
  signal?: AbortSignal,
): Promise<ExportedInventory> {
  const res = await apiFetch(
    keyOf(projectPath),
    {
      host: `/api/export/files?path=${encodeURIComponent(projectPath)}`,
      guest: "/daw/export/files",
    },
    { signal },
  );
  const inventory = inventoryOf(await res.json());
  if (inventory === null) throw new Error(UNREADABLE);
  return inventory;
}

type GuestInventory = Parameters<typeof inventoryOf>[0] & {
  revision?: string;
  exporting?: boolean;
};

export async function readGuestExportedFiles(
  projectKey: string,
  after: string,
  signal: AbortSignal,
): Promise<{
  inventory: ExportedInventory | null;
  revision: string | null;
  exporting: boolean | null;
}> {
  const res = await apiFetch(
    projectKey,
    { guest: `/daw/export/files?after=${encodeURIComponent(after)}` },
    { signal, cache: "no-store" },
  );
  const body = (await res.json()) as GuestInventory;
  const revision = typeof body.revision === "string" ? body.revision : null;
  const inventory = inventoryOf(body);
  if (inventory !== null)
    return { inventory, revision, exporting: body.exporting === true };
  if (after && revision === after)
    return { inventory: null, revision, exporting: null };
  throw new Error(UNREADABLE);
}

/**
 * A plain link to one file. The browser downloads it itself, so it shows progress and resumes.
 * A guest's token is already in the path; the host's link carries the listing's ticket and
 * never the session token.
 */
export function exportedFileHref(
  projectPath: string,
  file: Pick<ExportedFileEntry, "id" | "ticket">,
): string {
  const token = shareTokenFromKey(projectPath);
  if (token !== null)
    return `${reviewApiBase(token)}/daw/export/files/${encodeId(file.id)}`;
  const query = new URLSearchParams({ path: projectPath });
  if (file.ticket !== undefined) query.set("ticket", file.ticket);
  return `/api/export/files/${encodeId(file.id)}?${query}`;
}

/** A plain link to the archive of every current file; the ticket rides the host's link only. */
export function exportedArchiveHref(
  projectPath: string,
  archive: Pick<ExportArchiveEntry, "ticket">,
): string {
  const token = shareTokenFromKey(projectPath);
  if (token !== null) return `${reviewApiBase(token)}/daw/export/archive`;
  const query = new URLSearchParams({ path: projectPath });
  if (archive.ticket !== undefined) query.set("ticket", archive.ticket);
  return `/api/export/archive?${query}`;
}

export async function revealExportedFile(
  projectPath: string,
  id: string,
): Promise<void> {
  await apiFetch(
    HOST_KEY,
    { host: "/api/export/files/reveal" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, id }),
    },
  );
}
