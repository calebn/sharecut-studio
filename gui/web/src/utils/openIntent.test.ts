import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestAutoRun,
  takeAutoRoom,
  takeAutoRun,
  takeOpenStage,
  writeOpenIntent,
} from "./openIntent";

const PATH = "/ep/episode.sharecut";

describe("open intent", () => {
  beforeEach(() => sessionStorage.clear());

  it("hands the stage over once and keeps the auto-run for its taker", () => {
    writeOpenIntent(PATH, { stage: "prepare", autoRun: true });
    expect(takeOpenStage(PATH)).toBe("prepare");
    expect(takeOpenStage(PATH)).toBeNull();
    expect(takeAutoRun(PATH)).toBe(true);
    expect(takeAutoRun(PATH)).toBe(false);
  });

  it("keeps the stage when auto-run is taken first", () => {
    writeOpenIntent(PATH, { stage: "record", autoRun: true });
    expect(takeAutoRun(PATH)).toBe(true);
    expect(takeOpenStage(PATH)).toBe("record");
  });

  it("hands the first-room request over once and survives the stage being taken", () => {
    writeOpenIntent(PATH, { stage: "record", autoRoom: true });
    expect(takeOpenStage(PATH)).toBe("record");
    expect(takeAutoRoom(PATH)).toBe(true);
    expect(takeAutoRoom(PATH)).toBe(false);
  });

  it("is keyed by project", () => {
    writeOpenIntent(PATH, { autoRun: true });
    expect(takeAutoRun("/other/episode.sharecut")).toBe(false);
    expect(takeAutoRun(PATH)).toBe(true);
  });

  it("adds a run request beside the stage and room already asked for", () => {
    writeOpenIntent(PATH, { stage: "edit", autoRoom: true });
    requestAutoRun(PATH);
    expect(takeAutoRun(PATH)).toBe(true);
    expect(takeAutoRoom(PATH)).toBe(true);
    expect(takeOpenStage(PATH)).toBe("edit");
  });

  it("ignores an unknown stage and a damaged value", () => {
    sessionStorage.setItem(`sharecut.openIntent:${PATH}`, '{"stage":"nope"}');
    expect(takeOpenStage(PATH)).toBeNull();
    sessionStorage.setItem(`sharecut.openIntent:${PATH}`, "{broken");
    expect(takeAutoRun(PATH)).toBe(false);
  });

  it("removes the stored key once nothing is left to hand over", () => {
    writeOpenIntent(PATH, { stage: "edit" });
    expect(takeOpenStage(PATH)).toBe("edit");
    expect(sessionStorage.getItem(`sharecut.openIntent:${PATH}`)).toBeNull();
    writeOpenIntent(PATH, {});
    expect(sessionStorage.length).toBe(0);
  });

  it("does nothing without a path or with blocked storage", () => {
    writeOpenIntent("", { stage: "edit" });
    expect(takeOpenStage("")).toBeNull();
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(takeOpenStage(PATH)).toBeNull();
    spy.mockRestore();
  });
});
