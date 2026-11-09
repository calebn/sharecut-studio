import { describe, expect, it } from "vitest";
import { kindOf, roleForKind } from "./trackKind";

describe("kindOf", () => {
  it.each([
    ["dialogue", "voice"],
    ["music", "music"],
    ["intro", "music"],
    ["outro", "music"],
    ["sfx", "other"],
    ["weird", "voice"],
  ] as const)("reads %s as %s", (role, kind) => {
    expect(kindOf(role)).toBe(kind);
  });
});

describe("roleForKind", () => {
  it.each([
    ["intro", "music", null],
    ["outro", "music", null],
    ["intro", "voice", "dialogue"],
    ["sfx", "other", null],
    ["dialogue", "other", "sfx"],
    ["music", "voice", "dialogue"],
    ["dialogue", "music", "music"],
    ["weird", "voice", null],
  ] as const)("from %s to %s is %s", (role, kind, expected) => {
    expect(roleForKind(role, kind)).toBe(expected);
  });
});
