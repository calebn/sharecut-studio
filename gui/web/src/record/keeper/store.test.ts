import { describe, expect, it, vi } from "vitest";
import {
  createOpfsSink,
  keeperWavPath,
  MemorySink,
  OpfsUnavailableError,
  roomToneWavPath,
} from "./store";

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
});
