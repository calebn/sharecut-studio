import { KEEPER_SAMPLE_RATE } from "./pcm";

export type KeeperMeta = {
  sessionId: string;
  takeIndex: number;
  participantId: string;
  segmentIndex: number;
  sampleRate: number;
  joinOffsetMs: number;
  samplesWritten: number;
  /** True only after the WAV writable has closed successfully. */
  complete: boolean;
  /** Fingerprint of the closed WAV, present on newly finalized segments. */
  fileSha256?: string;
  byteLength?: number;
};

/**
 * Metadata as read back from OPFS. `complete` is absent on files finalized by
 * clients that predate explicit completion (they only wrote metadata on close).
 */
export type StoredKeeperMeta = Omit<KeeperMeta, "complete"> & {
  complete?: boolean;
};

/** Upper bounds for OPFS keeper enumeration; guards stray or hostile names. */
export const MAX_KEEPER_TAKES = 1000;
export const MAX_KEEPER_SEGMENTS = 1000;
/** Incomplete WAVs without metadata remain available for manual export. */
export const ORPHAN_KEEPER_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type ByteStream = {
  write(bytes: Uint8Array, offset?: number): Promise<void>;
  close(): Promise<void>;
};

export type ByteSink = {
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  /** Return the native file when available so recovery need not copy large WAVs. */
  readBlob?(path: string): Promise<Blob | null>;
  /** Modification time for bounded-age cleanup, without loading PCM. */
  modifiedAt?(path: string): Promise<number | null>;
  /**
   * Atomically replace the leading bytes of an existing file and truncate it
   * to `byteLength`, keeping the remaining bytes without copying them.
   */
  rewriteHeader?(
    path: string,
    header: Uint8Array,
    byteLength: number,
  ): Promise<void>;
  /**
   * Delete `path`. A missing entry resolves; any other failure (a locked
   * entry, `NoModificationAllowedError`, `InvalidStateError`) rejects so
   * keeper reclaim can tell whether bytes were really freed. Callers doing
   * best-effort cleanup use {@link removeBestEffort}.
   */
  remove(path: string): Promise<void>;
  open(path: string): Promise<ByteStream>;
  nextSegmentIndex(
    sessionId: string,
    takeIndex: number,
    participantId: string,
  ): Promise<number>;
};

export class OpfsUnavailableError extends Error {
  constructor() {
    super(
      "Local recording backup is unavailable because this browser or app environment does not support OPFS.",
    );
    this.name = "OpfsUnavailableError";
  }
}

function assertSafePart(part: string): string {
  if (
    !part ||
    part.includes("/") ||
    part.includes("\\") ||
    part === ".." ||
    part === "."
  ) {
    throw new Error("invalid keeper path part");
  }
  return part;
}

function assertIndex(n: number): string {
  if (!Number.isInteger(n) || !Number.isFinite(n)) {
    throw new Error("invalid keeper path part");
  }
  return assertSafePart(String(n));
}

export function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function keeperWavPath(
  meta: Omit<
    KeeperMeta,
    "sampleRate" | "joinOffsetMs" | "samplesWritten" | "complete"
  >,
): string {
  const segment = assertIndex(meta.segmentIndex);
  return [
    "Sharecut Recordings",
    assertSafePart(meta.sessionId),
    assertIndex(meta.takeIndex),
    assertSafePart(meta.participantId),
    `${segment}.wav`,
  ].join("/");
}

export function keeperMetaPath(wavPath: string): string {
  return wavPath.replace(/\.wav$/i, ".json");
}

type PrunedKeeperMarker = {
  pruned: true;
  sessionId: string;
  takeIndex: number;
  participantId: string;
  segmentIndex: number;
};

/** A marker reserves the segment identity after its expired WAV is removed. */
export function prunedKeeperMarker(
  bytes: Uint8Array | null,
  wavPath: string,
): boolean {
  if (!bytes) return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object") return false;
    const marker = value as Partial<PrunedKeeperMarker>;
    return (
      marker.pruned === true &&
      typeof marker.sessionId === "string" &&
      typeof marker.participantId === "string" &&
      isIndex(marker.takeIndex) &&
      isIndex(marker.segmentIndex) &&
      keeperWavPath(marker as PrunedKeeperMarker) === wavPath
    );
  } catch {
    return false;
  }
}

