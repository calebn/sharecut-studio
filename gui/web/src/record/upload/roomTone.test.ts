import { describe, expect, it } from "vitest";
import { KEEPER_BYTES_PER_SECOND } from "../keeper/pcm";
import { ROOM_TONE_DURATION_SEC } from "../types";
import { uploadRoomToneWav } from "./roomTone";
import { memoryUploadTransport } from "./transport";

describe("uploadRoomToneWav", () => {
  it("sends a one-minute bed as two 30 s parts, since one part would not fit", async () => {
    const transport = memoryUploadTransport();
    const wav = new Uint8Array(
      44 + KEEPER_BYTES_PER_SECOND * ROOM_TONE_DURATION_SEC,
    );
    const result = await uploadRoomToneWav({ wav, transport });
    expect(transport.puts).toBe(2);
    expect(result.fileAck).toBe(true);
  });

  it("puts one room_tone part", async () => {
    const transport = memoryUploadTransport();
    const wav = new Uint8Array(44 + 8);
    wav.set([82, 73, 70, 70], 0);
    const result = await uploadRoomToneWav({ wav, transport });
    expect(transport.puts).toBe(1);
    expect(result).toEqual({
      fileAck: true,
      landed: true,
      landFailed: false,
    });
  });
});
