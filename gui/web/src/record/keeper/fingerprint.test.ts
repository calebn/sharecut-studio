import { describe, expect, it, vi } from "vitest";
import { keeperFileFingerprint, sha256Hex } from "./fingerprint";
import { MemorySink } from "./store";

describe("keeperFileFingerprint", () => {
  it("hashes a multi-chunk WAV without reading its full bytes", async () => {
    const sink = new MemorySink();
    const bytes = new Uint8Array(2 * 1024 * 1024 + 17);
    bytes.fill(23);
    await sink.write("long.wav", bytes);
    const read = vi.spyOn(sink, "read");
    const blob = await sink.readBlob("long.wav");
    const slice = vi.spyOn(blob!, "slice");
    sink.readBlob = async () => blob;
    expect(await keeperFileFingerprint(sink, "long.wav")).toEqual({
      fileSha256: await sha256Hex(bytes),
      byteLength: bytes.byteLength,
    });
    expect(slice).toHaveBeenCalledTimes(3);
    expect(read).not.toHaveBeenCalled();
  });
});