/** Prune only settled, old metadata-free WAVs; keep their indexes reserved. */
export async function pruneExpiredKeeperWavs(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  lastTakeIndex: number,
  canPrune: () => boolean,
  now = Date.now(),
): Promise<number> {
  if (!sink.modifiedAt) return 0;
  let pruned = 0;
  for await (const { takeIndex, segmentIndex, wavPath } of keeperSegmentPaths(
    sink,
    sessionId,
    participantId,
    lastTakeIndex,
  )) {
    if (!canPrune()) break;
    const metaPath = keeperMetaPath(wavPath);
    const existing = await sink.read(metaPath);
    if (existing && !prunedKeeperMarker(existing, wavPath)) continue;
    const modified = await sink.modifiedAt(wavPath);
    if (modified === null || now - modified < ORPHAN_KEEPER_RETENTION_MS) {
      continue;
    }
    if (!canPrune()) break;
    const currentMeta = await sink.read(metaPath);
    if (currentMeta && !prunedKeeperMarker(currentMeta, wavPath)) continue;
    const marker: PrunedKeeperMarker = {
      pruned: true,
      sessionId,
      takeIndex,
      participantId,
      segmentIndex,
    };
    await sink.write(
      metaPath,
      new TextEncoder().encode(JSON.stringify(marker)),
    );
    if (!canPrune()) break;
    await sink.remove(wavPath);
    pruned += 1;
  }
  return pruned;
}

/** True when `meta` names exactly the keeper file at `wavPath`. */
export function keeperMetaMatchesPath(
  meta: Pick<
    KeeperMeta,
    "sessionId" | "takeIndex" | "participantId" | "segmentIndex"
  >,
  wavPath: string,
): boolean {
  try {
    return keeperWavPath(meta) === wavPath;
  } catch {
    return false;
  }
}

/** Best-effort delete for disposable files (room tone, probes). */
export async function removeBestEffort(
  sink: ByteSink,
  path: string,
): Promise<boolean> {
  try {
    await sink.remove(path);
    return true;
  } catch {
    return false;
  }
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Parse and type-check keeper metadata; returns null for anything malformed. */
export function parseKeeperMeta(
  bytes: Uint8Array | null,
): StoredKeeperMeta | null {
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.sessionId !== "string" ||
    typeof raw.participantId !== "string" ||
    !isIndex(raw.takeIndex) ||
    !isIndex(raw.segmentIndex) ||
    !isIndex(raw.samplesWritten) ||
    raw.sampleRate !== KEEPER_SAMPLE_RATE ||
    typeof raw.joinOffsetMs !== "number" ||
    !Number.isFinite(raw.joinOffsetMs) ||
    raw.joinOffsetMs < 0 ||
    (raw.complete !== undefined && typeof raw.complete !== "boolean") ||
    (raw.fileSha256 !== undefined &&
      (typeof raw.fileSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(raw.fileSha256))) ||
    (raw.byteLength !== undefined && !isIndex(raw.byteLength))
  ) {
    return null;
  }
  return {
    sessionId: raw.sessionId,
    takeIndex: raw.takeIndex,
    participantId: raw.participantId,
    segmentIndex: raw.segmentIndex,
    sampleRate: raw.sampleRate,
    joinOffsetMs: raw.joinOffsetMs,
    samplesWritten: raw.samplesWritten,
    ...(raw.complete === undefined ? {} : { complete: raw.complete }),
    ...(raw.fileSha256 === undefined
      ? {}
      : { fileSha256: raw.fileSha256 as string }),
    ...(raw.byteLength === undefined
      ? {}
      : { byteLength: raw.byteLength as number }),
  };
}

/** The single writer for keeper metadata JSON next to `wavPath`. */
export async function writeKeeperMeta(
  sink: ByteSink,
  wavPath: string,
  meta: KeeperMeta,
): Promise<void> {
  await sink.write(
    keeperMetaPath(wavPath),
    new TextEncoder().encode(`${JSON.stringify(meta, null, 2)}\n`),
  );
}

export type KeeperSegmentRef = {
  takeIndex: number;
  segmentIndex: number;
  wavPath: string;
};

