import { type ByteSink, keeperWavPath } from "../keeper/store";

export async function downloadLocalKeeper(
  sink: ByteSink,
  path: string,
  filename: string,
): Promise<void> {
  const bytes = await sink.read(path);
  if (!bytes) {
    throw new Error(`Local keeper is unavailable: ${path}`);
  }
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const url = URL.createObjectURL(
    new Blob([copy.buffer], { type: "audio/wav" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadLocalKeepers(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  lastTakeIndex: number,
): Promise<void> {
  let downloaded = 0;
  for (let take = 0; take <= lastTakeIndex; take += 1) {
    const count = await sink.nextSegmentIndex(sessionId, take, participantId);
    for (let segment = 0; segment < count; segment += 1) {
      await downloadLocalKeeper(
        sink,
        keeperWavPath({
          sessionId,
          takeIndex: take,
          participantId,
          segmentIndex: segment,
        }),
        `keeper-${take}-${segment}.wav`,
      );
      downloaded += 1;
    }
  }
  if (downloaded === 0) {
    throw new Error("No local keeper copy is available to download.");
  }
}
