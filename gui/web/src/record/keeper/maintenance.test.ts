import { afterEach, describe, expect, it, vi } from "vitest";
import { keeperMetaBytes } from "../../test/keepers";
import {
  holdKeeperReclaim,
  openGuardedKeeperStream,
  removeKeeperUnlessHeld,
  withKeeperDeletion,
} from "./deletionGuard";
import {
  KEEPER_CLEANUP_ENTRY_BUDGET,
  KEEPER_CLEANUP_INTERVAL_MS,
  KEEPER_CLEANUP_RETRY_MS,
  KEEPER_CLEANUP_STATE_PATH,
  pruneExpiredKeeperWavs,
} from "./maintenance";
import {
  type ByteStream,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
  ORPHAN_KEEPER_RETENTION_MS,
  prunedKeeperMarker,
} from "./store";

const NOW = ORPHAN_KEEPER_RETENTION_MS * 2;
const ready = () => true;

async function seed(sink: MemorySink, room: string, index = 0, age = 0) {
  const path = keeperWavPath({
    sessionId: room,
    takeIndex: 0,
    participantId: "guest",
    segmentIndex: index,
  });
  await sink.write(path, new Uint8Array([1]));
  sink.modified.set(path, age);
  return path;
}

function restart(sink: MemorySink): MemorySink {
  // A fresh tab's ByteSink has only persistent OPFS state, no live iterators.
  return Object.assign(new MemorySink(), {
    files: sink.files,
    modified: sink.modified,
  });
}

