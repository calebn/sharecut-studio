import {
  PCM_WAV_HEADER_BYTES,
  parseWavHeader,
  pcmWavHeader,
  type WavHeader,
} from "../../audio/wavHeader";
import { errorMessage } from "../../utils/apiError";
import { plural } from "../../utils/format";
import { sha256Hex } from "../keeper/fingerprint";
import {
  isKeeperPcmFormat,
  KEEPER_CHANNELS,
  KEEPER_FRAME_BYTES,
  KEEPER_SAMPLE_RATE,
} from "../keeper/pcm";
import { holdKeeperReclaim } from "../keeper/reclaim";
import {
  type ByteSink,
  copyBuffer,
  keeperMetaComplete,
  keeperMetaMatchesPath,
  keeperMetaPath,
  keeperSegmentPaths,
  missingKeeperWavState,
  parseKeeperMeta,
  prunedKeeperMarker,
  type StoredKeeperMeta,
  writeKeeperMeta,
} from "../keeper/store";
import { KEEPER_ALL_RECLAIMED_COPY } from "../types";
import { makeKeeperArchive } from "./archive";

/** Enough bytes to parse the RIFF/fmt/data chunk headers of a keeper WAV. */
const HEADER_PROBE_BYTES = 4096;

/** Everything a recovery rewrite needs, gathered by one header-only probe. */
export type KeeperRecoveryPlan = {
  meta: StoredKeeperMeta;
  /** Whole PCM frames that will be kept. */
  pcmBytes: number;
  /** Trailing bytes of an incomplete final frame that will be dropped. */
  trimmedBytes: number;
};

export type KeeperRecoveryStatus =
  | { kind: "complete"; joinOffsetMs: number }
  | { kind: "pruned" }
  /** Not finalized, and not inspected because capture may still be open. */
  | { kind: "pending" }
  | { kind: "recoverable"; plan: KeeperRecoveryPlan }
  | { kind: "unrecoverable"; reason: string };

type HeaderProbe = { size: number; header: WavHeader | null };

/** Read only the WAV header and file size, without copying the PCM. */
async function probeKeeperWav(
  sink: ByteSink,
  wavPath: string,
): Promise<HeaderProbe | null> {
  let size: number;
  let head: ArrayBuffer;
  if (sink.readBlob) {
    const blob = await sink.readBlob(wavPath);
    if (!blob) return null;
    size = blob.size;
    head = await blob.slice(0, HEADER_PROBE_BYTES).arrayBuffer();
  } else {
    const bytes = await sink.read(wavPath);
    if (!bytes) return null;
    size = bytes.byteLength;
    head = copyBuffer(bytes.subarray(0, HEADER_PROBE_BYTES));
  }
  try {
    return { size, header: parseWavHeader(head) };
  } catch {
    return { size, header: null };
  }
}

/** Legacy metadata (no `complete`) was only written after a successful close. */
function legacyFinalized(
  probe: HeaderProbe | null,
  meta: StoredKeeperMeta,
): boolean {
  const header = probe?.header;
  return (
    !!probe &&
    !!header &&
    isKeeperPcmFormat(header) &&
    header.dataSize === probe.size - header.dataOffset &&
    header.dataSize === meta.samplesWritten * KEEPER_FRAME_BYTES
  );
}

const NO_PCM_REASON =
  "The interrupted keeper contains no committed PCM; download the retained local copy.";

/**
 * Classify one keeper segment. Complete segments are recognized from metadata
 * alone; pending ones are only probed (header bytes, never the PCM) when
 * `inspectPending` is true, i.e. once capture can no longer be writing them.
 */
