import { describe, expect, it } from "vitest";
import { keeperAudioConstraints, keeperSettingsMatch } from "./constraints";

describe("keeperAudioConstraints", () => {
  it("disables AEC/NS/AGC on the dry tap", () => {
    expect(keeperAudioConstraints()).toEqual({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        channelCount: 1,
      },
    });
  });

  it("pins an exact device when given", () => {
    const audio = keeperAudioConstraints("mic-2").audio;
    expect(audio).toMatchObject({ deviceId: { exact: "mic-2" } });
  });
});

describe("keeperSettingsMatch", () => {
  it("requires all three flags off", () => {
    expect(keeperSettingsMatch(undefined)).toBe(true);
    expect(
      keeperSettingsMatch({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    ).toBe(true);
    expect(
      keeperSettingsMatch({
        echoCancellation: true,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    ).toBe(false);
    expect(keeperSettingsMatch({})).toBe(true);
  });
});
