import { beforeEach, describe, expect, it } from "vitest";
import {
  GUEST_SESSION_LABEL,
  HOST_SESSION_LABEL,
  saveCommentAuthor,
  sessionDisplayName,
} from "./commentAuthor";

describe("sessionDisplayName", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to the role's presence label when nothing is saved", () => {
    expect(sessionDisplayName("host")).toBe(HOST_SESSION_LABEL);
    expect(sessionDisplayName("guest")).toBe(GUEST_SESSION_LABEL);
  });

  it("uses a saved real name for both roles", () => {
    saveCommentAuthor("Caleb");
    expect(sessionDisplayName("host")).toBe("Caleb");
    expect(sessionDisplayName("guest")).toBe("Caleb");
  });

  it.each(["viewer", "Host", "Guest"])(
    "treats a saved placeholder %s as unset",
    (placeholder) => {
      saveCommentAuthor(placeholder);
      expect(sessionDisplayName("host")).toBe(HOST_SESSION_LABEL);
      expect(sessionDisplayName("guest")).toBe(GUEST_SESSION_LABEL);
    },
  );

  it("saving a blank name stores the viewer placeholder and falls back", () => {
    saveCommentAuthor("  ");
    expect(sessionDisplayName("host")).toBe(HOST_SESSION_LABEL);
    expect(sessionDisplayName("guest")).toBe(GUEST_SESSION_LABEL);
  });
});
