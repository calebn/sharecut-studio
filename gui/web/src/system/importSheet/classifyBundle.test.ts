import { describe, expect, it, vi } from "vitest";
import { zipFile } from "../../test/zipFile";
import { classifyBundle } from "./classifyBundle";

function bytesOf(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

const plain = (name: string, type = "") =>
  new File(["not a zip"], name, { type });

describe("classifyBundle", () => {
  it("takes the extension first, whatever its case", async () => {
    expect(await classifyBundle(plain("show.sharecutkit"))).toBe("kit");
    expect(await classifyBundle(plain("Show.SHARECUTKIT"))).toBe("kit");
    expect(await classifyBundle(plain("intro.sharecutseg"))).toBe("segment");
  });

  it("trusts the extension over what is inside", async () => {
    const holdsKit = zipFile("intro.sharecutseg", ["kit.json"]);
    const holdsSegment = zipFile("show.sharecutkit", ["segment.json"]);
    expect(await classifyBundle(holdsKit)).toBe("segment");
    expect(await classifyBundle(holdsSegment)).toBe("kit");
  });

  it("tells a zip with another name apart by its top-level entries", async () => {
    expect(
      await classifyBundle(
        zipFile("show (1).zip", [
          "kit.json",
          "MANIFEST.sha256",
          "seg01__segment.json",
          "seg01__clip-01.flac",
        ]),
      ),
    ).toBe("kit");
    expect(
      await classifyBundle(
        zipFile("download", ["segment.json", "clip-01.flac"], ""),
      ),
    ).toBe("segment");
  });

  it("does not take a nested or prefixed name for a bundle's own file", async () => {
    expect(
      await classifyBundle(zipFile("x.zip", ["seg01__segment.json"])),
    ).toBe("unknown");
    expect(await classifyBundle(zipFile("x.zip", ["folder/kit.json"]))).toBe(
      "unknown",
    );
  });

  it("calls a zip of other content, garbage and a truncated file unknown", async () => {
    expect(await classifyBundle(zipFile("notes.zip", ["notes.txt"]))).toBe(
      "unknown",
    );
    expect(await classifyBundle(plain("notes.zip", "application/zip"))).toBe(
      "unknown",
    );
    expect(await classifyBundle(plain("take.wav", "audio/wav"))).toBe(
      "unknown",
    );
    const whole = zipFile("cut.zip", ["kit.json"]);
    const cut = new File([whole.slice(0, whole.size - 10)], "cut.zip");
    expect(await classifyBundle(cut)).toBe("unknown");
    expect(await classifyBundle(new File([], "empty.zip"))).toBe("unknown");
  });

  it("gives up on zip64 and on a directory with too many entries", async () => {
    const whole = await bytesOf(zipFile("a.zip", ["kit.json"]));
    const view = new DataView(whole.buffer);
    const end = whole.length - 22;

    const zip64 = whole.slice();
    new DataView(zip64.buffer).setUint32(end + 16, 0xffffffff, true);
    expect(await classifyBundle(new File([zip64], "z64.zip"))).toBe("unknown");

    const many = whole.slice();
    new DataView(many.buffer).setUint16(end + 10, 2001, true);
    expect(await classifyBundle(new File([many], "many.zip"))).toBe("unknown");
    expect(view.getUint32(end, true)).toBe(0x06054b50);
  });

  it("reads a directory that sits before the tail it first looked at", async () => {
    const names = Array.from(
      { length: 1500 },
      (_, i) => `${"x".repeat(50)}${i}.bin`,
    );
    const file = zipFile("big.zip", [...names, "kit.json"]);
    expect(await classifyBundle(file)).toBe("kit");
  });
});

const encoder = new TextEncoder();

function entryBytes(
  name: string,
  { extra = 0, comment = 0, signature = 0x02014b50 } = {},
): Uint8Array {
  const label = encoder.encode(name);
  const bytes = new Uint8Array(46 + label.length + extra + comment);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  view.setUint16(28, label.length, true);
  view.setUint16(30, extra, true);
  view.setUint16(32, comment, true);
  bytes.set(label, 46);
  return bytes;
}

function endBytes(
  count: number,
  size: number,
  offset: number,
  comment = 0,
): Uint8Array {
  const bytes = new Uint8Array(22 + comment);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, comment, true);
  return bytes;
}

const join = (...parts: Uint8Array[]) =>
  new File(parts as BlobPart[], "x.zip", { type: "application/zip" });

