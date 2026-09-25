import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaveformFetchError } from "../api";
import type { WaveformStatus } from "./types";

const loads = vi.hoisted(
  () =>
    [] as {
      projectPath: string;
      kind: string;
      signal: AbortSignal;
      resolve: (s: WaveformStatus) => void;
      reject: (e: unknown) => void;
    }[],
);

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadWaveformStatus: (
    projectPath: string,
    kind: string,
    signal: AbortSignal,
  ) =>
    new Promise<WaveformStatus>((resolve, reject) => {
      loads.push({ projectPath, kind, signal, resolve, reject });
    }),
}));

const {
  getWaveformStatusEntry,
  laneWaveformStatus,
  useLaneWaveformStatus,
  noteWaveformTileMissing,
  onWaveformReady,
  refreshWaveformStatus,
  resetWaveformStatus,
  retainWaveformStatus,
  subscribeWaveformStatus,
  useWaveformStatus,
} = await import("./statusStore");

const P = "/tmp/p.json";

const ready = (key: string) => ({
  status: "ready" as const,
  key,
  sample_rate: 48000,
  channels: 1,
  total_frames: 48000,
  base_spp: 64,
  level_factor: 4,
  bins_per_tile: 4096,
  levels: [{ spp: 64, bins: 750 }],
});

