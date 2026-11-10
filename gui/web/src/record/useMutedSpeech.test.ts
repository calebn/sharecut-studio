import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMutedSpeech } from "./useMutedSpeech";

const meter = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));
vi.mock("./sharedMeterContext", () => ({
  acquireMeterContext: meter.acquire,
}));

function fakeStream() {
  const clones: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const stream = {
    clone: vi.fn(() => {
      const track = { enabled: false, stop: vi.fn() };
      clones.push(track);
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    }),
  } as unknown as MediaStream;
  return { stream, clones };
}

describe("useMutedSpeech", () => {
  let amplitude = 0.1;

  beforeEach(() => {
    vi.useFakeTimers();
    amplitude = 0.1;
    meter.release.mockClear();
    meter.acquire.mockImplementation(() => ({
      ctx: {
        resume: vi.fn(() => Promise.resolve()),
        createMediaStreamSource: () => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        }),
        createAnalyser: () => ({
          fftSize: 0,
          connect: vi.fn(),
          disconnect: vi.fn(),
          getFloatTimeDomainData: (buffer: Float32Array) =>
            buffer.fill(amplitude),
        }),
        createGain: () => ({
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        }),
        destination: {},
      },
      ready: Promise.resolve(),
      release: meter.release,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    meter.acquire.mockReset();
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("turns true after 10 s of speech while muted", async () => {
    const { stream } = fakeStream();
    const { result } = renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: true }),
    );
    await advance(5_000);
    expect(result.current).toBe(false);
    await advance(6_000);
    expect(result.current).toBe(true);
  });

  it("stays false for a quiet mic", async () => {
    amplitude = 0.0001;
    const { stream } = fakeStream();
    const { result } = renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: true }),
    );
    await advance(30_000);
    expect(result.current).toBe(false);
  });

  it("opens no tap while unmuted or without a stream", async () => {
    const { stream } = fakeStream();
    renderHook(() => useMutedSpeech(stream, { muted: false, counting: true }));
    renderHook(() => useMutedSpeech(null, { muted: true, counting: true }));
    await advance(1_000);
    expect(meter.acquire).not.toHaveBeenCalled();
    expect(stream.clone).not.toHaveBeenCalled();
  });

  it("clears and drops the tap on unmute", async () => {
    const { stream, clones } = fakeStream();
    const { result, rerender } = renderHook(
      ({ muted }) => useMutedSpeech(stream, { muted, counting: true }),
      { initialProps: { muted: true } },
    );
    await advance(11_000);
    expect(result.current).toBe(true);
    rerender({ muted: false });
    expect(result.current).toBe(false);
    expect(clones[0]?.stop).toHaveBeenCalledOnce();
    expect(meter.release).toHaveBeenCalledOnce();
  });

  it("drops the tap on unmount", async () => {
    const { stream, clones } = fakeStream();
    const { unmount } = renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: true }),
    );
    await advance(1_000);
    unmount();
    expect(clones[0]?.stop).toHaveBeenCalledOnce();
    expect(meter.release).toHaveBeenCalledOnce();
  });

  it("does not count while paused", async () => {
    const { stream } = fakeStream();
    const { result } = renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: false }),
    );
    await advance(30_000);
    expect(result.current).toBe(false);
  });

  it("never fires when the clone cannot be made", async () => {
    const stream = {
      clone: vi.fn(() => {
        throw new Error("no clone");
      }),
    } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: true }),
    );
    await advance(30_000);
    expect(result.current).toBe(false);
  });
});
