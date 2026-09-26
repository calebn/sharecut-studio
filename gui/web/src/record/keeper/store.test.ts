import { describe, expect, it, vi } from "vitest";
import { keeperMetaBytes } from "../../test/keepers";
import { holdKeeperReclaim } from "./reclaim";
import {
  createOpfsSink,
  type KeeperMeta,
  keeperMetaComplete,
  keeperMetaMatchesPath,
  keeperMetaPath,
  keeperSegmentPaths,
  keeperWavPath,
  MAX_KEEPER_SEGMENTS,
  MAX_KEEPER_TAKES,
  MemorySink,
  missingKeeperWavState,
  OpfsUnavailableError,
  ORPHAN_KEEPER_RETENTION_MS,
  parseKeeperMeta,
  prunedKeeperMarker,
  pruneExpiredKeeperWavs,
  removeBestEffort,
  roomToneWavPath,
  writeKeeperMeta,
} from "./store";
import { SyncWriterUnavailableError } from "./syncWriterProtocol";

type FakeWritable = {
  write: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
  truncate: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeWritable(failWrite = false): FakeWritable {
  let writes = 0;
  return {
    // The first write is the readiness probe inside createOpfsSink.
    write: vi.fn(async () => {
      writes += 1;
      if (failWrite && writes > 1) throw new Error("quota exceeded");
    }),
    seek: vi.fn(async () => undefined),
    truncate: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

async function opfsSinkWith(
  writable: FakeWritable,
  options: Parameters<typeof createOpfsSink>[0] = {},
) {
  const createWritable = vi.fn(async () => writable);
  const root = {
    getDirectoryHandle: vi.fn(async () => root),
    getFileHandle: vi.fn(async () => ({ createWritable })),
    removeEntry: vi.fn(async () => undefined),
  };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => root },
  });
  const sink = await createOpfsSink(options);
  writable.close.mockClear();
  return { sink, createWritable };
}

