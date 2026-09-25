/** OPFS path helpers shared by the keeper store and the sync-access writer worker. */
export function assertSafePart(part: string): string {
  if (
    !part ||
    part.includes("/") ||
    part.includes("\\") ||
    part === ".." ||
    part === "."
  ) {
    throw new Error("invalid keeper path part");
  }
  return part;
}

/** Walk (optionally creating) validated directory parts under `root`. */
export async function opfsDirHandle(
  root: FileSystemDirectoryHandle,
  parts: readonly string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(assertSafePart(part), { create });
  }
  return dir;
}

/** Split a keeper path into validated directory parts and a validated file name. */
export function splitOpfsPath(path: string): {
  dirParts: string[];
  fileName: string;
} {
  const dirParts = path.split("/").filter(Boolean);
  const fileName = dirParts.pop();
  if (!fileName) {
    throw new Error("invalid keeper path");
  }
  return { dirParts, fileName: assertSafePart(fileName) };
}

export async function opfsFileHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const { dirParts, fileName } = splitOpfsPath(path);
  const dir = await opfsDirHandle(root, dirParts, create);
  return dir.getFileHandle(fileName, { create });
}
