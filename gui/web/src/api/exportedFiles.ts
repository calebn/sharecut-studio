import { withSessionTokenQuery } from "../sessionAuth";
import { reviewApiBase, shareTokenFromKey } from "../shareMode";
import { apiFetch, HOST_KEY } from "./http";

export type ExportedFileKind = "audio" | "transcript" | "chapters" | "feed";

/** One file an export left in the export folder, as the server lists it. No host path. */
export type ExportedFileEntry = {
  /** Folder-relative name, such as `clips/a.wav`. The server resolves it against its own listing. */
  id: string;
  name: string;
  kind: ExportedFileKind;
  label: string;
  bytes: number;
  current: boolean;
};

/** A share key reaches the files through the review routes; a project path through the host's. */
function keyOf(projectPath: string): string {
  return shareTokenFromKey(projectPath) === null ? HOST_KEY : projectPath;
}

const encodeId = (id: string) =>
  id.split("/").map(encodeURIComponent).join("/");

export async function listExportedFiles(
  projectPath: string,
  signal?: AbortSignal,
): Promise<ExportedFileEntry[]> {
  const res = await apiFetch(
    keyOf(projectPath),
    {
      host: `/api/export/files?path=${encodeURIComponent(projectPath)}`,
      guest: "/daw/export/files",
    },
    { signal },
  );
  const body = (await res.json()) as { files?: ExportedFileEntry[] };
  if (!Array.isArray(body.files))
    throw new Error("The exported files list was not readable.");
  return body.files;
}

/**
 * A plain link to one file. The browser downloads it itself, so it shows progress and resumes.
 * A guest's token is already in the path; the host's session token rides in the query.
 */
export function exportedFileHref(projectPath: string, id: string): string {
  const token = shareTokenFromKey(projectPath);
  if (token !== null)
    return `${reviewApiBase(token)}/daw/export/files/${encodeId(id)}`;
  return withSessionTokenQuery(
    `/api/export/files/${encodeId(id)}?path=${encodeURIComponent(projectPath)}`,
  );
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