describe("createOpfsSink open", () => {
  const stream = { write: vi.fn(), close: vi.fn() };
  const path = "Sharecut Recordings/a/0/p/0.wav";

  it("prefers the in-place sync writer", async () => {
    const writable = fakeWritable();
    try {
      const syncWriter = { open: vi.fn(async () => stream) };
      const { sink, createWritable } = await opfsSinkWith(writable, {
        syncWriter,
      });
      const probeCalls = createWritable.mock.calls.length;
      expect(await sink.open(path)).toBe(stream);
      expect(createWritable).toHaveBeenCalledTimes(probeCalls);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to createWritable when unavailable", async () => {
    const writable = fakeWritable();
    try {
      const syncWriter = {
        open: vi.fn(async () => {
          throw new SyncWriterUnavailableError();
        }),
      };
      const { sink, createWritable } = await opfsSinkWith(writable, {
        syncWriter,
      });
      await sink.open(path);
      expect(createWritable).toHaveBeenLastCalledWith();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rethrows a real writer error without falling back", async () => {
    const writable = fakeWritable();
    try {
      const syncWriter = {
        open: vi.fn(async () => {
          throw new Error("locked");
        }),
      };
      const { sink, createWritable } = await opfsSinkWith(writable, {
        syncWriter,
      });
      const probeCalls = createWritable.mock.calls.length;
      await expect(sink.open(path)).rejects.toThrow("locked");
      expect(createWritable).toHaveBeenCalledTimes(probeCalls);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses createWritable directly when the sync writer is disabled", async () => {
    const writable = fakeWritable();
    try {
      const { sink, createWritable } = await opfsSinkWith(writable, {
        syncWriter: null,
      });
      await sink.open(path);
      expect(createWritable).toHaveBeenLastCalledWith();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("createOpfsSink", () => {
  it("identifies an environment without OPFS before recording", async () => {
    vi.stubGlobal("navigator", { storage: {} });
    try {
      await expect(createOpfsSink()).rejects.toBeInstanceOf(
        OpfsUnavailableError,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("probes a writable OPFS file and removes it before returning a sink", async () => {
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const root = {
      getDirectoryHandle: vi.fn(async () => root),
      getFileHandle: vi.fn(async () => ({
        createWritable: async () => writable,
      })),
      removeEntry: vi.fn(async () => undefined),
    };
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => root },
    });
    try {
      await expect(createOpfsSink()).resolves.toBeDefined();
      expect(root.getDirectoryHandle).toHaveBeenCalledWith(
        "Sharecut Recordings",
        { create: true },
      );
      expect(root.getFileHandle).toHaveBeenCalledWith(
        expect.stringMatching(/^\.sharecut-opfs-probe-/),
        { create: true },
      );
      expect(writable.write).toHaveBeenCalledWith(new Uint8Array([0]));
      expect(writable.close).toHaveBeenCalledOnce();
      expect(root.removeEntry).toHaveBeenCalledWith(
        expect.stringMatching(/^\.sharecut-opfs-probe-/),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects when the OPFS probe cannot write", async () => {
    const failure = new Error("quota exceeded");
    const writable = {
      write: vi.fn(async () => Promise.reject(failure)),
      close: vi.fn(async () => undefined),
    };
    const root = {
      getDirectoryHandle: vi.fn(async () => root),
      getFileHandle: vi.fn(async () => ({
        createWritable: async () => writable,
      })),
      removeEntry: vi.fn(async () => undefined),
    };
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => root },
    });
    try {
      await expect(createOpfsSink()).rejects.toBe(failure);
      expect(writable.close).toHaveBeenCalledOnce();
      expect(root.removeEntry).toHaveBeenCalledWith(
        expect.stringMatching(/^\.sharecut-opfs-probe-/),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("createOpfsSink writes", () => {
  it("aborts instead of committing a failed whole-file write", async () => {
    const writable = fakeWritable(true);
    try {
      const { sink } = await opfsSinkWith(writable);
      await expect(
        sink.write("Sharecut Recordings/a/0/p/0.json", new Uint8Array([1])),
      ).rejects.toThrow("quota exceeded");
      expect(writable.abort).toHaveBeenCalledOnce();
      expect(writable.close).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("patches a header in place, keeping the existing PCM", async () => {
    const writable = fakeWritable();
    try {
      const { sink, createWritable } = await opfsSinkWith(writable);
      await sink.rewriteHeader?.(
        "Sharecut Recordings/a/0/p/0.wav",
        new Uint8Array(44),
        48,
      );
      expect(createWritable).toHaveBeenLastCalledWith({
        keepExistingData: true,
      });
      expect(writable.truncate).toHaveBeenCalledWith(48);
      expect(writable.seek).toHaveBeenCalledWith(0);
      expect(writable.close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("aborts a failed header patch", async () => {
    const writable = fakeWritable();
    writable.truncate.mockRejectedValueOnce(new Error("locked"));
    try {
      const { sink } = await opfsSinkWith(writable);
      await expect(
        sink.rewriteHeader?.(
          "Sharecut Recordings/a/0/p/0.wav",
          new Uint8Array(44),
          48,
        ),
      ).rejects.toThrow("locked");
      expect(writable.abort).toHaveBeenCalledOnce();
      expect(writable.close).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("keeper metadata", () => {
  const meta: KeeperMeta = {
    sessionId: "cool-room",
    takeIndex: 1,
    participantId: "p_g",
    segmentIndex: 2,
    sampleRate: 48_000,
    joinOffsetMs: 1500,
    samplesWritten: 10,
    complete: true,
  };
  const wavPath = keeperWavPath(meta);

  it("round-trips through the single writer", async () => {
    const sink = new MemorySink();
    await writeKeeperMeta(sink, wavPath, meta);
    expect(parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)))).toEqual(
      meta,
    );
  });

  it("round-trips valid clip regions and rejects malformed ones", () => {
    const withRegions = {
      ...meta,
      clippingRegions: [{ startMs: 1, endMs: 5 }],
    };
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    expect(parseKeeperMeta(enc(withRegions))).toEqual(withRegions);
    expect(
      parseKeeperMeta(enc({ ...meta, clippingRegions: [] }))?.clippingRegions,
    ).toEqual([]);
    expect(
      parseKeeperMeta(
        enc({ ...meta, clippingRegions: [{ startMs: 5, endMs: 1 }] }),
      ),
    ).toBeNull();
    expect(parseKeeperMeta(enc({ ...meta, clippingRegions: "x" }))).toBeNull();
    expect(parseKeeperMeta(enc(meta))?.clippingRegions).toBeUndefined();
  });

  it("keeps legacy metadata without a complete flag distinguishable", () => {
    const { complete: _omit, ...legacy } = meta;
    const bytes = new TextEncoder().encode(JSON.stringify(legacy));
    expect(parseKeeperMeta(bytes)).toEqual(legacy);
    expect(parseKeeperMeta(bytes)?.complete).toBeUndefined();
  });

  it.each([
    ["missing bytes", null],
    ["invalid JSON", "{"],
    ["non-object", "3"],
    ["string index", JSON.stringify({ ...meta, takeIndex: "1" })],
    ["negative samples", JSON.stringify({ ...meta, samplesWritten: -1 })],
    ["other rate", JSON.stringify({ ...meta, sampleRate: 44_100 })],
    ["negative offset", JSON.stringify({ ...meta, joinOffsetMs: -1 })],
    ["non-boolean complete", JSON.stringify({ ...meta, complete: "yes" })],
  ])("rejects %s", (_label, text) => {
    expect(
      parseKeeperMeta(text === null ? null : new TextEncoder().encode(text)),
    ).toBeNull();
  });

  it("matches metadata to its path through keeperWavPath", () => {
    expect(keeperMetaMatchesPath(meta, wavPath)).toBe(true);
    expect(keeperMetaMatchesPath({ ...meta, segmentIndex: 3 }, wavPath)).toBe(
      false,
    );
    expect(keeperMetaMatchesPath({ ...meta, sessionId: "../x" }, wavPath)).toBe(
      false,
    );
  });
});

describe("keeperSegmentPaths", () => {
  async function collect(sink: MemorySink, lastTake: number) {
    const out: string[] = [];
    for await (const ref of keeperSegmentPaths(sink, "s", "p", lastTake)) {
      out.push(`${ref.takeIndex}/${ref.segmentIndex}`);
    }
    return out;
  }

  it("walks every take and segment in order", async () => {
    const sink = new MemorySink();
    await sink.write(
      keeperWavPath({
        sessionId: "s",
        takeIndex: 0,
        participantId: "p",
        segmentIndex: 1,
      }),
      new Uint8Array(),
    );
    await sink.write(
      keeperWavPath({
        sessionId: "s",
        takeIndex: 1,
        participantId: "p",
        segmentIndex: 0,
      }),
      new Uint8Array(),
    );
    expect(await collect(sink, 1)).toEqual(["0/0", "0/1", "1/0"]);
  });

  it("caps enumeration against stray names and huge take indexes", async () => {
    const sink = new MemorySink();
    await sink.write(
      "Sharecut Recordings/s/0/p/999999999.json",
      new Uint8Array(),
    );
    const nextSegmentIndex = vi.spyOn(sink, "nextSegmentIndex");
    const refs = await collect(sink, 1e9);
    expect(refs).toHaveLength(MAX_KEEPER_SEGMENTS);
    expect(nextSegmentIndex).toHaveBeenCalledTimes(MAX_KEEPER_TAKES);
  });
});

describe("keeperWavPath", () => {
  it("keys files by session/take/participant/segment", () => {
    expect(
      keeperWavPath({
        sessionId: "cool-room",
        takeIndex: 1,
        participantId: "p_g",
        segmentIndex: 2,
      }),
    ).toBe("Sharecut Recordings/cool-room/1/p_g/2.wav");
  });

  it("rejects path traversal", () => {
    expect(() =>
      keeperWavPath({
        sessionId: "../etc",
        takeIndex: 0,
        participantId: "p_g",
        segmentIndex: 0,
      }),
    ).toThrow(/invalid keeper path/);
  });

  it("guards take and segment indexes", () => {
    expect(() =>
      keeperWavPath({
        sessionId: "cool-room",
        takeIndex: 0,
        participantId: "p_g",
        segmentIndex: Number.NaN,
      }),
    ).toThrow(/invalid keeper path/);
  });
});

describe("roomToneWavPath", () => {
  it("keys the bed under Sharecut Recordings/{session}/room-tone/", () => {
    expect(roomToneWavPath("cool-room", "p_g")).toBe(
      "Sharecut Recordings/cool-room/room-tone/p_g.wav",
    );
  });

  it("rejects path traversal", () => {
    expect(() => roomToneWavPath("../etc", "p_g")).toThrow(
      /invalid keeper path/,
    );
  });
});

describe("MemorySink", () => {
  it("round-trips bytes", async () => {
    const sink = new MemorySink();
    await sink.write("a/b.wav", new Uint8Array([1, 2, 3]));
    expect(await sink.read("a/b.wav")).toEqual(new Uint8Array([1, 2, 3]));
    await sink.remove("a/b.wav");
    expect(await sink.read("a/b.wav")).toBeNull();
    expect(await sink.read("missing")).toBeNull();
  });

  it("counts the next segment from existing wav names", async () => {
    const sink = new MemorySink();
    await sink.write(
      "Sharecut Recordings/cool-room/0/p_g/0.wav",
      new Uint8Array([1]),
    );
    await sink.write(
      "Sharecut Recordings/cool-room/0/p_g/2.wav",
      new Uint8Array([1]),
    );
    expect(await sink.nextSegmentIndex("cool-room", 0, "p_g")).toBe(3);
    expect(await sink.nextSegmentIndex("cool-room", 1, "p_g")).toBe(0);
  });

  it("patches a header in place and truncates to the kept length", async () => {
    const sink = new MemorySink();
    await sink.write("a.wav", new Uint8Array([9, 9, 1, 2, 3]));
    await sink.rewriteHeader("a.wav", new Uint8Array([7, 7]), 4);
    expect(await sink.read("a.wav")).toEqual(new Uint8Array([7, 7, 1, 2]));
    await expect(
      sink.rewriteHeader("missing.wav", new Uint8Array([1]), 1),
    ).rejects.toThrow("not found");
    expect(await (await sink.readBlob("a.wav"))?.arrayBuffer()).toEqual(
      new Uint8Array([7, 7, 1, 2]).buffer,
    );
    expect(await sink.readBlob("missing.wav")).toBeNull();
  });

  it("keeps pending or completion metadata in the segment index without its WAV", async () => {
    const sink = new MemorySink();
    await sink.write(
      "Sharecut Recordings/cool-room/0/p_g/3.json",
      new Uint8Array([1]),
    );
    expect(await sink.nextSegmentIndex("cool-room", 0, "p_g")).toBe(4);
  });

  it("prunes only expired metadata-free WAVs after capture settles and reserves their indexes", async () => {
    const sink = new MemorySink();
    const ids = { sessionId: "room", takeIndex: 0, participantId: "guest" };
    const old = keeperWavPath({ ...ids, segmentIndex: 0 });
    const recent = keeperWavPath({ ...ids, segmentIndex: 1 });
    const pending = keeperWavPath({ ...ids, segmentIndex: 2 });
    await sink.write(old, new Uint8Array([1]));
    await sink.write(recent, new Uint8Array([2]));
    await sink.write(pending, new Uint8Array([3]));
    await sink.write(keeperMetaPath(pending), keeperMetaBytes(ids, false));
    const now = Date.now();
    sink.modified.set(old, now - ORPHAN_KEEPER_RETENTION_MS - 1);
    sink.modified.set(pending, now - ORPHAN_KEEPER_RETENTION_MS - 1);
    expect(
      await pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => false, now),
    ).toBe(0);
    expect(
      await pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => true, now),
    ).toBe(1);
    expect(await sink.read(old)).toBeNull();
    expect(await sink.read(recent)).not.toBeNull();
    expect(await sink.read(pending)).not.toBeNull();
    expect(prunedKeeperMarker(await sink.read(keeperMetaPath(old)), old)).toBe(
      true,
    );
    expect(await missingKeeperWavState(sink, old)).toBe("pruned");
    expect(await sink.nextSegmentIndex("room", 0, "guest")).toBe(3);
    expect(
      await pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => true, now),
    ).toBe(0);
  });

  it("keeps an expired WAV visible if deletion fails after reserving its index", async () => {
    const sink = new MemorySink();
    const wav = keeperWavPath({
      sessionId: "room",
      takeIndex: 0,
      participantId: "guest",
      segmentIndex: 0,
    });
    await sink.write(wav, new Uint8Array([1]));
    sink.modified.set(wav, 0);
    vi.spyOn(sink, "remove").mockRejectedValueOnce(new Error("locked"));
    await expect(
      pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => true),
    ).rejects.toThrow("locked");
    expect(await sink.read(wav)).not.toBeNull();
    expect(await sink.nextSegmentIndex("room", 0, "guest")).toBe(1);
  });

  it("keeps an expired WAV while a recovery download holds deletion", async () => {
    const sink = new MemorySink();
    const wav = keeperWavPath({
      sessionId: "room",
      takeIndex: 0,
      participantId: "guest",
      segmentIndex: 0,
    });
    await sink.write(wav, new Uint8Array([1]));
    sink.modified.set(wav, 0);
    const release = await holdKeeperReclaim(sink);
    expect(
      await pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => true),
    ).toBe(0);
    expect(await sink.read(wav)).not.toBeNull();
    release();
    expect(
      await pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => true),
    ).toBe(1);
    expect(await sink.read(wav)).toBeNull();
  });

  it("keeps an expired OPFS WAV while another tab holds its download", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
    let shared = 0;
    const locks = {
      async request(
        _name: string,
        options: { mode?: string },
        callback: (lock: Lock | null) => unknown,
      ) {
        if (options.mode === "shared") {
          shared += 1;
          try {
            return await callback({} as Lock);
          } finally {
            shared -= 1;
          }
        }
        return callback(shared ? null : ({} as Lock));
      },
    };
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks,
    });
    try {
      const sink = Object.assign(new MemorySink(), {
        deletionLockName: "sharecut-test-keeper-deletion",
      });
      const otherTab = Object.create(sink) as MemorySink;
      const wav = keeperWavPath({
        sessionId: "room",
        takeIndex: 0,
        participantId: "guest",
        segmentIndex: 0,
      });
      await sink.write(wav, new Uint8Array([1]));
      sink.modified.set(wav, 0);
      const release = await holdKeeperReclaim(otherTab);
      expect(
        await pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => true),
      ).toBe(0);
      expect(await sink.read(wav)).not.toBeNull();
      release();
      await vi.waitFor(() => expect(shared).toBe(0));
      expect(
        await pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => true),
      ).toBe(1);
    } finally {
      if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
      else Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("retains OPFS WAVs when origin-wide locking is unavailable", async () => {
    const sink = Object.assign(new MemorySink(), {
      deletionLockName: "sharecut-test-keeper-deletion",
    });
    const wav = keeperWavPath({
      sessionId: "room",
      takeIndex: 0,
      participantId: "guest",
      segmentIndex: 0,
    });
    await sink.write(wav, new Uint8Array([1]));
    sink.modified.set(wav, 0);
    expect(
      await pruneExpiredKeeperWavs(sink, "room", "guest", 0, () => true),
    ).toBe(0);
    expect(await sink.read(wav)).not.toBeNull();
  });
});

describe("OPFS cleanup", () => {
  it("returns zero only for a missing segment directory and propagates scan failures", async () => {
    const entries = vi.fn<() => AsyncIterable<[string, { kind: string }]>>();
    const directory = {
      getDirectoryHandle: vi.fn<() => Promise<unknown>>(),
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async () => undefined,
          close: async () => undefined,
        }),
      }),
      removeEntry: async () => undefined,
      entries,
    };
    directory.getDirectoryHandle.mockResolvedValue(directory);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => directory },
    });
    try {
      const sink = await createOpfsSink();
      entries.mockImplementationOnce(async function* () {
        throw new DOMException("busy", "InvalidStateError");
      });
      await expect(sink.nextSegmentIndex("s", 0, "p")).rejects.toThrow("busy");
      entries.mockImplementationOnce(async function* () {
        yield ["0.wav", { kind: "file" }];
        throw new DOMException("scan disappeared", "NotFoundError");
      });
      await expect(sink.nextSegmentIndex("s", 0, "p")).rejects.toThrow(
        "scan disappeared",
      );
      directory.getDirectoryHandle.mockRejectedValueOnce(
        new DOMException("missing", "NotFoundError"),
      );
      await expect(sink.nextSegmentIndex("s", 0, "p")).resolves.toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null only for missing reads and propagates transient read errors", async () => {
    const getFile = vi.fn<() => Promise<Blob>>();
    const root = {
      getDirectoryHandle: async () => root,
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async () => undefined,
          close: async () => undefined,
        }),
        getFile,
      }),
      removeEntry: async () => undefined,
    };
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => root },
    });
    try {
      const sink = await createOpfsSink();
      getFile.mockRejectedValueOnce(
        new DOMException("busy", "InvalidStateError"),
      );
      await expect(sink.readBlob?.("a.wav")).rejects.toThrow("busy");
      getFile.mockRejectedValueOnce(
        new DOMException("missing", "NotFoundError"),
      );
      await expect(sink.readBlob?.("a.wav")).resolves.toBeNull();
      getFile.mockRejectedValueOnce(
        new DOMException("busy", "InvalidStateError"),
      );
      await expect(sink.read("a.wav")).rejects.toThrow("busy");
      getFile.mockResolvedValueOnce(new Blob([new Uint8Array([1])]));
      await expect(sink.read("a.wav")).resolves.toEqual(new Uint8Array([1]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores already-removed files but reports other deletion failures", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "storage");
    const removeEntry = vi.fn<() => Promise<void>>();
    const directory = {
      getDirectoryHandle: async () => directory,
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async () => undefined,
          close: async () => undefined,
        }),
      }),
      removeEntry,
    };
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { getDirectory: async () => directory },
    });
    try {
      const sink = await createOpfsSink();
      removeEntry.mockRejectedValueOnce(
        new DOMException("missing", "NotFoundError"),
      );
      await expect(sink.remove("a/b.wav")).resolves.toBeUndefined();
      removeEntry.mockRejectedValueOnce(
        new DOMException("denied", "NotAllowedError"),
      );
      await expect(sink.remove("a/b.wav")).rejects.toThrow("denied");
      await expect(sink.remove("a/../b.wav")).rejects.toThrow(
        /invalid keeper path part/,
      );
      await expect(sink.remove("a/..")).rejects.toThrow(
        /invalid keeper path part/,
      );
      await expect(sink.remove("")).rejects.toThrow(/invalid keeper path/);
    } finally {
      if (original) {
        Object.defineProperty(navigator, "storage", original);
      } else {
        Reflect.deleteProperty(navigator, "storage");
      }
    }
  });
});

