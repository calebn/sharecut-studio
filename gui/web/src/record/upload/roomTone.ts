import { keeperPcmParts } from "./chunker";
import { uploadKeeperWav } from "./pump";
import type { RecordUploadTransport } from "./transport";

export async function uploadRoomToneWav(args: {
  wav: Uint8Array;
  transport: RecordUploadTransport;
  signal?: AbortSignal;
}): Promise<{ fileAck: boolean; landed: boolean; landFailed: boolean }> {
  // A minute outgrows one upload part, so the bed goes up as keeper-sized parts.
  if (keeperPcmParts(args.wav).length === 0) {
    throw new Error("room tone has no audio");
  }
  const { fileAck, landed, landFailed } = await uploadKeeperWav({
    wav: args.wav,
    takeIndex: 0,
    segmentIndex: 0,
    transport: args.transport,
    ackedParts: [],
    fileAck: false,
    kind: "room_tone",
    signal: args.signal,
  });
  return { fileAck, landed, landFailed };
}
