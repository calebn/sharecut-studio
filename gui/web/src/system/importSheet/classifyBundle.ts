export type BundleKind = "segment" | "kit" | "unknown";

export const SEGMENT_EXTENSION = ".sharecutseg";
export const KIT_EXTENSION = ".sharecutkit";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
/** The end record is 22 bytes and may be followed by a comment of up to 65535. */
const TAIL_BYTES = 22 + 0xffff;
const MAX_ENTRIES = 2000;
const MAX_DIRECTORY_BYTES = 1024 * 1024;

async function bytesOf(blob: Blob): Promise<DataView | null> {
  try {
    const buffer =
      typeof blob.arrayBuffer === "function"
        ? await blob.arrayBuffer()
        : await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
          });
    return new DataView(buffer);
  } catch {
    return null;
  }
}

function endRecordAt(tail: DataView): number {
  for (let at = tail.byteLength - 22; at >= 0; at -= 1) {
    if (tail.getUint32(at, true) === END_OF_DIRECTORY) return at;
  }
  return -1;
}

function namesOf(directory: DataView, count: number): string[] {
  const names: string[] = [];
  const decoder = new TextDecoder();
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directory.byteLength) break;
    if (directory.getUint32(at, true) !== DIRECTORY_ENTRY) break;
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    if (at + 46 + nameLength > directory.byteLength) break;
    names.push(
      decoder.decode(
        new Uint8Array(
          directory.buffer,
          directory.byteOffset + at + 46,
          nameLength,
        ),
      ),
    );
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/**
 * The entry names of a zip, read from its central directory at the end of the file. Nothing
 * is inflated or uploaded; a file that is not a plain zip (zip64, too many entries, a cut
 * directory) gives none.
 */
async function zipNames(file: File): Promise<string[]> {
  if (file.size < 22) return [];
  const tail = await bytesOf(file.slice(-TAIL_BYTES));
  if (!tail) return [];
  const end = endRecordAt(tail);
  if (end < 0) return [];
  const count = tail.getUint16(end + 10, true);
  const size = tail.getUint32(end + 12, true);
  const offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
    return [];
  if (count > MAX_ENTRIES || size > MAX_DIRECTORY_BYTES) return [];
  const tailStart = file.size - tail.byteLength;
  if (offset + size > file.size) return [];
  const directory =
    offset >= tailStart
      ? new DataView(
          tail.buffer,
          tail.byteOffset + (offset - tailStart),
          Math.min(size, tail.byteLength - (offset - tailStart)),
        )
      : await bytesOf(file.slice(offset, offset + size));
  return directory ? namesOf(directory, count) : [];
}

/**
 * Which kind of Sharecut file this is, without uploading it. The extension decides first
 * (the picker and drop already filter on it); a file with another name, such as a renamed
 * download or `name (1).zip` from a phone's share sheet, is told apart by its top-level
 * entries: `kit.json` is a kit, `segment.json` a segment.
 */
export async function classifyBundle(file: File): Promise<BundleKind> {
  const name = file.name.toLowerCase();
  if (name.endsWith(KIT_EXTENSION)) return "kit";
  if (name.endsWith(SEGMENT_EXTENSION)) return "segment";
  const names = await zipNames(file);
  if (names.includes("kit.json")) return "kit";
  if (names.includes("segment.json")) return "segment";
  return "unknown";
}