function locksForTest() {
  const active = new Map<string, { shared: number; exclusive: boolean }>();
  return {
    async request<T>(
      name: string,
      options: { mode?: string; ifAvailable?: boolean },
      callback: (lock: Lock | null) => Promise<T> | T,
    ) {
      const state = active.get(name) ?? { shared: 0, exclusive: false };
      active.set(name, state);
      const shared = options.mode === "shared";
      if (state.exclusive || (!shared && state.shared)) return callback(null);
      if (shared) state.shared += 1;
      else state.exclusive = true;
      try {
        return await callback({} as Lock);
      } finally {
        if (shared) state.shared -= 1;
        else state.exclusive = false;
      }
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("origin-wide keeper maintenance", () => {
  it("cleans prior room IDs and preserves every pending/finalized or unreadable metadata file", async () => {
    const sink = new MemorySink();
    const old = await seed(sink, "prior-room");
    const current = await seed(sink, "current-room");
    const largeIndex = await seed(sink, "prior-room", 2000);
    const pending = await seed(sink, "prior-room", 1);
    const complete = await seed(sink, "current-room", 1);
    const malformed = await seed(sink, "current-room", 2);
    const empty = await seed(sink, "current-room", 3);
    const recent = await seed(sink, "current-room", 4, NOW);
    const ids = {
      sessionId: "prior-room",
      takeIndex: 0,
      participantId: "guest",
    };
    await sink.write(keeperMetaPath(pending), keeperMetaBytes(ids, false));
    await sink.write(
      keeperMetaPath(complete),
      keeperMetaBytes({ ...ids, sessionId: "current-room" }, true),
    );
    await sink.write(keeperMetaPath(malformed), new Uint8Array([255]));
    await sink.write(keeperMetaPath(empty), new Uint8Array());
    const result = await pruneExpiredKeeperWavs(sink, ready, NOW);
    expect(result).toMatchObject({ pruned: 3, complete: true });
    for (const path of [old, current, largeIndex]) {
      expect(await sink.read(path)).toBeNull();
      expect(
        prunedKeeperMarker(await sink.read(keeperMetaPath(path)), path),
      ).toBe(true);
    }
    for (const path of [pending, complete, malformed, empty, recent])
      expect(await sink.read(path)).not.toBeNull();
  });

  it("caps each slice, advances through a large first room and resumes after multiple restarts", async () => {
    let sink = new MemorySink();
    for (let index = 0; index < 200; index += 1)
      await seed(sink, "large-room", index, NOW);
    const tail = await seed(sink, "large-room", 200);
    const other = await seed(sink, "later-room");
    let clock = NOW;
    let complete = false;
    let yielded = 0;
    const instrument = (current: MemorySink) => {
      const entries = current.entries.bind(current);
      current.entries = async function* (path) {
        for await (const entry of entries(path)) {
          yielded += 1;
          yield entry;
        }
      };
    };
    instrument(sink);
    for (let pass = 0; pass < 30; pass += 1) {
      // Restarts replay directory prefixes in bounded slices before new work.
      if (pass === 1 || pass === 5) {
        sink = restart(sink);
        instrument(sink);
      }
      yielded = 0;
      const result = await pruneExpiredKeeperWavs(sink, ready, clock);
      expect(result.visited).toBeLessThanOrEqual(KEEPER_CLEANUP_ENTRY_BUDGET);
      expect(yielded).toBeLessThanOrEqual(KEEPER_CLEANUP_ENTRY_BUDGET);
      const bytes = await sink.read(KEEPER_CLEANUP_STATE_PATH);
      expect(bytes?.length).toBeLessThan(8_000);
      if (result.complete) {
        complete = true;
        break;
      }
      clock = result.nextRunAt;
    }
    expect(complete).toBe(true);
    expect(await sink.read(tail)).toBeNull();
    expect(await sink.read(other)).toBeNull();
  });

  it("wraps after a full pass and revisits an early room addition", async () => {
    let sink = new MemorySink();
    await seed(sink, "first-room", 0, NOW);
    await seed(sink, "last-room", 0, NOW);
    const first = await pruneExpiredKeeperWavs(sink, ready, NOW);
    expect(first.complete).toBe(true);
    const added = await seed(sink, "first-room", 1);
    sink = restart(sink);
    expect((await pruneExpiredKeeperWavs(sink, ready, NOW + 1)).pruned).toBe(0);
    expect(
      (
        await pruneExpiredKeeperWavs(
          sink,
          ready,
          NOW + KEEPER_CLEANUP_INTERVAL_MS,
        )
      ).pruned,
    ).toBe(1);
    expect(await sink.read(added)).toBeNull();
  });

  it("keeps advancing after more failures than retry slots and revisits additions while failures persist", async () => {
    const sink = new MemorySink();
    for (let room = 0; room < 20; room += 1) await seed(sink, `failed-${room}`);
    const later = await seed(sink, "healthy-later-room");
    const remove = sink.remove.bind(sink);
    vi.spyOn(sink, "remove").mockImplementation(async (path) => {
      if (path.includes("/failed-")) throw new Error("permanently locked");
      return remove(path);
    });
    let clock = NOW;
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await pruneExpiredKeeperWavs(sink, ready, clock);
      expect(result.visited).toBeLessThanOrEqual(KEEPER_CLEANUP_ENTRY_BUDGET);
      const checkpoint = JSON.parse(
        new TextDecoder().decode(
          (await sink.read(KEEPER_CLEANUP_STATE_PATH)) ?? new Uint8Array(),
        ),
      );
      expect(checkpoint.retries.length).toBeLessThanOrEqual(16);
      if (!(await sink.read(later))) break;
      clock = result.nextRunAt;
    }
    expect(await sink.read(later)).toBeNull();
    const added = await seed(sink, "new-room-after-failed-pass");
    clock = NOW + KEEPER_CLEANUP_INTERVAL_MS;
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await pruneExpiredKeeperWavs(sink, ready, clock);
      expect(result.complete).toBe(false);
      if (!(await sink.read(added))) break;
      clock = result.nextRunAt;
    }
    expect(await sink.read(added)).toBeNull();
  });

  it("keeps a near-end scan failure incomplete, backs off, and resumes after restart", async () => {
    let sink = new MemorySink();
    const first = await seed(sink, "first-room");
    const tail = await seed(sink, "last-room");
    const entries = sink.entries.bind(sink);
    let failed = false;
    sink.entries = async function* (path) {
      for await (const entry of entries(path)) {
        if (!failed && path.endsWith("last-room/0/guest")) {
          failed = true;
          throw new Error("OPFS temporarily locked");
        }
        yield entry;
      }
    };
    const pass = await pruneExpiredKeeperWavs(sink, ready, NOW);
    expect(pass).toMatchObject({ pruned: 1, complete: false });
    expect(await sink.read(first)).toBeNull();
    expect(await sink.read(tail)).not.toBeNull();
    sink = restart(sink);
    const early = await pruneExpiredKeeperWavs(sink, ready, NOW + 1);
    expect(early).toMatchObject({ pruned: 0, complete: false });
    expect(early.nextRunAt).toBe(NOW + KEEPER_CLEANUP_RETRY_MS);
    expect(
      await pruneExpiredKeeperWavs(sink, ready, early.nextRunAt),
    ).toMatchObject({ pruned: 1, complete: true });
  });

  it("keeps the persisted DFS stack bounded while recovering nine failed rooms", async () => {
    const sink = new MemorySink();
    const rooms = Array.from(
      { length: 9 },
      (_, index) => `retry-room-${index}`,
    );
    const paths = await Promise.all(rooms.map((room) => seed(sink, room)));
    const entries = sink.entries.bind(sink);
    const failed = new Set<string>();
    sink.entries = async function* (path) {
      if (rooms.some((room) => path === `Sharecut Recordings/${room}`)) {
        if (!failed.has(path)) {
          failed.add(path);
          throw new Error("temporary directory failure");
        }
      }
      yield* entries(path);
    };

    let clock = NOW;
    let complete = false;
    for (let pass = 0; pass < 80; pass += 1) {
      const result = await pruneExpiredKeeperWavs(sink, ready, clock);
      const checkpoint = JSON.parse(
        new TextDecoder().decode(
          (await sink.read(KEEPER_CLEANUP_STATE_PATH)) ?? new Uint8Array(),
        ),
      );
      expect(checkpoint.frames.length).toBeLessThanOrEqual(8);
      expect(checkpoint.retries.length).toBeLessThanOrEqual(16);
      if (result.complete) {
        complete = true;
        break;
      }
      clock = result.nextRunAt;
    }
    expect(complete).toBe(true);
    for (const path of paths) expect(await sink.read(path)).toBeNull();
  });

  it.each(["read", "modifiedAt", "remove"] as const)(
    "retries a transient %s failure without blocking later rooms",
    async (operation) => {
      const sink = new MemorySink();
      const failing = await seed(sink, "failed-room");
      const later = await seed(sink, "later-room");
      let failures = 0;
      const fail = (path: string) => {
        if (
          (path === failing || path === keeperMetaPath(failing)) &&
          failures++ < 2
        )
          throw new Error("locked");
      };
      if (operation === "read") {
        const original = sink.read.bind(sink);
        vi.spyOn(sink, "read").mockImplementation(async (path) => {
          fail(path);
          return original(path);
        });
      } else if (operation === "modifiedAt") {
        const original = sink.modifiedAt.bind(sink);
        vi.spyOn(sink, "modifiedAt").mockImplementation(async (path) => {
          fail(path);
          return original(path);
        });
      } else {
        const original = sink.remove.bind(sink);
        vi.spyOn(sink, "remove").mockImplementation(async (path) => {
          fail(path);
          return original(path);
        });
      }
      const first = await pruneExpiredKeeperWavs(sink, ready, NOW);
      expect(first).toMatchObject({ pruned: 1, complete: false });
      expect(await sink.read(later)).toBeNull();
      const second = await pruneExpiredKeeperWavs(sink, ready, first.nextRunAt);
      expect(second.complete).toBe(false);
      expect(second.nextRunAt).toBe(NOW + KEEPER_CLEANUP_RETRY_MS * 3);
      const final = await pruneExpiredKeeperWavs(sink, ready, second.nextRunAt);
      expect(final).toMatchObject({ pruned: 1, complete: true });
      expect(await sink.read(failing)).toBeNull();
    },
  );

  it("never marks held capture/download candidates and retries once both release", async () => {
    vi.stubGlobal("navigator", { locks: locksForTest() });
    const sink = Object.assign(new MemorySink(), {
      deletionLockName: "test-delete",
    });
    const captureTab = Object.assign(restart(sink), {
      deletionLockName: "test-delete",
    });
    const downloadTab = Object.assign(restart(sink), {
      deletionLockName: "test-delete",
    });
    const path = await seed(sink, "old-room");
    const stream = await captureTab.open(path);
    const releaseDownload = await holdKeeperReclaim(downloadTab);
    const pass = await pruneExpiredKeeperWavs(sink, ready, NOW);
    expect(pass.pruned).toBe(0);
    expect(await removeKeeperUnlessHeld(sink, path)).toBe("held");
    expect(await sink.read(keeperMetaPath(path))).toBeNull();
    await stream.close();
    await Promise.resolve();
    expect(
      (await pruneExpiredKeeperWavs(sink, ready, pass.nextRunAt)).pruned,
    ).toBe(0);
    expect(await sink.read(keeperMetaPath(path))).toBeNull();
    releaseDownload();
    await Promise.resolve();
    sink.modified.set(path, 0);
    const retry = await pruneExpiredKeeperWavs(
      sink,
      ready,
      NOW + KEEPER_CLEANUP_RETRY_MS * 3,
    );
    expect(retry.pruned).toBe(1);
  });

  it("does not mark or delete without Web Locks or after lock rejection", async () => {
    vi.stubGlobal("navigator", {});
    const sink = Object.assign(new MemorySink(), {
      deletionLockName: "test-delete",
    });
    const path = await seed(sink, "old-room");
    expect((await pruneExpiredKeeperWavs(sink, ready, NOW)).visited).toBe(0);
    expect(await sink.read(keeperMetaPath(path))).toBeNull();
    vi.stubGlobal("navigator", {
      locks: { request: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await expect(pruneExpiredKeeperWavs(sink, ready, NOW)).rejects.toThrow(
      "denied",
    );
    expect(await sink.read(path)).not.toBeNull();
    expect(await sink.read(keeperMetaPath(path))).toBeNull();
  });

  it("checks fresh metadata inside the exclusive deletion lock", async () => {
    const sink = Object.assign(new MemorySink(), {
      deletionLockName: "test-delete",
    });
    const path = await seed(sink, "old-room");
    const pending = keeperMetaBytes(
      { sessionId: "old-room", takeIndex: 0, participantId: "guest" },
      false,
    );
    vi.stubGlobal("navigator", {
      locks: {
        async request<T>(
          name: string,
          _options: unknown,
          callback: (lock: Lock | null) => Promise<T> | T,
        ) {
          if (name === "test-delete")
            await sink.write(keeperMetaPath(path), pending);
          return callback({} as Lock);
        },
      },
    });
    expect(await pruneExpiredKeeperWavs(sink, ready, NOW)).toMatchObject({
      pruned: 0,
      complete: true,
    });
    expect(await sink.read(path)).not.toBeNull();
    expect(await sink.read(keeperMetaPath(path))).toEqual(pending);
  });

  it("keeps pending metadata through post-close hashing and finalization", async () => {
    const sink = new MemorySink();
    const path = await seed(sink, "captured-room");
    const stream = await sink.open(path);
    // KeeperSession publishes complete:false before closing. Hashing and the
    // final complete metadata happen afterward, with this record protecting PCM.
    await sink.write(
      keeperMetaPath(path),
      keeperMetaBytes(
        { sessionId: "captured-room", takeIndex: 0, participantId: "guest" },
        false,
      ),
    );
    await stream.close();
    sink.modified.set(path, 0);
    expect(await pruneExpiredKeeperWavs(sink, ready, NOW)).toMatchObject({
      pruned: 0,
      complete: true,
    });
    expect(await sink.read(path)).not.toBeNull();
  });
});

describe("capture stream deletion lease", () => {
  it("holds before underlying open and through asynchronous abort cleanup", async () => {
    const sink = new MemorySink();
    let finishAbort: () => void = () => undefined;
    const aborting = new Promise<void>((resolve) => {
      finishAbort = resolve;
    });
    const stream: ByteStream = {
      write: async () => undefined,
      close: async () => undefined,
      abort: () => aborting,
    };
    const wrapped = await openGuardedKeeperStream(sink, async () => {
      expect((await withKeeperDeletion(sink, async () => true)).held).toBe(
        true,
      );
      return stream;
    });
    const cleanup = wrapped.abort?.();
    expect((await withKeeperDeletion(sink, async () => true)).held).toBe(true);
    finishAbort();
    await cleanup;
    await expect(wrapped.write(new Uint8Array([1]))).rejects.toThrow("closed");
    await vi.waitFor(async () =>
      expect((await withKeeperDeletion(sink, async () => true)).held).toBe(
        false,
      ),
    );
  });

  it("protects an open that settles after its caller's deadline until late close finishes", async () => {
    const sink = new MemorySink();
    let finishOpen: (stream: ByteStream) => void = () => undefined;
    const rawOpen = new Promise<ByteStream>((resolve) => {
      finishOpen = resolve;
    });
    const opened = openGuardedKeeperStream(sink, () => rawOpen);
    await Promise.resolve();
    expect((await withKeeperDeletion(sink, async () => true)).held).toBe(true);
    finishOpen({ write: async () => undefined, close: async () => undefined });
    const stream = await opened;
    expect((await withKeeperDeletion(sink, async () => true)).held).toBe(true);
    await stream.close();
    expect((await withKeeperDeletion(sink, async () => true)).held).toBe(false);
  });

  it("releases after failed open/write/close once writer teardown finishes", async () => {
    const sink = new MemorySink();
    await expect(
      openGuardedKeeperStream(sink, async () => {
        throw new Error("open failed");
      }),
    ).rejects.toThrow("open failed");
    expect((await withKeeperDeletion(sink, async () => true)).held).toBe(false);
    for (const failing of ["write", "close"] as const) {
      const abort = vi.fn();
      const stream: ByteStream = {
        write: async () => undefined,
        close: async () => undefined,
        abort,
      };
      stream[failing] = async () => {
        throw new Error("stream failed");
      };
      const wrapped = await openGuardedKeeperStream(sink, async () => stream);
      await expect(
        failing === "write" ? wrapped.write(new Uint8Array()) : wrapped.close(),
      ).rejects.toThrow("stream failed");
      expect(abort).toHaveBeenCalled();
      expect((await withKeeperDeletion(sink, async () => true)).held).toBe(
        false,
      );
    }
  });
});