export async function inspectKeeperRecovery(
  sink: ByteSink,
  wavPath: string,
  options: { inspectPending?: boolean } = {},
): Promise<KeeperRecoveryStatus> {
  const metaBytes = await sink.read(keeperMetaPath(wavPath));
  if (prunedKeeperMarker(metaBytes, wavPath)) {
    // A failed remove can leave the WAV alongside its marker; keep it visible.
    return (await probeKeeperWav(sink, wavPath))
      ? {
          kind: "unrecoverable",
          reason: "The local keeper has no readable recovery metadata.",
        }
      : { kind: "pruned" };
  }
  const meta = parseKeeperMeta(metaBytes);
  if (!meta) {
    return {
      kind: "unrecoverable",
      reason: "The local keeper has no readable recovery metadata.",
    };
  }
  if (!keeperMetaMatchesPath(meta, wavPath)) {
    return {
      kind: "unrecoverable",
      reason:
        "The local keeper has invalid placement metadata; download it before leaving.",
    };
  }
  if (meta.complete === true) {
    return { kind: "complete", joinOffsetMs: meta.joinOffsetMs };
  }
  let probe: HeaderProbe | null | undefined;
  if (meta.complete === undefined) {
    probe = await probeKeeperWav(sink, wavPath);
    // Legacy metadata was only written after a successful close, so a missing
    // WAV was reclaimed after landing (see missingKeeperWavState), not lost.
    if (!probe || legacyFinalized(probe, meta)) {
      return { kind: "complete", joinOffsetMs: meta.joinOffsetMs };
    }
  }
  if (options.inspectPending === false) {
    return { kind: "pending" };
  }
  probe ??= await probeKeeperWav(sink, wavPath);
  if (!probe || probe.size <= PCM_WAV_HEADER_BYTES) {
    return { kind: "unrecoverable", reason: NO_PCM_REASON };
  }
  const header = probe.header;
  if (
    !header ||
    !isKeeperPcmFormat(header) ||
    header.dataOffset !== PCM_WAV_HEADER_BYTES
  ) {
    return {
      kind: "unrecoverable",
      reason:
        "The interrupted keeper is not a readable PCM WAV; download the retained local copy.",
    };
  }
  const available = probe.size - header.dataOffset;
  const pcmBytes = available - (available % KEEPER_FRAME_BYTES);
  if (pcmBytes === 0) {
    return { kind: "unrecoverable", reason: NO_PCM_REASON };
  }
  return {
    kind: "recoverable",
    plan: { meta, pcmBytes, trimmedBytes: available - pcmBytes },
  };
}

/**
 * Finalize one inspected segment in place: patch its header (dropping any
 * incomplete trailing frame), then mark its metadata complete. Both writes are
 * atomic, and repeating them after a partial failure is idempotent.
 */
export async function recoverKeeperSegment(
  sink: ByteSink,
  wavPath: string,
  plan: KeeperRecoveryPlan,
): Promise<void> {
  const byteLength = PCM_WAV_HEADER_BYTES + plan.pcmBytes;
  const header = pcmWavHeader(
    plan.pcmBytes,
    KEEPER_SAMPLE_RATE,
    KEEPER_CHANNELS,
  );
  if (sink.rewriteHeader) {
    await sink.rewriteHeader(wavPath, header, byteLength);
  } else {
    const wav = await sink.read(wavPath);
    if (!wav || wav.byteLength < byteLength) {
      throw new Error("The retained local keeper changed during recovery.");
    }
    const recovered = wav.slice(0, byteLength);
    recovered.set(header, 0);
    await sink.write(wavPath, recovered);
  }
  const finalized = await sink.read(wavPath);
  if (!finalized || finalized.byteLength !== byteLength) {
    throw new Error("The retained local keeper changed during recovery.");
  }
  await writeKeeperMeta(sink, wavPath, {
    ...plan.meta,
    samplesWritten: plan.pcmBytes / KEEPER_FRAME_BYTES,
    complete: true,
    fileSha256: await sha256Hex(finalized),
    byteLength,
  });
}

export type KeeperRecoveryResult = {
  recovered: number;
  /** Segments whose incomplete trailing sample was dropped. */
  trimmed: number;
};

/**
 * Recover every readable pending segment. `canRecover` is re-checked before
 * each segment so a take that resumed mid-run is never touched. One failing
 * segment does not stop the others; all failures are reported together.
 */
