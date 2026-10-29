import { describe, expect, it } from "vitest";
import {
  type DeviceMic,
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
});
