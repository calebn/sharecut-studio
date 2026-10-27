import { beforeEach, describe, expect, it, vi } from "vitest";
import { takeAutoRun, takeOpenStage, writeOpenIntent } from "./openIntent";

const PATH = "/ep/episode.project.json";

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

  it("is keyed by project", () => {
    writeOpenIntent(PATH, { autoRun: true });
    expect(takeAutoRun("/other/episode.project.json")).toBe(false);
    expect(takeAutoRun(PATH)).toBe(true);
  });

  it("ignores an unknown stage and a damaged value", () => {
    sessionStorage.setItem(`sharecut.openIntent:${PATH}`, '{"stage":"nope"}');
    expect(takeOpenStage(PATH)).toBeNull();
    sessionStorage.setItem(`sharecut.openIntent:${PATH}`, "{broken");
    expect(takeAutoRun(PATH)).toBe(false);
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