export async function recoverLocalKeepers(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  lastTakeIndex: number,
  canRecover: () => boolean = () => true,
): Promise<KeeperRecoveryResult> {
  const result: KeeperRecoveryResult = { recovered: 0, trimmed: 0 };
  const failures: string[] = [];
  for await (const { takeIndex, segmentIndex, wavPath } of keeperSegmentPaths(
    sink,
    sessionId,
    participantId,
    lastTakeIndex,
  )) {
    if (!canRecover()) {
      failures.push(
        "Recording resumed before recovery finished; recover again after the take stops.",
      );
      break;
    }
    try {
      const status = await inspectKeeperRecovery(sink, wavPath);
      if (status.kind !== "recoverable") continue;
      await recoverKeeperSegment(sink, wavPath, status.plan);
      result.recovered += 1;
      if (status.plan.trimmedBytes > 0) result.trimmed += 1;
    } catch (error) {
      failures.push(
        `Take ${takeIndex + 1}, segment ${segmentIndex + 1}: ${errorMessage(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Recovered ${result.recovered} partial ${result.recovered === 1 ? "segment" : "segments"}. ${failures.join(" ")}`,
    );
  }
  return result;
}

async function keeperBlob(sink: ByteSink, path: string): Promise<Blob | null> {
  if (sink.readBlob) return sink.readBlob(path);
  const bytes = await sink.read(path);
  if (!bytes) return null;
  return new Blob([copyBuffer(bytes)], { type: "audio/wav" });
}

/**
 * Keeper reclaim stays paused this long after a recovery download is handed
 * to the browser: the archive references OPFS `File`s that are read lazily
 * while the download is written, so deleting one would fail the ZIP.
 */
export const RECOVERY_RECLAIM_GRACE_MS = 5 * 60_000;

async function withReclaimHeld<T>(
  sink: ByteSink,
  run: () => Promise<T>,
): Promise<T> {
  const release = await holdKeeperReclaim(sink);
  try {
    return await run();
  } finally {
    window.setTimeout(release, RECOVERY_RECLAIM_GRACE_MS);
  }
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
  return withReclaimHeld(sink, async () => {
    const blob = await keeperBlob(sink, path);
    if (!blob) return false;
    downloadBlob(blob, filename);
    return true;
  });
}

export async function downloadLocalKeepers(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  lastTakeIndex: number,
): Promise<void> {
  return withReclaimHeld(sink, async () => {
    let downloaded = 0;
    let missing = 0;
    let reclaimed = 0;
    const entries: Array<{ filename: string; data: Blob }> = [];
    for await (const { takeIndex, segmentIndex, wavPath } of keeperSegmentPaths(
      sink,
      sessionId,
      participantId,
      lastTakeIndex,
    )) {
      const blob = await keeperBlob(sink, wavPath);
      if (blob) {
        // A WAV whose metadata is missing or still `complete: false` stopped
        // mid-write (its header may still report zero data bytes); label it
        // rather than pass it off as a finished segment.
        const complete = keeperMetaComplete(
          await sink.read(keeperMetaPath(wavPath)),
        );
        const suffix = complete ? "" : "-partial";
        entries.push({
          filename: `keeper-${takeIndex}-${segmentIndex}${suffix}.wav`,
          data: blob,
        });
        downloaded += 1;
      } else {
        const state = await missingKeeperWavState(sink, wavPath);
        if (state === "reclaimed") {
          // Landed safely on the host and cleared locally; not lost audio.
          reclaimed += 1;
        } else if (state === "missing") {
          missing += 1;
        }
      }
    }
    if (downloaded === 0 && missing === 0 && reclaimed > 0) {
      throw new Error(KEEPER_ALL_RECLAIMED_COPY);
    }
    if (downloaded === 0) {
      throw new Error("No local keeper copy is available to download.");
    }
    const archive = await makeKeeperArchive(entries);
    downloadBlob(archive, `keepers-${participantId}.zip`);
    if (missing > 0) {
      throw new Error(
        `Downloaded ${downloaded} local keeper ${plural(downloaded, "copy", "copies")}; ${missing} missing ${plural(missing, "segment")} could not be exported.`,
      );
    }
  });
}
