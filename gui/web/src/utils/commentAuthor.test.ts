import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMENT_NAME_MAX,
  commitCommentActor,
  GUEST_SESSION_LABEL,
  guestNameChosen,
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

  it("keeps the host's name and the guest's name apart", () => {
    saveCommentAuthor("Caleb");
    expect(sessionDisplayName("host")).toBe("Caleb");
    expect(sessionDisplayName("guest")).toBe(GUEST_SESSION_LABEL);
    saveCommentAuthor("Rae", "guest");
    expect(sessionDisplayName("guest")).toBe("Rae");
    expect(sessionDisplayName("host")).toBe("Caleb");
  });

  it.each(["viewer", "Host", "Guest"])(
    "treats a saved placeholder %s as unset",
    (placeholder) => {
      saveCommentAuthor(placeholder);
      expect(sessionDisplayName("host")).toBe(HOST_SESSION_LABEL);
    },
  );

  it("saving a blank name stores the viewer placeholder and falls back", () => {
    saveCommentAuthor("  ");
    expect(sessionDisplayName("host")).toBe(HOST_SESSION_LABEL);
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
    saveCommentAuthor("Rae", "guest");
    expect(resolveCommentActor("  ", "guest")).toBe("Rae");
  });

  it("falls back to the role's session label when nothing is saved", () => {
    expect(resolveCommentActor(undefined, "host")).toBe(HOST_SESSION_LABEL);
    expect(resolveCommentActor(null, "guest")).toBe(GUEST_SESSION_LABEL);
  });

  it("a blank guest name never picks up a saved Host", () => {
    saveCommentAuthor("Host");
    expect(resolveCommentActor("", "guest")).toBe("Guest");
    saveCommentAuthor("Guest", "guest");
    expect(resolveCommentActor("", "host")).toBe("Host");
  });
});

describe("commitCommentActor", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows and saves the host's typed name", () => {
    const show = vi.fn();
    expect(commitCommentActor(" Ada ", "host", show)).toBe("Ada");
    expect(show).toHaveBeenCalledWith("Ada");
    expect(sessionDisplayName("host")).toBe("Ada");
  });

  it("shows a guest's name but never saves it, so a reply cannot mark them as asked", () => {
    const show = vi.fn();
    expect(commitCommentActor("Ada", "guest", show)).toBe("Ada");
    expect(show).toHaveBeenCalledWith("Ada");
    expect(guestNameChosen()).toBe(false);
    expect(sessionDisplayName("host")).toBe(HOST_SESSION_LABEL);
  });

  it("a blank name commits the role's session label without a show callback", () => {
    expect(commitCommentActor("", "guest")).toBe(GUEST_SESSION_LABEL);
    expect(guestNameChosen()).toBe(false);
  });
});

describe("guestNameChosen", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is false until the guest saves a name or a Skip", () => {
    expect(guestNameChosen()).toBe(false);
    saveCommentAuthor("", "guest");
    expect(guestNameChosen()).toBe(true);
    expect(sessionDisplayName("guest")).toBe(GUEST_SESSION_LABEL);
  });

  it("is not set by the host's saved name", () => {
    saveCommentAuthor("Dana");
    expect(guestNameChosen()).toBe(false);
    expect(sessionDisplayName("guest")).toBe(GUEST_SESSION_LABEL);
  });

  it("caps a saved name by code points and drops invisible and markup characters", () => {
    saveCommentAuthor("x".repeat(COMMENT_NAME_MAX + 20), "guest");
    expect(sessionDisplayName("guest")).toBe("x".repeat(COMMENT_NAME_MAX));
    saveCommentAuthor("\u{1F600}".repeat(60), "guest");
    expect(Array.from(sessionDisplayName("guest"))).toHaveLength(
      COMMENT_NAME_MAX,
    );
    saveCommentAuthor("\u200b<b>Sam</b>\ud83d", "guest");
    expect(sessionDisplayName("guest")).toBe("bSam/b");
    saveCommentAuthor("\u200b\u200d", "guest");
    expect(sessionDisplayName("guest")).toBe(GUEST_SESSION_LABEL);
  });
});
