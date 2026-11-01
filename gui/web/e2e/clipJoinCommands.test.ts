import { describe, expect, it } from "vitest";
import { logicalClipJoinCommands } from "./clipJoinCommands";

const first = {
  type: "SetClipJoin",
  command_id: "join-first",
  client_id: "viewer-test",
  client_seq: 3,
  payload: { left_clip_id: "left", right_clip_id: "right", length_ms: 1 },
  role: "viewer",
};
const second = {
  ...first,
  command_id: "join-second",
  client_seq: 4,
  payload: { ...first.payload, length_ms: 2 },
};

describe("logical clip join command inventory", () => {
  it("keeps two edits when the saved first command is replayed after reload", () => {
    expect(logicalClipJoinCommands([first, { ...first }, second])).toEqual([
      first,
      second,
    ]);
  });

  it.each([
    { payload: { ...first.payload, length_ms: 9 } },
    { client_id: "another-viewer" },
    { client_seq: 8 },
    { role: "editor" },
    { unexpected: "changed envelope" },
  ])("rejects changed replay envelope %j", (change) => {
    expect(() =>
      logicalClipJoinCommands([first, { ...first, ...change }]),
    ).toThrow(/replay changed/i);
  });

  it.each([
    { command_id: "" },
    { command_id: undefined },
    { client_id: "" },
    { client_seq: 0 },
    { client_seq: 1.5 },
  ])("rejects an invalid command identity %j", (change) => {
    expect(() => logicalClipJoinCommands([{ ...first, ...change }])).toThrow(
      /identity/i,
    );
  });

  it("keeps a third distinct edit even when it repeats the first payload", () => {
    const third = { ...first, command_id: "join-third", client_seq: 5 };
    const logical = logicalClipJoinCommands([
      first,
      { ...first },
      second,
      third,
    ]);
    expect(logical).toEqual([first, second, third]);
    expect(logical).not.toHaveLength(2);
  });

  it("leaves the raw attempts intact and ignores other command types", () => {
    const attempts = [first, { ...first }, second, { type: "UndoHistory" }];
    const before = structuredClone(attempts);
    logicalClipJoinCommands(attempts);
    expect(attempts).toEqual(before);
  });
});
