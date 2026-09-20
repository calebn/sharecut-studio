import { describe, expect, it } from "vitest";
import { RECORD_UPLOAD_PART_PCM_BYTES } from "./chunker";
import { uploadKeeperWav } from "./pump";
import { memoryUploadTransport } from "./transport";

function wavWithPcm(bytes: number): Uint8Array {
  const wav = new Uint8Array(44 + bytes);
  wav.fill(7, 44);
  return wav;
}

describe("uploadKeeperWav", () => {
  it("resumes after a killed mid-session PUT", async () => {
    const transport = memoryUploadTransport();
    const wav = wavWithPcm(RECORD_UPLOAD_PART_PCM_BYTES + 8);
    transport.failNext = true;
    await expect(
      uploadKeeperWav({
        wav,
        complete: true,
        takeIndex: 0,
        segmentIndex: 0,
        transport,
        ackedParts: [],
        fileAck: false,
      }),
    ).rejects.toThrow("killed");
    const status = await transport.status();
    expect(status.segments[0]?.acked_parts ?? []).toEqual([]);
    const done = await uploadKeeperWav({
      wav,
      complete: true,
      takeIndex: 0,
      segmentIndex: 0,
      transport,
      ackedParts: [],
      fileAck: false,
    });
    expect(done.fileAck).toBe(true);
    expect(done.total).toBe(2);
    expect(transport.puts).toBe(2);
  });

  it("skips already-acked parts on resume", async () => {
    const transport = memoryUploadTransport();
    const wav = wavWithPcm(RECORD_UPLOAD_PART_PCM_BYTES + 8);
    await uploadKeeperWav({
      wav,
      complete: false,
      takeIndex: 0,
      segmentIndex: 0,
      transport,
      ackedParts: [],
      fileAck: false,
    });
    expect(transport.puts).toBe(1);
    const again = await uploadKeeperWav({
      wav,
      complete: true,
      takeIndex: 0,
      segmentIndex: 0,
      transport,
      ackedParts: [0],
      fileAck: false,
    });
    expect(again.fileAck).toBe(true);
    expect(transport.puts).toBe(2);
  });

  it("does not re-PUT an already file-acked segment", async () => {
    const transport = memoryUploadTransport();
    const wav = wavWithPcm(8);
    const done = await uploadKeeperWav({
      wav,
      complete: true,
      takeIndex: 0,
      segmentIndex: 0,
      transport,
      ackedParts: [0],
      fileAck: true,
    });
    expect(done.fileAck).toBe(true);
    expect(transport.puts).toBe(0);
  });
});
