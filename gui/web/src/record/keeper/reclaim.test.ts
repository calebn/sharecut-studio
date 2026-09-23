import { describe, expect, it, vi } from "vitest";
import { keeperMetaBytes } from "../../test/keepers";
import {
  canReclaimKeeperSegment,
  createKeeperReclaimTracker,
  holdKeeperReclaim,
  KEEPER_RECLAIM_MAX_FAILURES,
  keeperReclaimHeld,
  keeperReclaimStuck,
  reclaimKeeperWav,
} from "./reclaim";
import { keeperMetaPath, MemorySink } from "./store";

const WAV = "Sharecut Recordings/room1/0/p_a/0.wav";
const landed = { file_ack: true, landed: true };

const IDS = { sessionId: "room1", takeIndex: 0, participantId: "p_a" };

async function seed(sink: MemorySink, meta: Uint8Array | null = null) {
  await sink.write(WAV, new Uint8Array([1, 2, 3]));
  await sink.write(keeperMetaPath(WAV), meta ?? keeperMetaBytes(IDS));
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
  it("removes a completed WAV once and keeps its metadata marker", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("reclaimed");
    expect(await sink.read(WAV)).toBeNull();
    expect(await sink.read(keeperMetaPath(WAV))).not.toBeNull();
    const remove = vi.spyOn(sink, "remove");
    expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("skipped");
    expect(remove).not.toHaveBeenCalled();
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
    expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("skipped");
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
      expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("failed");
      expect(keeperReclaimStuck(tracker)).toBe(false);
    }
    expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("failed");
    expect(keeperReclaimStuck(tracker)).toBe(true);
    remove.mockRestore();
    expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("reclaimed");
    expect(keeperReclaimStuck(tracker)).toBe(false);
  });

  it("does not delete while a recovery hold is active", async () => {
    const sink = new MemorySink();
    await seed(sink);
    const tracker = createKeeperReclaimTracker();
    const release = await holdKeeperReclaim(sink);
    expect(keeperReclaimHeld(sink)).toBe(true);
    expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("held");
    expect(await sink.read(WAV)).not.toBeNull();
    release();
    release();
    expect(keeperReclaimHeld(sink)).toBe(false);
    expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("reclaimed");
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
    expect(await reclaimKeeperWav(sink, WAV, tracker)).toBe("held");
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
    const reclaiming = reclaimKeeperWav(sink, WAV, tracker);
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
