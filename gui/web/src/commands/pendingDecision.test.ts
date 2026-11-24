import { describe, expect, it } from "vitest";
import { pendingOffersCut } from "../utils/pendingOffersCut";
import {
  actionBarOwnsPendingVerbs,
  decideThroughSheet,
  EXACT_RANGE_REVIEW_REASON,
  pendingBarWords,
  pendingCutWords,
  registerPendingDecider,
  sheetBusyReason,
} from "./pendingDecision";

describe("actionBarOwnsPendingVerbs", () => {
  const cut = { type: "remove", suggested_action: "cut" as const };

  it.each(["cut", "shorten", "lower"] as const)(
    "is true for a reviewable %s suggestion",
    (suggested_action) => {
      expect(
        actionBarOwnsPendingVerbs({ type: "remove", suggested_action }, true),
      ).toBe(true);
    },
  );

  it.each([
    ["a viewer who cannot review", cut, false],
    ["a split", { ...cut, type: "split" }, true],
    ["leave", { ...cut, suggested_action: "leave" as const }, true],
    ["no action", { ...cut, suggested_action: null }, true],
    [
      "an exact range",
      { ...cut, exact_range: { intervals: [] } as never },
      true,
    ],
  ])("is false for %s", (_name, edit, canReview) => {
    expect(actionBarOwnsPendingVerbs(edit, canReview)).toBe(false);
  });
});

describe("pendingOffersCut", () => {
  it.each(["cut", "shorten", "lower"] as const)(
    "offers Cut for a %s suggestion",
    (suggested_action) => {
      expect(pendingOffersCut({ type: "remove", suggested_action })).toBe(true);
    },
  );

  it.each([
    ["leave", { type: "remove", suggested_action: "leave" as const }],
    ["no action", { type: "remove", suggested_action: null }],
    ["an absent action", { type: "remove" }],
    ["a split", { type: "split", suggested_action: "cut" as const }],
    [
      "an exact range",
      {
        type: "remove",
        suggested_action: "cut" as const,
        exact_range: { intervals: [] } as never,
      },
    ],
  ])("does not offer Cut for %s", (_name, edit) => {
    expect(pendingOffersCut(edit as never)).toBe(false);
  });
});

describe("pendingCutWords", () => {
  it.each([
    ["cut", "Cut", "Cutting…"],
    ["shorten", "Shorten", "Shortening…"],
    ["lower", "Lower", "Lowering…"],
    [null, "Cut", "Cutting…"],
  ] as const)("words %s as %s", (suggested_action, label, busy) => {
    expect(pendingCutWords({ suggested_action })).toEqual({ label, busy });
  });
});

describe("the sheet decider", () => {
  it("answers only for the edit the open sheet shows", async () => {
    const release = registerPendingDecider(
      "a",
      async () => "busy",
      () => "wait",
    );
    expect(await decideThroughSheet("b", "approve")).toBeNull();
    expect(await decideThroughSheet("a", "approve")).toEqual({
      status: "disabled",
      reason: "busy",
    });
    expect(sheetBusyReason("a")).toBe("wait");
    expect(sheetBusyReason("b")).toBeNull();
    release();
    expect(await decideThroughSheet("a", "approve")).toBeNull();
  });
});

describe("pendingBarWords", () => {
  const cutWords = (accept: string, acceptBusy: string) => ({
    accept,
    reject: "Keep",
    acceptBusy,
    rejectBusy: "Keeping…",
  });
  const approveWords = {
    accept: "Approve",
    reject: "Reject",
    acceptBusy: "Approving…",
    rejectBusy: "Rejecting…",
  };

  it.each([
    ["cut", cutWords("Cut", "Cutting…")],
    ["shorten", cutWords("Shorten", "Shortening…")],
    ["lower", cutWords("Lower", "Lowering…")],
    ["leave", approveWords],
    [null, approveWords],
  ] as const)("words a %s suggestion", (suggested_action, words) => {
    expect(pendingBarWords({ type: "remove", suggested_action })).toEqual(
      words,
    );
  });

  it("says Approve and Reject for a split and an exact range whatever they suggest", () => {
    expect(pendingBarWords({ type: "split", suggested_action: "cut" })).toEqual(
      approveWords,
    );
    expect(
      pendingBarWords({
        type: "remove",
        suggested_action: "shorten",
        exact_range: { intervals: [] } as never,
      }),
    ).toEqual(approveWords);
  });

  it("names the host or Editor requirement for exact range proposals", () => {
    expect(EXACT_RANGE_REVIEW_REASON).toBe(
      "Only the host or an Editor can review exact range proposals.",
    );
  });
});