/** Every keeper segment path for one participant, bounded by the MAX_* caps. */
export async function* keeperSegmentPaths(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  lastTakeIndex: number,
): AsyncGenerator<KeeperSegmentRef> {
  const lastTake = Math.min(lastTakeIndex, MAX_KEEPER_TAKES - 1);
  for (let takeIndex = 0; takeIndex <= lastTake; takeIndex += 1) {
    const count = Math.min(
      await sink.nextSegmentIndex(sessionId, takeIndex, participantId),
      MAX_KEEPER_SEGMENTS,
    );
    for (let segmentIndex = 0; segmentIndex < count; segmentIndex += 1) {
      yield {
        takeIndex,
        segmentIndex,
        wavPath: keeperWavPath({
          sessionId,
          takeIndex,
          participantId,
          segmentIndex,
        }),
      };
    }
  }
}

/**
 * True when metadata marks its WAV as closed: `complete: true`, or a valid
 * older-client record without the field (those were only written after
 * close). Pending (`complete: false`) and unreadable metadata are not complete:
 * a pending record is written at segment open, so a torn or malformed file may
 * describe a WAV that never closed.
 */
export function keeperMetaComplete(bytes: Uint8Array | null): boolean {
  const meta = parseKeeperMeta(bytes);
  return meta !== null && meta.complete !== false;
}

/**
 * Single source of truth for why a keeper segment has no local WAV. Callers
 * probe the WAV themselves (upload reads bytes, recovery a `Blob`) and ask
 * here only when it is absent:
 * - `reclaimed`: deleted after confirmed landing; its completion marker
 *   remains. Not lost audio, so recovery and upload skip it.
 * - `missing`: no WAV and no completion marker, i.e. genuinely lost.
 */
export async function missingKeeperWavState(
  sink: ByteSink,
  wavPath: string,
): Promise<"reclaimed" | "pruned" | "missing"> {
  const meta = await sink.read(keeperMetaPath(wavPath));
  if (prunedKeeperMarker(meta, wavPath)) return "pruned";
  return keeperMetaComplete(meta) ? "reclaimed" : "missing";
}

export function keeperDirPrefix(
  sessionId: string,
  takeIndex: number,
  participantId: string,
): string {
  return [
    "Sharecut Recordings",
    assertSafePart(sessionId),
    assertIndex(takeIndex),
    assertSafePart(participantId),
  ].join("/");
}

export function roomToneWavPath(
  sessionId: string,
  participantId: string,
): string {
  return [
    "Sharecut Recordings",
    assertSafePart(sessionId),
    "room-tone",
    `${assertSafePart(participantId)}.wav`,
  ].join("/");
}

function maxWavIndex(names: string[]): number {
  let max = -1;
  for (const name of names) {
    // Metadata (pending or complete) can outlive its WAV, e.g. after a landed
    // WAV is reclaimed. Count it so a later take never reuses an identity.
    const match = /^(\d+)\.(?:wav|json)$/i.exec(name);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

export class MemorySink implements ByteSink {
  readonly files = new Map<string, Uint8Array>();
  readonly modified = new Map<string, number>();

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
    this.modified.set(path, Date.now());
  }

  async modifiedAt(path: string): Promise<number | null> {
    return this.modified.get(path) ?? null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async readBlob(path: string): Promise<Blob | null> {
    const bytes = this.files.get(path);
    return bytes ? new Blob([copyBuffer(bytes)]) : null;
  }

  async rewriteHeader(
    path: string,
    header: Uint8Array,
    byteLength: number,
  ): Promise<void> {
    const current = this.files.get(path);
    if (!current) throw new Error("keeper file not found");
    const next = new Uint8Array(byteLength);
    next.set(current.subarray(0, byteLength));
    next.set(header.subarray(0, byteLength), 0);
    this.files.set(path, next);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.modified.delete(path);
  }

  async open(path: string): Promise<ByteStream> {
    let data = this.files.get(path) ?? new Uint8Array(0);
    return {
      write: async (bytes: Uint8Array, offset = data.length) => {
        const end = offset + bytes.length;
        if (end > data.length) {
          const next = new Uint8Array(end);
          next.set(data);
          data = next;
        }
        data.set(bytes, offset);
        this.files.set(path, data);
        this.modified.set(path, Date.now());
      },
      close: async () => {
        this.files.set(path, data);
        this.modified.set(path, Date.now());
      },
    };
  }

  async nextSegmentIndex(
    sessionId: string,
    takeIndex: number,
    participantId: string,
  ): Promise<number> {
    const prefix = `${keeperDirPrefix(sessionId, takeIndex, participantId)}/`;
    const names: string[] = [];
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) {
        names.push(path.slice(prefix.length));
      }
    }
    return maxWavIndex(names);
  }
}

