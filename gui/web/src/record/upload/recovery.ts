import { parseWavHeader, pcmWavHeader } from "../../audio/wavHeader";
import { type ByteSink, keeperWavPath } from "../keeper/store";
import { makeKeeperArchive } from "./archive";

export type KeeperRecoveryStatus =
  | { kind: "complete"; joinOffsetMs: number }
  | { kind: "recoverable" }
  | { kind: "unrecoverable"; reason: string };

type PendingMeta = {
  sessionId?: unknown;
  takeIndex?: unknown;
  participantId?: unknown;
  segmentIndex?: unknown;
  sampleRate?: unknown;
  joinOffsetMs?: unknown;
  samplesWritten?: unknown;
  complete?: unknown;
};

function parseMeta(bytes: Uint8Array | null): PendingMeta | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" ? (value as PendingMeta) : null;
  } catch {
    return null;
  }
}

function validPlacement(meta: PendingMeta, wavPath: string): boolean {
  const parts = wavPath.split("/");
  const [root, sessionId, takeIndex, participantId, filename] = parts;
  const segmentIndex = filename?.replace(/\.wav$/i, "");
  return (
    root === "Sharecut Recordings" &&
    typeof sessionId === "string" &&
    typeof participantId === "string" &&
    typeof segmentIndex === "string" &&
    meta.sessionId === sessionId &&
    meta.participantId === participantId &&
    meta.takeIndex === Number(takeIndex) &&
    meta.segmentIndex === Number(segmentIndex) &&
    Number.isInteger(meta.takeIndex) &&
    Number.isInteger(meta.segmentIndex) &&
    Number.isInteger(meta.samplesWritten) &&
    Number(meta.samplesWritten) >= 0 &&
    Number.isFinite(meta.joinOffsetMs) &&
    Number(meta.joinOffsetMs) >= 0 &&
    meta.sampleRate === 48_000
  );
}

function wavBuffer(wav: Uint8Array): ArrayBuffer {
  return wav.buffer.slice(
    wav.byteOffset,
    wav.byteOffset + wav.byteLength,
  ) as ArrayBuffer;
}

export async function inspectKeeperRecovery(
  sink: ByteSink,
  wavPath: string,
  metadataBytes?: Uint8Array | null,
): Promise<KeeperRecoveryStatus> {
  const meta = parseMeta(
    metadataBytes === undefined
      ? await sink.read(wavPath.replace(/\.wav$/i, ".json"))
      : metadataBytes,
  );
  if (!meta) {
    return {
      kind: "unrecoverable",
      reason: "The local keeper has no readable recovery metadata.",
    };
  }
  if (!validPlacement(meta, wavPath)) {
    return {
      kind: "unrecoverable",
      reason:
        "The local keeper has invalid placement metadata; download it before leaving.",
    };
  }
  if (meta.complete === true) {
    return { kind: "complete", joinOffsetMs: Number(meta.joinOffsetMs) };
  }
  const wav = await sink.read(wavPath);
  if (!wav || wav.byteLength <= 44) {
    return {
      kind: "unrecoverable",
      reason:
        "The interrupted keeper contains no committed PCM; download the retained local copy.",
    };
  }
  try {
    const header = parseWavHeader(wavBuffer(wav));
    const available = wav.byteLength - header.dataOffset;
    if (
      header.audioFormat !== 1 ||
      header.channels !== 1 ||
      header.sampleRate !== 48_000 ||
      header.bitsPerSample !== 16 ||
      header.blockAlign !== 2 ||
      available < 2 ||
      available % header.blockAlign !== 0
    ) {
      throw new Error("unsupported audio");
    }
    return { kind: "recoverable" };
  } catch {
    return {
      kind: "unrecoverable",
      reason:
        "The interrupted keeper is not a readable PCM WAV; download the retained local copy.",
    };
  }
}

