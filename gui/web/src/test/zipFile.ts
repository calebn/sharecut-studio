/**
 * A `File` holding a zip whose central directory names `names` (stored, empty members).
 * Enough to be told apart by its entry names; it does not unpack.
 */
export function zipFile(
  fileName: string,
  names: readonly string[],
  type = "application/zip",
): File {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const name of names) {
    const label = encoder.encode(name);
    const local = new Uint8Array(30 + label.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, label.length, true);
    local.set(label, 30);
    const entry = new Uint8Array(46 + label.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(28, label.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(label, 46);
    locals.push(local);
    directory.push(entry);
    offset += local.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, names.length, true);
  endView.setUint16(10, names.length, true);
  endView.setUint32(12, size, true);
  endView.setUint32(16, offset, true);
  return new File([...locals, ...directory, end] as BlobPart[], fileName, {
    type,
  });
}
