import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitCommentActor,
  GUEST_SESSION_LABEL,
  HOST_SESSION_LABEL,
  resolveCommentActor,
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

describe("resolveCommentActor", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("an explicit name wins", () => {
    expect(resolveCommentActor("Ada", "guest")).toBe("Ada");
  });

  it("a blank explicit name falls back to the saved name", () => {
    saveCommentAuthor("Caleb");
    expect(resolveCommentActor("  ", "host")).toBe("Caleb");
  });

  it("falls back to the role's session label when nothing is saved", () => {
    expect(resolveCommentActor(undefined, "host")).toBe(HOST_SESSION_LABEL);
    expect(resolveCommentActor(null, "guest")).toBe(GUEST_SESSION_LABEL);
  });

  it("a blank guest name never picks up a saved Host", () => {
    saveCommentAuthor("Host");
    expect(resolveCommentActor("", "guest")).toBe("Guest");
    saveCommentAuthor("Guest");
    expect(resolveCommentActor("", "host")).toBe("Host");
  });
});

describe("commitCommentActor", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows and saves the typed name", () => {
    const show = vi.fn();
    expect(commitCommentActor(" Ada ", "guest", show)).toBe("Ada");
    expect(show).toHaveBeenCalledWith("Ada");
    expect(sessionDisplayName("host")).toBe("Ada");
  });

  it("a blank name commits the role's session label without a show callback", () => {
    expect(commitCommentActor("", "guest")).toBe(GUEST_SESSION_LABEL);
    expect(sessionDisplayName("host")).toBe(HOST_SESSION_LABEL);
  });
});
