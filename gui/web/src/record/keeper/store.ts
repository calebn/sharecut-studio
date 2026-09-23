export type KeeperMeta = {
  sessionId: string;
  takeIndex: number;
  participantId: string;
  segmentIndex: number;
  sampleRate: number;
  joinOffsetMs: number;
  samplesWritten: number;
  /**
   * `true` once the WAV is closed. A pending marker written at segment open
   * carries `false`; metadata from older clients (written only after close)
   * omits the field and is treated as complete.
   */
  complete?: boolean;
};

export type ByteStream = {
  write(bytes: Uint8Array, offset?: number): Promise<void>;
  close(): Promise<void>;
};

export type ByteSink = {
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  /** Return the native file when available so recovery need not copy large WAVs. */
  readBlob?(path: string): Promise<Blob | null>;
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

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function keeperWavPath(
  meta: Omit<KeeperMeta, "sampleRate" | "joinOffsetMs" | "samplesWritten">,
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

/** True when completion metadata marks its WAV as closed. */
export function keeperMetaComplete(bytes: Uint8Array | null): boolean {
  if (!bytes) {
    return false;
  }
  try {
    const meta = JSON.parse(new TextDecoder().decode(bytes)) as {
      complete?: unknown;
    };
    return meta?.complete !== false;
  } catch {
    // Legacy behaviour: present-but-unreadable metadata was written after
    // close, so it still marks a finalized segment.
    return true;
  }
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
): Promise<"reclaimed" | "missing"> {
  return keeperMetaComplete(await sink.read(keeperMetaPath(wavPath)))
    ? "reclaimed"
    : "missing";
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
    // Completion metadata remains after a landed WAV is reclaimed. Count it
    // as well so a later take never reuses a segment identity.
    const match = /^(\d+)\.(?:wav|json)$/i.exec(name);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

export class MemorySink implements ByteSink {
  readonly files = new Map<string, Uint8Array>();

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
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
      },
      close: async () => {
        this.files.set(path, data);
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
      } finally {
        await writable.close();
      }
    },
    async read(path: string) {
      try {
        const file = await fileHandle(root, path, false);
        const blob = await file.getFile();
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        return null;
      }
    },
    async readBlob(path: string) {
      try {
        const file = await fileHandle(root, path, false);
        return await file.getFile();
      } catch {
        return null;
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
      try {
        const parts = keeperDirPrefix(
          sessionId,
          takeIndex,
          participantId,
        ).split("/");
        let dir = root;
        for (const part of parts) {
          dir = await dir.getDirectoryHandle(part);
        }
        const names: string[] = [];
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "file") {
            names.push(name);
          }
        }
        return maxWavIndex(names);
      } catch {
        return 0;
      }
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
