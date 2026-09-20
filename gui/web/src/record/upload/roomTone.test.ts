import { describe, expect, it } from "vitest";
import { uploadRoomToneWav } from "./roomTone";
import { memoryUploadTransport } from "./transport";

describe("uploadRoomToneWav", () => {
  it("puts one room_tone part", async () => {
    const transport = memoryUploadTransport();
    const wav = new Uint8Array(44 + 8);
    wav.set([82, 73, 70, 70], 0);
    await uploadRoomToneWav({ wav, transport });
    expect(transport.puts).toBe(1);
  });
});
