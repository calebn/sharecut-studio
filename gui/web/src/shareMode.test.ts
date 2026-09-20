import { describe, expect, it } from "vitest";
import {
  canApplyPass12,
  canApplyStructural,
  canComment,
  canHostMutate,
  canRefreshMix,
  canReply,
  canSetAction,
  canSuggestOrNudge,
  canSuggestStructural,
  guestHearsMixOnly,
  guestShareBannerLabel,
  hasShareCapability,
  isShareProjectKey,
  shareProjectKey,
  shareTokenFromKey,
} from "./shareMode";

const editCaps = ["play", "view", "edit"];
const suggestCaps = ["play", "view", "suggest"];
const commentCaps = ["play", "comment", "reply"];

describe("shareMode", () => {
  it("round-trips share keys", () => {
    const key = shareProjectKey("abcToken");
    expect(isShareProjectKey(key)).toBe(true);
    expect(shareTokenFromKey(key)).toBe("abcToken");
    expect(isShareProjectKey("/tmp/episode.project.json")).toBe(false);
  });

  it("mirrors view→play and comment→reply aliases", () => {
    expect(hasShareCapability(["view"], "play")).toBe(true);
    expect(hasShareCapability(["comment"], "reply")).toBe(true);
    expect(hasShareCapability(["play"], "view")).toBe(false);
  });

  it("gates Pass 1–2 apply and suggest by capabilities, not guestMode alone", () => {
    const host = "/tmp/ep.project.json";
    const share = shareProjectKey("tok");
    expect(canApplyPass12(host, null)).toBe(true);
    expect(canSuggestOrNudge(host, null)).toBe(true);
    expect(canHostMutate(host)).toBe(true);

    expect(canApplyPass12(share, "edit")).toBe(false);
    expect(canApplyPass12(share, "edit", editCaps)).toBe(true);
    expect(canSuggestOrNudge(share, "edit", editCaps)).toBe(true);
    expect(canApplyPass12(share, "suggest", suggestCaps)).toBe(false);
    expect(canSuggestOrNudge(share, "suggest", suggestCaps)).toBe(true);
    expect(canApplyPass12(share, "view", ["play", "view"])).toBe(false);
    expect(canSuggestOrNudge(share, "view", ["play", "view"])).toBe(false);
    expect(canHostMutate(share)).toBe(false);
  });

  it("gates structural apply vs suggest", () => {
    const host = "/tmp/ep.project.json";
    const share = shareProjectKey("tok");
    expect(canApplyStructural(host, null)).toBe(true);
    expect(canSuggestStructural(host, null)).toBe(true);
    expect(canApplyStructural(share, "edit", editCaps)).toBe(true);
    expect(canSuggestStructural(share, "edit", editCaps)).toBe(true);
    expect(canApplyStructural(share, "suggest", suggestCaps)).toBe(false);
    expect(canSuggestStructural(share, "suggest", suggestCaps)).toBe(true);
    expect(canSuggestStructural(share, "view", ["play", "view"])).toBe(false);
  });

  it("treats any share guestMode as Mix-only", () => {
    expect(guestHearsMixOnly(null)).toBe(false);
    expect(guestHearsMixOnly("view")).toBe(true);
    expect(guestHearsMixOnly("edit")).toBe(true);
    expect(guestHearsMixOnly("comment")).toBe(true);
  });

  it("labels the guest banner by mode", () => {
    expect(guestShareBannerLabel("edit")).toBe(
      "Shared edit view · You can add tracks and audio",
    );
    expect(guestShareBannerLabel("suggest")).toBe("Shared suggest view");
    expect(guestShareBannerLabel("view")).toBe("Shared read-only view");
    expect(guestShareBannerLabel("comment")).toBe("Shared comment view");
    expect(guestShareBannerLabel(null)).toBe("Shared view");
  });

  it("gates refresh mix to host or Docs Editor", () => {
    const host = "/tmp/ep.project.json";
    const share = shareProjectKey("tok");
    expect(canRefreshMix(host, null)).toBe(true);
    expect(canRefreshMix(share, "edit", editCaps)).toBe(true);
    expect(canRefreshMix(share, "suggest", suggestCaps)).toBe(false);
    expect(canRefreshMix(share, "view", ["play", "view"])).toBe(false);
    expect(canRefreshMix(share, "comment", commentCaps)).toBe(false);
  });

  it("does not enable comment from guestMode when caps are omitted", () => {
    const host = "/tmp/ep.project.json";
    const share = shareProjectKey("tok");
    expect(canComment(host, null)).toBe(true);
    expect(canComment(share, "edit")).toBe(false);
    expect(canComment(share, "suggest")).toBe(false);
    expect(canComment(share, "comment")).toBe(false);
    expect(canComment(share, "suggest", ["play", "view", "suggest"])).toBe(
      false,
    );
    expect(
      canComment(share, "suggest", ["play", "view", "comment", "suggest"]),
    ).toBe(true);
    expect(canComment(share, "comment", ["play", "reply"])).toBe(false);
    expect(canReply(share, "comment", ["play", "reply"])).toBe(true);
    expect(canReply(share, "comment", ["play", "view", "comment"])).toBe(true);
    expect(canSetAction(share, ["play", "comment", "action"])).toBe(true);
    expect(canSetAction(share, ["play", "comment"])).toBe(false);
    expect(canSetAction(share)).toBe(false);
  });
});