describe("keeper completion markers", () => {
  const enc = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));

  it("treats legacy and complete:true metadata as complete, pending as not", () => {
    const ids = { sessionId: "r", takeIndex: 0, participantId: "p" };
    expect(keeperMetaComplete(null)).toBe(false);
    expect(keeperMetaComplete(keeperMetaBytes(ids, undefined))).toBe(true);
    expect(keeperMetaComplete(keeperMetaBytes(ids, true))).toBe(true);
    expect(keeperMetaComplete(keeperMetaBytes(ids, false))).toBe(false);
    // A pending record is written at segment open, so a torn or malformed
    // file may describe a WAV that never closed.
    expect(keeperMetaComplete(new Uint8Array([123]))).toBe(false);
    expect(keeperMetaComplete(enc({ complete: true }))).toBe(false);
  });

  it("classifies a missing WAV as reclaimed only with a completion marker", async () => {
    const sink = new MemorySink();
    const ids = { sessionId: "r", takeIndex: 0, participantId: "p" };
    const wav = keeperWavPath({ ...ids, segmentIndex: 0 });
    expect(await missingKeeperWavState(sink, wav)).toBe("missing");
    await sink.write(keeperMetaPath(wav), keeperMetaBytes(ids, false));
    expect(await missingKeeperWavState(sink, wav)).toBe("missing");
    await sink.write(keeperMetaPath(wav), new Uint8Array([123]));
    expect(await missingKeeperWavState(sink, wav)).toBe("missing");
    await sink.write(keeperMetaPath(wav), keeperMetaBytes(ids, true));
    expect(await missingKeeperWavState(sink, wav)).toBe("reclaimed");
  });

  it("removeBestEffort reports failures without throwing", async () => {
    const sink = new MemorySink();
    await sink.write("a.wav", new Uint8Array([1]));
    expect(await removeBestEffort(sink, "a.wav")).toBe(true);
    vi.spyOn(sink, "remove").mockRejectedValueOnce(new Error("locked"));
    expect(await removeBestEffort(sink, "a.wav")).toBe(false);
  });
});
