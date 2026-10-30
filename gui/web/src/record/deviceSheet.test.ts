import { describe, expect, it } from "vitest";
import { deviceMic, deviceTone, hostMicStatus } from "./deviceSheet";
import { roomToneClock } from "./roomTone";
import {
  ROOM_TONE_PROMPT_COPY,
  ROOM_TONE_TOO_LOUD_COPY,
  ROOM_TONE_TOO_SHORT_COPY,
} from "./types";

const STREAM = {} as MediaStream;
const OPTIONS = { deviceId: "", levelDb: -20 };

describe("deviceMic", () => {
  it("tells a missing input from a lost one", () => {
    const base = { stream: null, devices: [] };
    expect(deviceMic({ ...base, status: "unavailable" }, OPTIONS)).toEqual({
      status: "none",
    });
    expect(deviceMic({ ...base, status: "lost" }, OPTIONS)).toEqual({
      status: "lost",
    });
    expect(deviceMic({ ...base, status: "denied" }, OPTIONS)).toEqual({
      status: "denied",
    });
  });

  it("is ready with a stream", () => {
    expect(
      deviceMic({ status: "granted", stream: STREAM, devices: [] }, OPTIONS),
    ).toMatchObject({ status: "ready" });
  });
});

describe("hostMicStatus", () => {
  it("reads a lost stream as lost and no report as idle", () => {
    expect(hostMicStatus("granted", true)).toBe("lost");
    expect(hostMicStatus(null, false)).toBe("idle");
    expect(hostMicStatus("denied", false)).toBe("denied");
  });
});

describe("deviceTone", () => {
  const base = {
    status: "idle",
    delivery: "device",
    error: null,
    clock: roomToneClock(0),
    micReady: true,
    captureReady: true,
    takeRunning: false,
  } as const;

  it("is ready to record", () => {
    expect(deviceTone(base)).toEqual({
      state: "idle",
      label: ROOM_TONE_PROMPT_COPY,
      disabledReason: undefined,
    });
  });

  it("waits for the mic, then the take, then the capture", () => {
    expect(deviceTone({ ...base, micReady: false }).disabledReason).toMatch(
      /Allow the microphone/,
    );
    expect(deviceTone({ ...base, takeRunning: true }).disabledReason).toMatch(
      /between takes/,
    );
    expect(deviceTone({ ...base, captureReady: false }).disabledReason).toMatch(
      /joined the session.*try again/,
    );
  });

  it("names the outcome", () => {
    expect(deviceTone({ ...base, status: "too_loud" })).toMatchObject({
      state: "too-loud",
      message: ROOM_TONE_TOO_LOUD_COPY,
    });
    expect(
      deviceTone({ ...base, status: "recorded", delivery: "host" }).message,
    ).toBe("Room tone sent to the host");
    expect(deviceTone({ ...base, status: "recorded" }).message).toBe(
      "Room tone saved on this device",
    );
    expect(
      deviceTone({ ...base, status: "error", error: "Boom" }),
    ).toMatchObject({ state: "error", message: "Boom" });
    expect(deviceTone({ ...base, status: "too_short" })).toMatchObject({
      state: "too-short",
      message: ROOM_TONE_TOO_SHORT_COPY,
    });
  });

  it("counts down while capturing, then waits on the save", () => {
    expect(
      deviceTone({
        ...base,
        status: "capturing",
        clock: roomToneClock(18),
      }),
    ).toMatchObject({
      state: "capturing",
      message: "Stay quiet · 0:42",
      progress: 0.3,
      endEarlyDisabled: false,
    });
    expect(
      deviceTone({ ...base, status: "capturing", clock: roomToneClock(60) }),
    ).toMatchObject({
      message: "Saving room tone…",
      endEarlyDisabled: true,
    });
  });
});
