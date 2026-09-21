import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRoomToneWav } from "./encodeRoomTone";
import { attachKeeperTap } from "./keeper/graph";
import { KEEPER_SAMPLE_RATE } from "./keeper/pcm";

vi.mock("./keeper/graph", () => ({
  attachKeeperTap: vi.fn(
    async (_stream, onPcm: (pcm: Float32Array, rate: number) => void) => {
      onPcm(
        new Float32Array(KEEPER_SAMPLE_RATE).fill(0.01),
        KEEPER_SAMPLE_RATE,
      );
      return () => undefined;
    },
  ),
}));

const e2eWindow = window as Window & {
  __SHARECUT_E2E?: boolean;
  __SHARECUT_E2E_ROOM_TONE_PCM?: boolean;
};

afterEach(() => {
  e2eWindow.__SHARECUT_E2E = undefined;
  e2eWindow.__SHARECUT_E2E_ROOM_TONE_PCM = undefined;
  window.history.replaceState({}, "", "/");
  vi.clearAllMocks();
});

describe("encodeRoomToneWav", () => {
  it("encodes a 3s PCM WAV from the keeper tap", async () => {
    const encoded = await encodeRoomToneWav({} as MediaStream, {
      durationSec: 1,
    });
    expect(encoded.wav.byteLength).toBeGreaterThan(44);
    expect(encoded.samples.length).toBe(KEEPER_SAMPLE_RATE);
    expect(attachKeeperTap).toHaveBeenCalledOnce();
  });

  it("uses deterministic PCM only for the room-tone E2E harness", async () => {
    e2eWindow.__SHARECUT_E2E = true;
    e2eWindow.__SHARECUT_E2E_ROOM_TONE_PCM = true;
    window.history.replaceState({}, "", "?e2e=1");

    const encoded = await encodeRoomToneWav({} as MediaStream);

    expect(encoded.wav.byteLength).toBe(288_044);
    expect(encoded.samples).toHaveLength(144_000);
    expect(attachKeeperTap).not.toHaveBeenCalled();
  });

  it("stops the tap even when samples arrive during attach", async () => {
    const stop = vi.fn();
    vi.mocked(attachKeeperTap).mockImplementationOnce(
      async (_stream, onPcm: (pcm: Float32Array, rate: number) => void) => {
        onPcm(
          new Float32Array(KEEPER_SAMPLE_RATE).fill(0.01),
          KEEPER_SAMPLE_RATE,
        );
        return stop;
      },
    );
    await encodeRoomToneWav({} as MediaStream, { durationSec: 1 });
    expect(stop).toHaveBeenCalled();
  });

  it("rejects when aborted before samples arrive", async () => {
    const stop = vi.fn();
    const controller = new AbortController();
    vi.mocked(attachKeeperTap).mockImplementationOnce(async () => {
      controller.abort();
      return stop;
    });
    await expect(
      encodeRoomToneWav({} as MediaStream, {
        durationSec: 3,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalled();
  });

  it("times out if samples never arrive", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    vi.mocked(attachKeeperTap).mockImplementationOnce(async () => stop);
    const pending = encodeRoomToneWav({} as MediaStream, { durationSec: 1 });
    const expectation = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(2000);
    await expectation;
    expect(stop).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
