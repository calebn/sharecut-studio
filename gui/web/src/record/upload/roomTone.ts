import { keeperPcmParts } from "./chunker";
import { uploadKeeperWav } from "./pump";
import type { RecordUploadTransport } from "./transport";

export async function uploadRoomToneWav(args: {
  wav: Uint8Array;
  transport: RecordUploadTransport;
  signal?: AbortSignal;
}): Promise<void> {
  const parts = keeperPcmParts(args.wav, true);
  if (parts.length !== 1 || !parts[0]) {
    throw new Error("room tone must be a single part");
  }
  await uploadKeeperWav({
    wav: args.wav,
    complete: true,
    takeIndex: 0,
    segmentIndex: 0,
    transport: args.transport,
    ackedParts: [],
    fileAck: false,
    kind: "room_tone",
    signal: args.signal,
  });
}
