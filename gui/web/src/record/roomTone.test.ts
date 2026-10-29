import { describe, expect, it, vi } from "vitest";
import {
  rmsDbfs,
  roomToneCapturingAlert,
  roomToneClock,
  roomToneReady,
  roomToneTooLoud,
} from "./roomTone";
import {
  ROOM_TONE_DURATION_SEC,
  ROOM_TONE_MIN_SEC,
  ROOM_TONE_PROMPT_COPY,
} from "./types";

describe("roomTone", () => {
  it("flags RMS above -35 dBFS as too loud", () => {
    const loud = new Float32Array(32).fill(0.1);
    const quiet = new Float32Array(32).fill(0.001);
    expect(rmsDbfs(loud)).toBeGreaterThan(-35);
    expect(roomToneTooLoud(loud)).toBe(true);
    expect(roomToneTooLoud(quiet)).toBe(false);
    expect(rmsDbfs(new Float32Array(0))).toBe(Number.NEGATIVE_INFINITY);
  });

  it("treats recorded, skipped, and too_loud as ready for consent", () => {
    expect(roomToneReady("idle")).toBe(false);
    expect(roomToneReady("capturing")).toBe(false);
    expect(roomToneReady("recorded")).toBe(true);
    expect(roomToneReady("skipped")).toBe(true);
    expect(roomToneReady("too_loud")).toBe(true);
    expect(roomToneReady("too_short")).toBe(true);
  });

  it("is one minute, kept at ten seconds when ended early", () => {
    expect(ROOM_TONE_DURATION_SEC).toBe(60);
    expect(ROOM_TONE_MIN_SEC).toBe(10);
    expect(ROOM_TONE_PROMPT_COPY).toBe("Record 1 minute of room tone");
  });

  it("measures loudness over the whole take, not its loudest second", () => {
    const rate = 48_000;
    const take = new Float32Array(rate * 60).fill(0.001);
    take.fill(0.2, 0, rate / 10);
    expect(roomToneTooLoud(take)).toBe(false);
    expect(roomToneTooLoud(take.subarray(0, rate / 10))).toBe(true);
  });

  it("reads whole seconds left and the share used", () => {
    expect(roomToneClock(0)).toEqual({
      remainingSec: 60,
      progress: 0,
      saving: false,
    });
    expect(roomToneClock(0.2).remainingSec).toBe(60);
    expect(roomToneClock(18)).toEqual({
      remainingSec: 42,
      progress: 0.3,
      saving: false,
    });
    expect(roomToneClock(59.1).remainingSec).toBe(1);
    expect(roomToneClock(75)).toEqual({
      remainingSec: 0,
      progress: 1,
      saving: true,
    });
  });

  it("offers End early and Cancel only while capturing", () => {
    const endEarly = vi.fn();
    const cancel = vi.fn();
    const args = { clock: roomToneClock(18), endEarly, cancel };
    expect(roomToneCapturingAlert({ ...args, status: "idle" })).toBeNull();
    const alert = roomToneCapturingAlert({ ...args, status: "capturing" });
    expect(alert).toMatchObject({
      kind: "room-tone-capturing",
      message: "Stay quiet · 0:42",
      progress: 0.3,
    });
    alert?.onAction?.();
    alert?.onSecondaryAction?.();
    expect(endEarly).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("drops End early once the take is saving", () => {
    const alert = roomToneCapturingAlert({
      status: "capturing",
      clock: roomToneClock(60),
      endEarly: vi.fn(),
      cancel: vi.fn(),
    });
    expect(alert?.message).toBe("Saving room tone…");
    expect(alert?.actionDisabledReason).toBe("Room tone is saving.");
    expect(alert?.onSecondaryAction).toBeDefined();
  });
});
