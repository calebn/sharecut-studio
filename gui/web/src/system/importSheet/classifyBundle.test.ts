import { describe, expect, it } from "vitest";
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
