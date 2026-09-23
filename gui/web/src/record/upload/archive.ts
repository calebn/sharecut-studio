export type KeeperArchiveEntry = { filename: string; data: Blob };

const encoder = new TextEncoder();
const UINT32_MAX = 0xffff_ffff;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? (value >>> 1) ^ 0xedb8_8320 : value >>> 1;
  }
  return value >>> 0;
});

function view(size: number): [Uint8Array<ArrayBuffer>, DataView<ArrayBuffer>] {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  return [bytes, new DataView(bytes.buffer)];
}

function crc32Update(value: number, bytes: Uint8Array): number {
  let crc = value;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return crc;
}

async function crc32(data: Blob): Promise<number> {
  const reader = data.stream().getReader();
  let crc = UINT32_MAX;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      crc = crc32Update(crc, value);
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ UINT32_MAX) >>> 0;
}

/** Build an uncompressed ZIP64 from Blob references without copying WAV bytes. */
export async function makeKeeperArchive(
  entries: KeeperArchiveEntry[],
): Promise<Blob> {
  if (entries.length === 0) throw new Error("No keeper files to archive.");
  const files: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let fileOffset = 0n;
  let directorySize = 0n;
  for (const { filename, data } of entries) {
    const name = encoder.encode(filename);
    if (name.byteLength > 0xffff)
      throw new Error("Keeper filename is too long.");
    const size = BigInt(data.size);
    const checksum = await crc32(data);
    const [local, localView] = view(30 + name.byteLength + 20);
    localView.setUint32(0, 0x0403_4b50, true);
    localView.setUint16(4, 45, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, UINT32_MAX, true);
    localView.setUint32(22, UINT32_MAX, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 20, true);
    local.set(name, 30);
    const localExtra = 30 + name.byteLength;
    localView.setUint16(localExtra, 1, true);
    localView.setUint16(localExtra + 2, 16, true);
    localView.setBigUint64(localExtra + 4, size, true);
    localView.setBigUint64(localExtra + 12, size, true);
    files.push(local, data);

    const [central, centralView] = view(46 + name.byteLength + 28);
    centralView.setUint32(0, 0x0201_4b50, true);
    centralView.setUint16(4, 45, true);
    centralView.setUint16(6, 45, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, UINT32_MAX, true);
    centralView.setUint32(24, UINT32_MAX, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint16(30, 28, true);
    centralView.setUint32(42, UINT32_MAX, true);
    central.set(name, 46);
    const centralExtra = 46 + name.byteLength;
    centralView.setUint16(centralExtra, 1, true);
    centralView.setUint16(centralExtra + 2, 24, true);
    centralView.setBigUint64(centralExtra + 4, size, true);
    centralView.setBigUint64(centralExtra + 12, size, true);
    centralView.setBigUint64(centralExtra + 20, fileOffset, true);
    directory.push(central);
    directorySize += BigInt(central.byteLength);
    fileOffset += BigInt(local.byteLength) + size;
  }

  const [zip64End, zip64EndView] = view(56);
  zip64EndView.setUint32(0, 0x0606_4b50, true);
  zip64EndView.setBigUint64(4, 44n, true);
  zip64EndView.setUint16(12, 45, true);
  zip64EndView.setUint16(14, 45, true);
  zip64EndView.setBigUint64(24, BigInt(entries.length), true);
  zip64EndView.setBigUint64(32, BigInt(entries.length), true);
  zip64EndView.setBigUint64(40, directorySize, true);
  zip64EndView.setBigUint64(48, fileOffset, true);
  const [locator, locatorView] = view(20);
  locatorView.setUint32(0, 0x0706_4b50, true);
  locatorView.setBigUint64(8, fileOffset + directorySize, true);
  locatorView.setUint32(16, 1, true);
  const [end, endView] = view(22);
  endView.setUint32(0, 0x0605_4b50, true);
  endView.setUint16(8, 0xffff, true);
  endView.setUint16(10, 0xffff, true);
  endView.setUint32(12, UINT32_MAX, true);
  endView.setUint32(16, UINT32_MAX, true);
  return new Blob([...files, ...directory, zip64End, locator, end], {
    type: "application/zip",
  });
}
