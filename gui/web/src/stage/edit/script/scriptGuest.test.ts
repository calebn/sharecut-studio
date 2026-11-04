import { describe, expect, it } from "vitest";
import { scriptGuestOf } from "./scriptGuest";

describe("scriptGuestOf", () => {
  it.each([
    ["the host", "/proj", null, "none", undefined],
    ["a viewer link", "share:abc", "view", "none", "viewer"],
    ["an editor link", "share:abc", "edit", "edit", undefined],
    ["a suggest link", "share:abc", "comment", "suggest", "suggester"],
    [
      "a comment link that cannot suggest",
      "share:abc",
      "comment",
      "none",
      "commenter",
    ],
    ["a comment link that can edit", "share:abc", "comment", "edit", undefined],
    [
      "a custom view+play+suggest set",
      "share:abc",
      "view",
      "suggest",
      "viewer",
    ],
  ] as const)("%s", (_, path, guestMode, mode, expected) => {
    expect(scriptGuestOf(path, guestMode, mode)).toBe(expected);
  });
});
