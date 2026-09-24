import { describe, expect, it, vi } from "vitest";
import { keeperMetaBytes } from "../../test/keepers";
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
  parseKeeperMeta,
  removeBestEffort,
  roomToneWavPath,
  writeKeeperMeta,
} from "./store";

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

async function opfsSinkWith(writable: FakeWritable) {
  const createWritable = vi.fn(async () => writable);
  const root = {
    getDirectoryHandle: vi.fn(async () => root),
    getFileHandle: vi.fn(async () => ({ createWritable })),
    removeEntry: vi.fn(async () => undefined),
  };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => root },
  });
  const sink = await createOpfsSink();
  writable.close.mockClear();
  return { sink, createWritable };
}

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
});

describe("OPFS cleanup", () => {
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
