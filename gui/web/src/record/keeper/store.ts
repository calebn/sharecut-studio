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
  remove(path: string): Promise<void>;
  open(path: string): Promise<ByteStream>;
  nextSegmentIndex(
    sessionId: string,
    takeIndex: number,
    participantId: string,
  ): Promise<number>;
};

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
    throw new Error(
      "This browser cannot store a local keeper copy (OPFS unavailable).",
    );
  }
  const root = await storage.getDirectory();
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
      } catch {
        return;
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