function status(media: WaveformStatus["media"]): WaveformStatus {
  return { format_version: 1, media };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("statusStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loads.length = 0;
  });

  afterEach(() => {
    resetWaveformStatus();
    vi.useRealTimers();
  });

  it("stops polling on a permanent error until asked again", async () => {
    const off = subscribeWaveformStatus(P, "raw", () => {});
    loads.shift()!.reject(new WaveformFetchError(403, null));
    await flush();
    vi.advanceTimersByTime(10_000);
    expect(loads).toHaveLength(0);
    refreshWaveformStatus(P, "raw");
    expect(loads).toHaveLength(1);
    loads.shift()!.reject(new WaveformFetchError(503, null));
    await flush();
    vi.advanceTimersByTime(1000);
    expect(loads).toHaveLength(1);
    off();
  });

  it("drops a refresh asked mid-flight when that poll fails permanently", async () => {
    const off = subscribeWaveformStatus(P, "raw", () => {});
    refreshWaveformStatus(P, "raw");
    expect(loads).toHaveLength(1);
    loads.shift()!.reject(new WaveformFetchError(403, null));
    await flush();
    vi.advanceTimersByTime(10_000);
    expect(loads).toHaveLength(0);
    refreshWaveformStatus(P, "raw");
    expect(loads).toHaveLength(1);
    loads.shift()!.resolve(status({ "track:a": ready("a".repeat(20)) }));
    await flush();
    expect(loads).toHaveLength(0);
    off();
  });

  it("polls with 1, 2, 4 s back-off while generating and stops when ready", async () => {
    const off = subscribeWaveformStatus(P, "raw", () => {});
    expect(loads).toHaveLength(1);
    for (const wait of [1000, 2000, 4000, 4000]) {
      loads.shift()!.resolve(status({ "track:a": { status: "generating" } }));
      await flush();
      vi.advanceTimersByTime(wait - 1);
      expect(loads).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(loads).toHaveLength(1);
    }
    loads.shift()!.resolve(status({ "track:a": ready("a".repeat(20)) }));
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(loads).toHaveLength(0);
    off();
  });

  it("keeps an unchanged entry's identity and notifies only on change", async () => {
    const listener = vi.fn();
    subscribeWaveformStatus(P, "raw", listener);
    loads.shift()!.resolve(
      status({
        "track:a": ready("a".repeat(20)),
        "track:b": { status: "generating" },
      }),
    );
    await flush();
    const a = getWaveformStatusEntry(P, "raw", "track:a");
    expect(listener).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    loads.shift()!.resolve(
      status({
        "track:a": ready("a".repeat(20)),
        "track:b": { status: "generating" },
      }),
    );
    await flush();
    expect(listener).toHaveBeenCalledOnce();
    expect(getWaveformStatusEntry(P, "raw", "track:a")).toBe(a);
    expect(getWaveformStatusEntry(P, "raw", "track:zz")).toBeNull();
    expect(getWaveformStatusEntry("/tmp/x.json", "raw", "track:a")).toBeNull();
  });

  it("announces refs that become ready, once per key", async () => {
    const readyFn = vi.fn();
    const off = onWaveformReady(readyFn);
    subscribeWaveformStatus(P, "stem", () => {});
    loads.shift()!.resolve(status({ "stem:a": ready("1".repeat(20)) }));
    await flush();
    refreshWaveformStatus(P, "stem");
    loads.shift()!.resolve(status({ "stem:a": ready("1".repeat(20)) }));
    await flush();
    refreshWaveformStatus(P);
    loads.shift()!.resolve(status({ "stem:a": ready("2".repeat(20)) }));
    await flush();
    expect(readyFn.mock.calls.map((c) => [c[0], c[1], c[2].key])).toEqual([
      [P, "stem:a", "1".repeat(20)],
      [P, "stem:a", "2".repeat(20)],
    ]);
    off();
  });

  it("refreshes at once on request and folds a request made mid-flight", async () => {
    subscribeWaveformStatus(P, "raw", () => {});
    expect(loads).toHaveLength(1);
    refreshWaveformStatus(P, "raw");
    expect(loads).toHaveLength(1);
    loads.shift()!.resolve(status({}));
    await flush();
    expect(loads).toHaveLength(1);
    // Without subscribers there is nothing to refresh.
    refreshWaveformStatus("/tmp/none.json");
    expect(loads).toHaveLength(1);
  });

  it("refetches once per key after a tile 404", async () => {
    subscribeWaveformStatus(P, "raw", () => {});
    loads.shift()!.resolve(status({}));
    await flush();
    noteWaveformTileMissing(P, "track:a", "a".repeat(20));
    noteWaveformTileMissing(P, "track:a", "a".repeat(20));
    expect(loads).toHaveLength(1);
    expect(loads[0]!.kind).toBe("raw");
  });

  it("retries a failed poll with back-off while subscribed", async () => {
    const off = subscribeWaveformStatus(P, "raw", () => {});
    loads.shift()!.reject(new Error("offline"));
    await flush();
    vi.advanceTimersByTime(1000);
    expect(loads).toHaveLength(1);
    off();
    loads.shift()!.reject(new Error("offline"));
    await flush();
    vi.advanceTimersByTime(10_000);
    expect(loads).toHaveLength(0);
  });

  it("drops other projects' pollers", () => {
    subscribeWaveformStatus(P, "raw", () => {});
    subscribeWaveformStatus("/tmp/q.json", "raw", () => {});
    const q = loads[1]!;
    retainWaveformStatus(P);
    expect(q.signal.aborted).toBe(true);
    expect(loads[0]!.signal.aborted).toBe(false);
  });

  it("useWaveformStatus returns one ref's entry", async () => {
    const { result } = renderHook(() => useWaveformStatus(P, "raw", "track:a"));
    expect(result.current).toBeNull();
    await act(async () => {
      loads.shift()!.resolve(status({ "track:a": { status: "generating" } }));
      await flush();
    });
    expect(result.current).toEqual({ status: "generating" });
    const none = renderHook(() => useWaveformStatus("", "raw", null));
    expect(none.result.current).toBeNull();
    expect(loads).toHaveLength(0);
  });

  it("lane status follows every ref a lane draws", async () => {
    const { result } = renderHook(() =>
      useLaneWaveformStatus(P, "stem:a\ntrack:b"),
    );
    expect(result.current).toBe("idle");
    // One poll per kind.
    expect(loads.map((l) => l.kind).sort()).toEqual(["raw", "stem"]);
    await act(async () => {
      for (const l of loads.splice(0)) {
        l.resolve(
          status(
            l.kind === "stem"
              ? { "stem:a": { status: "generating" } }
              : { "track:b": { status: "unavailable", reason: "no-media" } },
          ),
        );
      }
      await flush();
    });
    expect(result.current).toBe("generating");
    expect(renderHook(() => useLaneWaveformStatus(P, "")).result.current).toBe(
      "idle",
    );
  });

  it("refetches after a later 404 once a poll stopped listing the key", async () => {
    subscribeWaveformStatus(P, "raw", () => {});
    const key = "a".repeat(20);
    loads.shift()!.resolve(status({ "track:a": ready(key) }));
    await flush();
    noteWaveformTileMissing(P, "track:a", key);
    expect(loads).toHaveLength(1);
    loads.shift()!.resolve(status({ "track:a": { status: "generating" } }));
    await flush();
    vi.advanceTimersByTime(1000);
    loads.shift()!.resolve(status({ "track:a": ready(key) }));
    await flush();
    noteWaveformTileMissing(P, "track:a", key);
    expect(loads).toHaveLength(1);
  });

  it("ignores a tile 404 for a project it does not watch", () => {
    noteWaveformTileMissing("/tmp/none.json", "track:a", "a".repeat(20));
    expect(loads).toHaveLength(0);
  });

  it("restarts a poller stopped by a permanent error for a later subscriber", async () => {
    const off1 = subscribeWaveformStatus(P, "raw", () => {});
    loads.shift()!.reject(new WaveformFetchError(403, null));
    await flush();
    vi.advanceTimersByTime(5000);
    const off2 = subscribeWaveformStatus(P, "raw", () => {});
    expect(loads).toHaveLength(1);
    loads.shift()!.resolve(status({}));
    await flush();
    const off3 = subscribeWaveformStatus(P, "raw", () => {});
    expect(loads).toHaveLength(0);
    off1();
    off2();
    off3();
  });

  it("restarts a stopped poller at most once per cooldown, however many subscribe", async () => {
    const offs = [subscribeWaveformStatus(P, "raw", () => {})];
    loads.shift()!.reject(new WaveformFetchError(403, null));
    await flush();
    for (let i = 0; i < 10; i++) {
      offs.push(subscribeWaveformStatus(P, "raw", () => {}));
    }
    expect(loads).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    offs.push(subscribeWaveformStatus(P, "raw", () => {}));
    expect(loads).toHaveLength(1);
    loads.shift()!.reject(new WaveformFetchError(403, null));
    await flush();
    for (let i = 0; i < 10; i++) {
      offs.push(subscribeWaveformStatus(P, "raw", () => {}));
    }
    expect(loads).toHaveLength(0);
    for (const off of offs) {
      off();
    }
  });

  it("keeps a stopped poller stopped when all subscribers leave and one returns within the cooldown", async () => {
    const off1 = subscribeWaveformStatus(P, "raw", () => {});
    loads.shift()!.reject(new WaveformFetchError(403, null));
    await flush();
    off1();
    vi.advanceTimersByTime(4000);
    const off2 = subscribeWaveformStatus(P, "raw", () => {});
    expect(loads).toHaveLength(0);
    off2();
    vi.advanceTimersByTime(1000);
    const off3 = subscribeWaveformStatus(P, "raw", () => {});
    expect(loads).toHaveLength(1);
    off3();
  });

  it("keeps no trace of a tile 404 from before the project was watched", async () => {
    const key = "a".repeat(20);
    noteWaveformTileMissing(P, "track:a", key);
    const off = subscribeWaveformStatus(P, "raw", () => {});
    expect(loads).toHaveLength(1);
    loads.shift()!.resolve(status({ "track:a": ready(key) }));
    await flush();
    // The unwatched 404 was not recorded, so this one re-polls.
    noteWaveformTileMissing(P, "track:a", key);
    expect(loads).toHaveLength(1);
    off();
  });
});

describe("laneWaveformStatus", () => {
  const gen = { status: "generating" as const };
  const gone = { status: "unavailable" as const };
  it("is generating, ready, idle or unavailable", () => {
    expect(laneWaveformStatus([])).toBe("idle");
    expect(laneWaveformStatus([ready("a".repeat(20)), gen])).toBe("generating");
    expect(laneWaveformStatus([ready("a".repeat(20)), gone])).toBe("ready");
    expect(laneWaveformStatus([gone, null])).toBe("idle");
    expect(laneWaveformStatus([gone, gone])).toBe("unavailable");
  });
});
