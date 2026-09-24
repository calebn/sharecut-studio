import { describe, expect, it, vi } from "vitest";
import { keeperMetaBytes } from "../../test/keepers";
import { sha256Hex } from "./fingerprint";
import {
  canReclaimKeeperSegment,
  createKeeperReclaimTracker,
  holdKeeperReclaim,
  KEEPER_RECLAIM_MAX_FAILURES,
  KEEPER_RECLAIM_RETRY_MS,
  keeperReclaimHeld,
  keeperReclaimStuck,
  reclaimKeeperWav,
} from "./reclaim";
import { keeperMetaPath, MemorySink } from "./store";

const WAV = "Sharecut Recordings/room1/0/p_a/0.wav";
const landed = { file_ack: true, landed: true };
let remote: typeof landed & { file_sha256?: string; byte_length?: number } =
  landed;

const IDS = { sessionId: "room1", takeIndex: 0, participantId: "p_a" };

async function seed(sink: MemorySink, meta: Uint8Array | null = null) {
  const wav = new Uint8Array([1, 2, 3]);
  await sink.write(WAV, wav);
  const hash = await sha256Hex(wav);
  remote = { ...landed, file_sha256: hash, byte_length: wav.byteLength };
  await sink.write(
    keeperMetaPath(WAV),
    meta ??
      keeperMetaBytes(IDS, true, {
        fileSha256: hash,
        byteLength: wav.byteLength,
      }),
  );
}

describe("canReclaimKeeperSegment", () => {
  it.each([
    [undefined, 0, 1, true, false],
    [{ file_ack: false, landed: true }, 0, 1, true, false],
    [{ file_ack: true, landed: false }, 0, 1, true, false],
    [{ ...landed, land_failed: true }, 0, 1, true, false],
    [landed, 0, 1, false, true],
    [landed, 1, 1, false, false],
    [landed, 1, 1, true, true],
  ])(
    "row %j take %i/%i settled=%s -> %s",
    (remoteSeg, take, takeIndex, settled, expected) => {
      expect(
        canReclaimKeeperSegment({ remoteSeg, take, takeIndex, settled }),
      ).toBe(expected);
    },
  );
});