function archive(
  entries: Uint8Array[],
  over: {
    count?: number;
    size?: number;
    offset?: number;
    comment?: number;
  } = {},
): File {
  const size = entries.reduce((sum, part) => sum + part.length, 0);
  return join(
    ...entries,
    endBytes(
      over.count ?? entries.length,
      over.size ?? size,
      over.offset ?? 0,
      over.comment ?? 0,
    ),
  );
}

describe("classifyBundle on odd zips", () => {
  it("reads a well-formed zip built by hand", async () => {
    expect(await classifyBundle(archive([entryBytes("kit.json")]))).toBe("kit");
  });

  it("calls a file shorter than an end record unknown", async () => {
    expect(await classifyBundle(join(new Uint8Array(21)))).toBe("unknown");
    expect(await classifyBundle(join(endBytes(0, 0, 0)))).toBe("unknown");
  });

  it("does not read a count, size and offset out of a file with no end record", async () => {
    // Without the end record's signature, the fields a careless reader takes from the
    // last bytes would here point at a directory holding kit.json.
    const entry = entryBytes("kit.json");
    const view = new DataView(entry.buffer);
    entry[9] = 1;
    entry[10] = 0;
    view.setUint32(11, entry.length, true);
    view.setUint32(15, 0, true);
    expect(entry.length).toBeGreaterThanOrEqual(22);
    expect(await classifyBundle(join(entry))).toBe("unknown");
  });

  it("takes the last end record in the file", async () => {
    expect(
      await classifyBundle(
        join(entryBytes("kit.json"), endBytes(1, 54, 0), endBytes(0, 0, 0)),
      ),
    ).toBe("unknown");
    expect(
      await classifyBundle(
        join(
          entryBytes("notes.txt"),
          endBytes(1, 55, 0),
          entryBytes("kit.json"),
          endBytes(1, 54, 77),
        ),
      ),
    ).toBe("kit");
  });

  it("finds the end record before a trailing comment", async () => {
    const file = join(
      entryBytes("segment.json"),
      endBytes(1, 58, 0, 30),
      new Uint8Array(30),
    );
    expect(await classifyBundle(file)).toBe("segment");
  });

  it("gives up when the directory reaches past the end of the file", async () => {
    const entries = [entryBytes("kit.json")];
    expect(await classifyBundle(archive(entries, { size: 1_000_000 }))).toBe(
      "unknown",
    );
    expect(await classifyBundle(archive(entries, { offset: 40 }))).toBe(
      "unknown",
    );
    expect(await classifyBundle(archive(entries))).toBe("kit");
  });

  it.each([
    ["an entry count", { count: 0xffff }],
    ["a directory size", { size: 0xffffffff }],
    ["a directory offset", { offset: 0xffffffff }],
  ])("gives up on a zip64 marker in %s", async (_name, over) => {
    expect(await classifyBundle(archive([entryBytes("kit.json")], over))).toBe(
      "unknown",
    );
  });

  it("gives up on a directory over its size cap", async () => {
    expect(
      await classifyBundle(
        archive([entryBytes("kit.json")], { size: 1024 * 1024 + 1 }),
      ),
    ).toBe("unknown");
  });

  it("steps over each entry's extra field and comment to the next name", async () => {
    expect(
      await classifyBundle(
        archive([
          entryBytes("notes.txt", { extra: 9 }),
          entryBytes("kit.json"),
        ]),
      ),
    ).toBe("kit");
    expect(
      await classifyBundle(
        archive([
          entryBytes("notes.txt", { comment: 7 }),
          entryBytes("segment.json"),
        ]),
      ),
    ).toBe("segment");
    expect(
      await classifyBundle(
        archive([
          entryBytes("notes.txt", { extra: 3, comment: 4 }),
          entryBytes("kit.json"),
        ]),
      ),
    ).toBe("kit");
  });

  it("stops at an entry that does not carry the entry signature", async () => {
    expect(
      await classifyBundle(
        archive([
          entryBytes("notes.txt", { signature: 0x12345678 }),
          entryBytes("kit.json"),
        ]),
      ),
    ).toBe("unknown");
  });

  it("stops at a name cut off by the end of the directory", async () => {
    const entry = entryBytes("kit.json");
    new DataView(entry.buffer).setUint16(28, 200, true);
    expect(await classifyBundle(archive([entry]))).toBe("unknown");
  });

  it("calls a file it cannot read unknown instead of failing", async () => {
    const file = zipFile("a.zip", ["kit.json"]);
    const broken = Object.assign(file.slice(), {
      arrayBuffer: () => Promise.reject(new Error("read failed")),
    });
    vi.spyOn(file, "slice").mockReturnValue(broken);
    await expect(classifyBundle(file)).resolves.toBe("unknown");
  });
});
