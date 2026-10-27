import { describe, expect, it } from "vitest";
import { guestStages, ROLE_HINT } from "./guestLogic";

describe("guestStages", () => {
  it.each([
    ["viewer", null],
    ["commenter", null],
    ["editor", ["edit", "review"]],
  ] as const)("%s", (role, stages) => {
    expect(guestStages(role)).toEqual(stages);
  });
});

describe("ROLE_HINT", () => {
  it.each([
    ["viewer", "listen"],
    ["commenter", "comment and suggest cuts"],
    ["editor", "edit"],
  ] as const)("%s", (role, phrase) => {
    expect(ROLE_HINT[role]).toContain(phrase);
    expect(ROLE_HINT[role]).toContain("The host decides");
  });
});