describe("reclaimKeeperWav", () => {
  it.each([
    ["host SHA differs", { file_sha256: "0".repeat(64) }],
    ["host length differs", { byte_length: 4 }],
    ["host fingerprint is absent", { file_sha256: undefined }],
  ])("retains the WAV when %s", async (_name, change) => {
    const sink = new MemorySink();
    await seed(sink);
    expect(
      await reclaimKeeperWav(sink, WAV, createKeeperReclaimTracker(), {
        ...remote,
        ...change,
      }),
    ).toBe("mismatch");
    expect(await sink.read(WAV)).not.toBeNull();
  });

  it("retains a changed WAV and legacy metadata", async () => {
    const sink = new MemorySink();
    await seed(sink);
    await sink.write(WAV, new Uint8Array([1, 2, 4]));
    expect(
      await reclaimKeeperWav(sink, WAV, createKeeperReclaimTracker(), remote),
    ).toBe("mismatch");
    await sink.write(keeperMetaPath(WAV), keeperMetaBytes(IDS, undefined));
    expect(
      await reclaimKeeperWav(sink, WAV, createKeeperReclaimTracker(), remote),
    ).toBe("mismatch");
    expect(await sink.read(WAV)).not.toBeNull();
  });

  it("removes a completed WAV once and keeps its metadata marker", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe(
      "reclaimed",
    );
    expect(await sink.read(WAV)).toBeNull();
    expect(await sink.read(keeperMetaPath(WAV))).not.toBeNull();
    const remove = vi.spyOn(sink, "remove");
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("skipped");
    expect(remove).not.toHaveBeenCalled();
  });

  it("recognizes an already reclaimed WAV with a new tracker", async () => {
    const sink = new MemorySink();
    await seed(sink);
    await sink.remove(WAV);
    expect(
      await reclaimKeeperWav(sink, WAV, createKeeperReclaimTracker(), remote),
    ).toBe("skipped");
  });

  it("does not reread retained legacy WAV bytes on repeated polls", async () => {
    const sink = new MemorySink();
    await seed(sink, keeperMetaBytes(IDS, undefined));
    const read = vi.spyOn(sink, "read");
    const tracker = createKeeperReclaimTracker();
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("mismatch");
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("mismatch");
    expect(read).not.toHaveBeenCalledWith(WAV);
  });

  it("caches a corrupt WAV only while its file version and status stay unchanged", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    const versioned = (bytes: number[], modified: number) => {
      const blob = new Blob([new Uint8Array(bytes)]);
      Object.defineProperty(blob, "lastModified", { value: modified });
      return blob;
    };
    let blob = versioned([1, 2, 4], 100);
    sink.readBlob = async () => blob;
    const firstSlice = vi.spyOn(blob, "slice");
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("mismatch");
    expect(firstSlice).toHaveBeenCalled();
    firstSlice.mockClear();
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("mismatch");
    expect(firstSlice).not.toHaveBeenCalled();
    blob = versioned([1, 2, 3], 101);
    const changedSlice = vi.spyOn(blob, "slice");
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe(
      "reclaimed",
    );
    expect(changedSlice).toHaveBeenCalled();
  });

  it("pauses repeated failed deletes, then rehashes before retry", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    Object.defineProperty(blob, "lastModified", { value: 100 });
    sink.readBlob = async () => blob;
    const slice = vi.spyOn(blob, "slice");
    const remove = vi
      .spyOn(sink, "remove")
      .mockRejectedValue(new Error("locked"));
    for (let i = 0; i < KEEPER_RECLAIM_MAX_FAILURES; i += 1) {
      expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("failed");
    }
    slice.mockClear();
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("failed");
    expect(slice).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(KEEPER_RECLAIM_MAX_FAILURES);
    remove.mockRestore();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + KEEPER_RECLAIM_RETRY_MS + 1);
    try {
      expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe(
        "reclaimed",
      );
      expect(slice).toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ["absent", null],
    ["pending (complete:false)", keeperMetaBytes(IDS, false)],
    ["unreadable (a torn pending record)", new Uint8Array([123])],
  ])("keeps the WAV when metadata is %s", async (_label, meta) => {
    const sink = new MemorySink();
    await sink.write(WAV, new Uint8Array([1, 2, 3]));
    if (meta) await sink.write(keeperMetaPath(WAV), meta);
    const tracker = createKeeperReclaimTracker();
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("skipped");
    expect(await sink.read(WAV)).not.toBeNull();
  });

  it("counts consecutive failures, reports stuck, and resets on success", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    const remove = vi
      .spyOn(sink, "remove")
      .mockRejectedValue(
        new DOMException("locked", "NoModificationAllowedError"),
      );
    for (let i = 1; i < KEEPER_RECLAIM_MAX_FAILURES; i += 1) {
      expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("failed");
      expect(keeperReclaimStuck(tracker)).toBe(false);
    }
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("failed");
    expect(keeperReclaimStuck(tracker)).toBe(true);
    remove.mockRestore();
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe(
      "reclaimed",
    );
    expect(keeperReclaimStuck(tracker)).toBe(false);
  });

  it("does not delete while a recovery hold is active", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    const release = await holdKeeperReclaim(sink);
    expect(keeperReclaimHeld(sink)).toBe(true);
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("held");
    expect(await sink.read(WAV)).not.toBeNull();
    release();
    release();
    expect(keeperReclaimHeld(sink)).toBe(false);
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe(
      "reclaimed",
    );
  });

  it("blocks a delete when the hold lands during the metadata read", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    const read = sink.read.bind(sink);
    let release: (() => void) | undefined;
    vi.spyOn(sink, "read").mockImplementation(async (path) => {
      release = await holdKeeperReclaim(sink);
      return read(path);
    });
    expect(await reclaimKeeperWav(sink, WAV, tracker, remote)).toBe("held");
    release?.();
  });

  it("nests holds and makes a new hold wait for an in-flight delete", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    let finish: (() => void) | undefined;
    const remove = sink.remove.bind(sink);
    vi.spyOn(sink, "remove").mockImplementation(
      (path) =>
        new Promise<void>((resolve) => {
          finish = () => void remove(path).then(resolve);
        }),
    );
    const reclaiming = reclaimKeeperWav(sink, WAV, tracker, remote);
    await vi.waitFor(() => expect(finish).toBeDefined());
    let held = false;
    const holding = holdKeeperReclaim(sink).then((release) => {
      held = true;
      return release;
    });
    await Promise.resolve();
    expect(held).toBe(false);
    finish?.();
    expect(await reclaiming).toBe("reclaimed");
    const outer = await holding;
    const inner = await holdKeeperReclaim(sink);
    outer();
    expect(keeperReclaimHeld(sink)).toBe(true);
    inner();
    expect(keeperReclaimHeld(sink)).toBe(false);
  });
});
