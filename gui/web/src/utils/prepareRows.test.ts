import { describe, expect, it } from "vitest";
import {
  ownerRow,
  ROW_ORDER,
  ROW_STEPS,
  RUN_WINDOW_ROW,
  stepActivity,
} from "./prepareRows";

describe("prepareRows", () => {
  it("gives every listed step exactly one owning row", () => {
    const all = ROW_ORDER.flatMap((row) => ROW_STEPS[row]);
    expect(new Set(all).size).toBe(all.length);
    expect(ownerRow("clean_audio")).toBe("clean");
    expect(ownerRow("align_tracks")).toBe("align");
    expect(ownerRow("export_deliverables")).toBeUndefined();
  });

  it("names the activity of the row a step runs in", () => {
    expect(stepActivity("clean_audio")).toBe("Cleaning");
    expect(stepActivity("ingest_tracks")).toBeUndefined();
    expect(stepActivity("mix_music")).toBeUndefined();
  });

  it("uses the run window row for a step that runs ahead of its owner", () => {
    expect(ownerRow("extract_room_tone_beds")).toBe("clean");
    expect(RUN_WINDOW_ROW.extract_room_tone_beds).toBe("align");
    expect(stepActivity("extract_room_tone_beds")).toBe("Lining up tracks");
  });
});
