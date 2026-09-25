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

export async function opfsFileHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) {
    throw new Error("invalid keeper path");
  }
  let dir = root;
  for (const part of parts) {
    assertSafePart(part);
    dir = await dir.getDirectoryHandle(part, { create });
  }
  assertSafePart(
    fileName.replace(/\.wav$/i, "").replace(/\.json$/i, "") || fileName,
  );
  return dir.getFileHandle(fileName, { create });
}
