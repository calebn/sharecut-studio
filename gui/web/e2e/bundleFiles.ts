import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

export const AUDIO = Buffer.from("fLaC-test-audio");

export function storedZip(entries: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const label = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(label.length, 26);
    parts.push(local, label, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(label.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, label);
    offset += 30 + label.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

/** A real `.sharecutseg`: segment.json, one clip and the manifest that hashes them. */
export function segmentFile(
  name: string,
  kind = "intro",
  seconds = 22,
): Buffer {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const json = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      id: `${slug}-${sha(name).slice(0, 8)}`,
      name,
      kind,
      version: 1,
      role: "intro",
      fader_db: 0,
      clips: [{ audio: "clip-01.flac", offset_sec: 0, duration_sec: seconds }],
      media: { "clip-01.flac": { sha256: sha(AUDIO), bytes: AUDIO.length } },
    }),
  );
  const manifest = Buffer.from(
    `${sha(json)}  segment.json\n${sha(AUDIO)}  clip-01.flac\n`,
  );
  return storedZip({
    "segment.json": json,
    "clip-01.flac": AUDIO,
    "MANIFEST.sha256": manifest,
  });
}

export function segmentJsonOf(file: Buffer): Record<string, unknown> | null {
  const at = file.indexOf("segment.json");
  if (file.subarray(0, 2).toString() !== "PK" || at < 0) return null;
  const size = file.readUInt32LE(at - 30 + 18);
  return JSON.parse(file.subarray(at + 12, at + 12 + size).toString());
}

export function silence(): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * 0.3);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}

export type KitSegment = { name: string; kind?: string; seconds?: number };

/** A real `.sharecutkit`: kit.json, each segment's json and clip as `segNN__` members, and the manifest. */
export function kitFile(name: string, segments: KitSegment[]): Buffer {
  const members: Record<string, Buffer> = {};
  const entries = segments.map((segment, index) => {
    const slug = segment.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const id = `${slug}-${sha(segment.name).slice(0, 8)}`;
    const prefix = `seg${String(index + 1).padStart(2, "0")}__`;
    members[`${prefix}segment.json`] = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        id,
        name: segment.name,
        kind: segment.kind ?? "intro",
        version: 1,
        role: "intro",
        fader_db: 0,
        clips: [
          {
            audio: "clip-01.flac",
            offset_sec: 0,
            duration_sec: segment.seconds ?? 12,
          },
        ],
        media: { "clip-01.flac": { sha256: sha(AUDIO), bytes: AUDIO.length } },
      }),
    );
    members[`${prefix}clip-01.flac`] = AUDIO;
    return {
      segment_id: id,
      version: 1,
      at: index === segments.length - 1 ? "end" : "start",
      note: null,
    };
  });
  const kit = Buffer.from(JSON.stringify({ schema_version: 1, name, entries }));
  const manifest = Buffer.from(
    [
      `${sha(kit)}  kit.json`,
      ...Object.entries(members).map(([file, data]) => `${sha(data)}  ${file}`),
    ].join("\n") + "\n",
  );
  return storedZip({
    "kit.json": kit,
    ...members,
    "MANIFEST.sha256": manifest,
  });
}

export function kitJsonOf(file: Buffer): Record<string, unknown> | null {
  const at = file.indexOf("kit.json");
  if (file.subarray(0, 2).toString() !== "PK" || at < 0) return null;
  const size = file.readUInt32LE(at - 30 + 18);
  return JSON.parse(file.subarray(at + 8, at + 8 + size).toString());
}
