import { afterEach, describe, expect, it, vi } from "vitest";
import { detachE2eRemote, e2eRoomTonePcm, recordE2eEnabled } from "./e2eHook";

const e2eWindow = window as Window & {
  __SHARECUT_E2E?: boolean;
  __SHARECUT_E2E_ROOM_TONE_PCM?: boolean;
};

afterEach(() => {
  e2eWindow.__SHARECUT_E2E = undefined;
  e2eWindow.__SHARECUT_E2E_ROOM_TONE_PCM = undefined;
});

it("disconnects real remote sources even without a test oscillator", () => {
  const disconnect = vi.fn();
  const source = { disconnect } as unknown as AudioNode;
  const sources = new Map([["peer", source]]);

  detachE2eRemote(sources, new Map(), "peer");

  expect(disconnect).toHaveBeenCalledOnce();
  expect(sources.has("peer")).toBe(false);
});

describe("recordE2eEnabled", () => {
  it("requires both e2e=1 and the Playwright init flag", () => {
    e2eWindow.__SHARECUT_E2E = undefined;
    expect(recordE2eEnabled("?e2e=1")).toBe(false);
    e2eWindow.__SHARECUT_E2E = true;
    expect(recordE2eEnabled("")).toBe(false);
    expect(recordE2eEnabled("?project=/tmp/p")).toBe(false);
    expect(recordE2eEnabled("?e2e=0")).toBe(false);
    expect(recordE2eEnabled("?e2e=1")).toBe(true);
    expect(recordE2eEnabled("?project=/tmp/p&e2e=1")).toBe(true);
  });

  it("only supplies deterministic room-tone PCM to its explicitly flagged E2E page", () => {
    e2eWindow.__SHARECUT_E2E = true;
    expect(e2eRoomTonePcm(48_000, 3, "?e2e=1")).toBeNull();

    e2eWindow.__SHARECUT_E2E_ROOM_TONE_PCM = true;
    expect(e2eRoomTonePcm(48_000, 3, "?project=/tmp/p")).toBeNull();
    const pcm = e2eRoomTonePcm(48_000, 3, "?e2e=1");
    expect(pcm).toHaveLength(144_000);
    expect(pcm?.[0]).toBeCloseTo(0.001);
  });
});