export async function recoverKeeperSegment(
  sink: ByteSink,
  wavPath: string,
): Promise<void> {
  const status = await inspectKeeperRecovery(sink, wavPath);
  if (status.kind === "complete") return;
  if (status.kind !== "recoverable") throw new Error(status.reason);
  const wav = await sink.read(wavPath);
  if (!wav)
    throw new Error("The retained local keeper disappeared before recovery.");
  const metaPath = wavPath.replace(/\.wav$/i, ".json");
  const meta = parseMeta(await sink.read(metaPath));
  if (!meta || !validPlacement(meta, wavPath)) {
    throw new Error("The local keeper metadata changed during recovery.");
  }
  const header = parseWavHeader(wavBuffer(wav));
  const available = wav.byteLength - header.dataOffset;
  const pcmBytes = available;
  if (pcmBytes < 2 || pcmBytes % header.blockAlign !== 0) {
    throw new Error(
      "The interrupted keeper has an incomplete PCM frame; download the retained local copy.",
    );
  }
  const recovered = new Uint8Array(44 + pcmBytes);
  recovered.set(pcmWavHeader(pcmBytes, 48_000, 1));
  recovered.set(
    wav.subarray(header.dataOffset, header.dataOffset + pcmBytes),
    44,
  );
  // ByteSink.write uses OPFS's atomic close semantics, so a failed rewrite
  // leaves the original retained bytes available for export.
  await sink.write(wavPath, recovered);
  await sink.write(
    metaPath,
    new TextEncoder().encode(
      `${JSON.stringify({ ...meta, samplesWritten: pcmBytes / 2, complete: true }, null, 2)}\n`,
    ),
  );
}

export async function recoverLocalKeepers(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  lastTakeIndex: number,
): Promise<number> {
  let recovered = 0;
  for (let take = 0; take <= lastTakeIndex; take += 1) {
    const count = await sink.nextSegmentIndex(sessionId, take, participantId);
    for (let segment = 0; segment < count; segment += 1) {
      const path = keeperWavPath({
        sessionId,
        takeIndex: take,
        participantId,
        segmentIndex: segment,
      });
      if ((await inspectKeeperRecovery(sink, path)).kind === "recoverable") {
        await recoverKeeperSegment(sink, path);
        recovered += 1;
      }
    }
  }
  return recovered;
}

async function keeperBlob(sink: ByteSink, path: string): Promise<Blob | null> {
  if (sink.readBlob) return sink.readBlob(path);
  const bytes = await sink.read(path);
  if (!bytes) return null;
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return new Blob([copy.buffer], { type: "audio/wav" });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadLocalKeeper(
  sink: ByteSink,
  path: string,
  filename: string,
): Promise<boolean> {
  const blob = await keeperBlob(sink, path);
  if (!blob) return false;
  downloadBlob(blob, filename);
  return true;
}

export async function downloadLocalKeepers(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  lastTakeIndex: number,
): Promise<void> {
  let downloaded = 0;
  let missing = 0;
  const entries: Array<{ filename: string; data: Blob }> = [];
  for (let take = 0; take <= lastTakeIndex; take += 1) {
    const count = await sink.nextSegmentIndex(sessionId, take, participantId);
    for (let segment = 0; segment < count; segment += 1) {
      const path = keeperWavPath({
        sessionId,
        takeIndex: take,
        participantId,
        segmentIndex: segment,
      });
      const blob = await keeperBlob(sink, path);
      if (blob) {
        entries.push({ filename: `keeper-${take}-${segment}.wav`, data: blob });
        downloaded += 1;
      } else {
        missing += 1;
      }
    }
  }
  if (downloaded === 0) {
    throw new Error("No local keeper copy is available to download.");
  }
  const archive = await makeKeeperArchive(entries);
  downloadBlob(archive, `keepers-${participantId}.zip`);
  if (missing > 0) {
    throw new Error(
      `Downloaded ${downloaded} local keeper ${downloaded === 1 ? "copy" : "copies"}; ${missing} missing ${missing === 1 ? "segment" : "segments"} could not be exported.`,
    );
  }
}
