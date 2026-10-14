import { describe, expect, it } from "vitest";
import {
  type SaveState,
  type SaveStateInput,
  saveStateOf,
  saveStateText,
} from "./saveState";

const quiet: SaveStateInput = {
  busy: false,
  pending: 0,
  refusals: [],
  unreadable: false,
  loaded: true,
  settling: false,
};

describe("saveStateOf", () => {
  it("is saved when nothing is sending, queued or refused", () => {
    expect(saveStateOf(quiet)).toEqual({ kind: "saved" });
  });

  it("says nothing before the queue has been read", () => {
    expect(saveStateOf({ ...quiet, loaded: false })).toBeNull();
  });

  it("is saving while a send is in flight, even with edits already queued", () => {
    expect(saveStateOf({ ...quiet, busy: true, pending: 2 })).toEqual({
      kind: "saving",
    });
  });

  it("stays saving while a finished send's queue has not been read back", () => {
    expect(saveStateOf({ ...quiet, settling: true })).toEqual({
      kind: "saving",
    });
  });

  it("counts the edits waiting to send", () => {
    expect(saveStateOf({ ...quiet, pending: 3 })).toEqual({
      kind: "waiting",
      count: 3,
    });
  });

  it("names the newest refusal as the reason a save failed", () => {
    expect(
      saveStateOf({
        ...quiet,
        pending: 1,
        refusals: ["old", "The clip moved"],
      }),
    ).toEqual({ kind: "failed", cause: "refused", reason: "The clip moved" });
  });

  it("fails when the saved edits cannot be read, even before a first read", () => {
    expect(saveStateOf({ ...quiet, loaded: false, unreadable: true })).toEqual({
      kind: "failed",
      cause: "unreadable",
    });
  });
});

describe("saveStateText", () => {
  const cases: [SaveState, string][] = [
    [{ kind: "saving" }, "Saving to project…"],
    [{ kind: "saved" }, "Saved to project"],
    [{ kind: "waiting", count: 1 }, "Not saved yet · 1 waiting to send"],
    [{ kind: "waiting", count: 4 }, "Not saved yet · 4 waiting to send"],
    [{ kind: "failed", cause: "refused", reason: "x" }, "Save failed"],
    [{ kind: "failed", cause: "unreadable" }, "Save failed"],
  ];
  it.each(cases)("%j reads %s", (state, text) => {
    expect(saveStateText(state)).toBe(text);
  });
});
