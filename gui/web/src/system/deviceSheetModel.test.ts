import { describe, expect, it } from "vitest";
import {
  type DeviceMic,
  type DeviceOutput,
  type DeviceTone,
  deviceSheetModel,
} from "./deviceSheetModel";

const TONE: DeviceTone = { state: "idle", label: "Record room tone" };
const READY: DeviceMic = { status: "ready", input: "USB Mic", level: 0.3 };

const build = (mic: DeviceMic, tone: DeviceTone = TONE, micNotes?: string[]) =>
  deviceSheetModel({ mic, headphones: false, tone, micNotes });

describe("deviceSheetModel", () => {
  it.each([
    [READY, TONE, "ready"],
    [{ status: "denied" }, TONE, "denied"],
    [{ status: "lost" }, TONE, "input-lost"],
    [{ status: "none" }, TONE, "no-input"],
    [READY, { ...TONE, state: "too-loud" }, "room-tone-too-loud"],
    [{ status: "denied" }, { ...TONE, state: "too-loud" }, "denied"],
  ] as const)("reads %j with tone %j as %s", (mic, tone, state) => {
    expect(build(mic, tone).state).toBe(state);
  });

  it("offers Retry when no input is found", () => {
    const model = build({ status: "none" });
    expect(model.mic).toMatchObject({
      state: "failed",
      title: "No microphone found",
      action: { kind: "retry" },
    });
    expect(model.control).toEqual({ status: "idle" });
  });

  it("adds the clip note after the caller's", () => {
    const model = build({ ...READY, clipped: true }, TONE, ["Saved mic gone"]);
    expect(model.micNotes.map((note) => note.text)).toEqual([
      "Saved mic gone",
      "Too loud. Move back a little.",
    ]);
  });

  it("turns the tone state into a row state", () => {
    expect(build(READY, { ...TONE, state: "capturing" }).toneRow.state).toBe(
      "running",
    );
    expect(build(READY, { ...TONE, state: "recorded" }).toneRow.state).toBe(
      "done",
    );
    expect(build(READY, { ...TONE, state: "too-loud" }).toneRow.state).toBe(
      "needs-you",
    );
    expect(build(READY, { ...TONE, state: "error" }).toneRow.state).toBe(
      "failed",
    );
  });

  describe("output", () => {
    const devices = [
      { id: "hp", label: "Headset" },
      { id: "sp", label: "Desk speakers" },
    ];
    const withOutput = (output: DeviceOutput) =>
      deviceSheetModel({
        mic: READY,
        headphones: false,
        tone: TONE,
        output,
      });

    it("has no row when the browser cannot pick a speaker or none is given", () => {
      expect(build(READY).output).toBeNull();
      expect(
        withOutput({ supported: false, devices, selectedId: "hp" }).output,
      ).toBeNull();
    });

    it("names the picked speaker, or Default", () => {
      expect(
        withOutput({ supported: true, devices, selectedId: "sp" }).output,
      ).toMatchObject({
        row: { state: "done", title: "Speaker", detail: "Desk speakers" },
        selectedId: "sp",
        notes: [],
      });
      expect(
        withOutput({ supported: true, devices, selectedId: "" }).output?.row
          .detail,
      ).toBe("Default");
    });

    it("turns an error into a warning note under the row", () => {
      const output = withOutput({
        supported: true,
        devices,
        selectedId: "",
        error: "Couldn't switch speakers. Using the default.",
      }).output;
      expect(output?.row.state).toBe("done");
      expect(output?.notes).toEqual([
        {
          tone: "warning",
          text: "Couldn't switch speakers. Using the default.",
        },
      ]);
    });
  });
});
