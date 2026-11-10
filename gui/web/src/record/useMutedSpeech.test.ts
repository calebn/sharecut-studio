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
        state: "running",
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
      useMutedSpeech(stream, { muted: true, counting: true, onAir: true }),
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
      useMutedSpeech(stream, { muted: true, counting: true, onAir: true }),
    );
    await advance(30_000);
    expect(result.current).toBe(false);
  });

  it("opens no tap while unmuted or without a stream", async () => {
    const { stream } = fakeStream();
    renderHook(() =>
      useMutedSpeech(stream, { muted: false, counting: true, onAir: true }),
    );
    renderHook(() =>
      useMutedSpeech(null, { muted: true, counting: true, onAir: true }),
    );
    await advance(1_000);
    expect(meter.acquire).not.toHaveBeenCalled();
    expect(stream.clone).not.toHaveBeenCalled();
  });

  it("clears and drops the tap on unmute", async () => {
    const { stream, clones } = fakeStream();
    const { result, rerender } = renderHook(
      ({ muted }) =>
        useMutedSpeech(stream, { muted, counting: true, onAir: true }),
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
      useMutedSpeech(stream, { muted: true, counting: true, onAir: true }),
    );
    await advance(1_000);
    unmount();
    expect(clones[0]?.stop).toHaveBeenCalledOnce();
    expect(meter.release).toHaveBeenCalledOnce();
  });

  it("releases the audio context when unmounted while the meter is still loading", async () => {
    const { stream } = fakeStream();
    let ready!: () => void;
    const acquired = meter.acquire.getMockImplementation()?.();
    meter.acquire.mockImplementationOnce(() => ({
      ...acquired,
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
    }));
    const { unmount } = renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: true, onAir: true }),
    );
    await advance(1_000);
    unmount();
    expect(meter.release).toHaveBeenCalledOnce();
    ready();
    await advance(1_000);
    expect(stream.clone).not.toHaveBeenCalled();
    expect(meter.release).toHaveBeenCalledOnce();
  });

  it("does not count while paused", async () => {
    const { stream } = fakeStream();
    const { result } = renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: false, onAir: true }),
    );
    await advance(30_000);
    expect(result.current).toBe(false);
  });

  it("resets the count and the alert when the take stops, not on a pause", async () => {
    const { stream, clones } = fakeStream();
    const { result, rerender } = renderHook(
      (props) => useMutedSpeech(stream, props),
      { initialProps: { muted: true, counting: true, onAir: true } },
    );
    await advance(6_000);
    rerender({ muted: true, counting: false, onAir: true });
    await advance(30_000);
    expect(clones).toHaveLength(1);
    rerender({ muted: true, counting: true, onAir: true });
    await advance(5_000);
    expect(result.current).toBe(true);
    rerender({ muted: true, counting: false, onAir: false });
    expect(result.current).toBe(false);
    expect(clones[0]?.stop).toHaveBeenCalledOnce();
    rerender({ muted: true, counting: true, onAir: true });
    await advance(6_000);
    expect(result.current).toBe(false);
    await advance(5_000);
    expect(result.current).toBe(true);
  });

  it("freezes the count on a live recording to paused change", async () => {
    const { stream } = fakeStream();
    const { result, rerender } = renderHook(
      (props) => useMutedSpeech(stream, props),
      { initialProps: { muted: true, counting: true, onAir: true } },
    );
    await advance(6_000);
    rerender({ muted: true, counting: false, onAir: true });
    await advance(30_000);
    expect(result.current).toBe(false);
    rerender({ muted: true, counting: true, onAir: true });
    await advance(3_000);
    expect(result.current).toBe(false);
    await advance(2_000);
    expect(result.current).toBe(true);
  });

  it("opens no tap while the room is not on air", async () => {
    const { stream } = fakeStream();
    renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: false, onAir: false }),
    );
    await advance(1_000);
    expect(stream.clone).not.toHaveBeenCalled();
  });

  it("counts again from zero after an unmute and re-mute", async () => {
    const { stream } = fakeStream();
    const { result, rerender } = renderHook(
      ({ muted }) =>
        useMutedSpeech(stream, { muted, counting: true, onAir: true }),
      { initialProps: { muted: true } },
    );
    await advance(8_000);
    rerender({ muted: false });
    rerender({ muted: true });
    await advance(8_000);
    expect(result.current).toBe(false);
    await advance(3_000);
    expect(result.current).toBe(true);
  });

  it("drops the old tap and opens a new one when the stream changes", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const { rerender } = renderHook(
      ({ stream }) =>
        useMutedSpeech(stream, { muted: true, counting: true, onAir: true }),
      { initialProps: { stream: first.stream } },
    );
    await advance(1_000);
    rerender({ stream: second.stream });
    await advance(1_000);
    expect(first.clones[0]?.stop).toHaveBeenCalledOnce();
    expect(second.stream.clone).toHaveBeenCalledOnce();
    expect(meter.release).toHaveBeenCalledOnce();
  });

  it("never fires when the clone cannot be made", async () => {
    const stream = {
      clone: vi.fn(() => {
        throw new Error("no clone");
      }),
    } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useMutedSpeech(stream, { muted: true, counting: true, onAir: true }),
    );
    await advance(30_000);
    expect(result.current).toBe(false);
  });
});