export async function createOpfsSink(): Promise<ByteSink> {
  const storage = navigator.storage;
  if (!storage?.getDirectory) {
    throw new OpfsUnavailableError();
  }
  const root = await storage.getDirectory();
  await assertOpfsWritable(root);
  return {
    async write(path: string, bytes: Uint8Array) {
      const file = await fileHandle(root, path, true);
      const writable = await file.createWritable();
      try {
        await writable.write(copyBuffer(bytes));
      } catch (error) {
        // Abort discards the swap file so a failed write never commits a
        // truncated file over the previous contents.
        await writable.abort().catch(() => undefined);
        throw error;
      }
      await writable.close();
    },
    async rewriteHeader(path: string, header: Uint8Array, byteLength: number) {
      const file = await fileHandle(root, path, false);
      const writable = await file.createWritable({ keepExistingData: true });
      try {
        await writable.truncate(byteLength);
        await writable.seek(0);
        await writable.write(copyBuffer(header));
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      await writable.close();
    },
    async read(path: string) {
      try {
        const file = await fileHandle(root, path, false);
        const blob = await file.getFile();
        return new Uint8Array(await blob.arrayBuffer());
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          return null;
        }
        throw error;
      }
    },
    async readBlob(path: string) {
      try {
        const file = await fileHandle(root, path, false);
        return await file.getFile();
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          return null;
        }
        throw error;
      }
    },
    async modifiedAt(path: string) {
      try {
        const file = await fileHandle(root, path, false);
        return (await file.getFile()).lastModified;
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          return null;
        }
        throw error;
      }
    },
    async remove(path: string) {
      const parts = path.split("/").filter(Boolean);
      const fileName = parts.pop();
      if (!fileName) {
        return;
      }
      try {
        let dir = root;
        for (const part of parts) {
          dir = await dir.getDirectoryHandle(part);
        }
        await dir.removeEntry(fileName);
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          return;
        }
        throw error;
      }
    },
    async open(path: string) {
      const file = await fileHandle(root, path, true);
      const writable = await file.createWritable();
      return {
        async write(bytes: Uint8Array, offset?: number) {
          if (offset !== undefined) {
            await writable.seek(offset);
          }
          await writable.write(copyBuffer(bytes));
        },
        async close() {
          await writable.close();
        },
      };
    },
    async nextSegmentIndex(
      sessionId: string,
      takeIndex: number,
      participantId: string,
    ) {
      const parts = keeperDirPrefix(sessionId, takeIndex, participantId).split(
        "/",
      );
      let dir = root;
      try {
        for (const part of parts) {
          dir = await dir.getDirectoryHandle(part);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          return 0;
        }
        throw error;
      }
      const names: string[] = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "file") {
          names.push(name);
        }
      }
      return maxWavIndex(names);
    },
  };
}

function probeFileName(): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `.sharecut-opfs-probe-${id}`;
}

async function assertOpfsWritable(
  root: FileSystemDirectoryHandle,
): Promise<void> {
  const name = probeFileName();
  const keeperRoot = await root.getDirectoryHandle("Sharecut Recordings", {
    create: true,
  });
  let writable: FileSystemWritableFileStream | undefined;
  try {
    const file = await keeperRoot.getFileHandle(name, { create: true });
    writable = await file.createWritable();
    await writable.write(new Uint8Array([0]));
    await writable.close();
    writable = undefined;
  } catch (error) {
    if (writable) {
      try {
        await writable.close();
      } catch {
        // Preserve the original OPFS readiness failure.
      }
    }
    throw error;
  } finally {
    try {
      await keeperRoot.removeEntry(name);
    } catch {
      // A cleanup failure must not hide a readiness failure.
    }
  }
}

async function fileHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) {
    throw new Error("invalid keeper path");
  }
  let dir = root;
  for (const part of parts) {
    assertSafePart(part);
    dir = await dir.getDirectoryHandle(part, { create });
  }
  assertSafePart(
    fileName.replace(/\.wav$/i, "").replace(/\.json$/i, "") || fileName,
  );
  return dir.getFileHandle(fileName, { create });
}
