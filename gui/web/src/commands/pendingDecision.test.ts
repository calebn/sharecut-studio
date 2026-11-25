import { describe, expect, it } from "vitest";
import { pendingOffersCut } from "../utils/pendingOffersCut";
import {
  actionBarOwnsPendingVerbs,
  decideThroughSheet,
  pendingAcceptRoute,
  pendingBarWords,
  pendingCutWords,
  registerPendingDecider,
} from "./pendingDecision";

describe("actionBarOwnsPendingVerbs", () => {
  const exact = { exact_range: { intervals: [] } as never };

  it.each([
    ["a cut suggestion", {}],
    ["a split", { type: "split" }],
    ["a suggestion to leave alone", { suggested_action: "leave" }],
    ["an exact range", exact],
  ])("is true for %s the viewer may review", (_name, edit) => {
    expect(actionBarOwnsPendingVerbs(edit as never, true)).toBe(true);
  });

  it("holds an exact range for a viewer who may not review it, so the bar says why", () => {
    expect(actionBarOwnsPendingVerbs(exact, false)).toBe(true);
  });

  it.each([
    ["a cut suggestion", {}],
    ["a split", { type: "split" }],
  ])("is false for %s the viewer may not review", (_name, edit) => {
    expect(actionBarOwnsPendingVerbs(edit as never, false)).toBe(false);
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
    ["cut", "Cut"],
    ["shorten", "Shorten"],
    ["lower", "Lower"],
    [null, "Cut"],
  ] as const)("words %s as %s", (suggested_action, label) => {
    expect(pendingCutWords({ suggested_action })).toEqual({ label });
  });
});

describe("the sheet decider", () => {
  it("answers only for the edit the open sheet shows", async () => {
    const release = registerPendingDecider("a", async () => "busy");
    expect(await decideThroughSheet("b", "approve")).toBeNull();
    expect(await decideThroughSheet("a", "approve")).toEqual({
      status: "disabled",
      reason: "busy",
    });
    release();
    expect(await decideThroughSheet("a", "approve")).toBeNull();
  });
});

describe("pendingBarWords", () => {
  const cutWords = (accept: string) => ({ accept, reject: "Keep" });
  const approveWords = {
    accept: "Approve",
    reject: "Reject",
  };

  const leaveWords = {
    accept: "Leave",
    reject: "Reject",
  };

  it.each([
    ["cut", cutWords("Cut")],
    ["shorten", cutWords("Shorten")],
    ["lower", cutWords("Lower")],
    ["leave", leaveWords],
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

  it("says Leave for a split and an exact range that suggest leaving", () => {
    expect(
      pendingBarWords({ type: "split", suggested_action: "leave" }),
    ).toEqual(leaveWords);
    expect(
      pendingBarWords({
        type: "remove",
        suggested_action: "leave",
        exact_range: { intervals: [] } as never,
      }),
    ).toEqual(leaveWords);
  });
});

describe("the accept route and its words", () => {
  const types = ["remove", "split"] as const;
  const ranges = [undefined, { intervals: [] } as never] as const;
  const actions = [
    undefined,
    null,
    "cut",
    "shorten",
    "lower",
    "leave",
  ] as const;
  const rows = types.flatMap((type) =>
    ranges.flatMap((exact_range) =>
      actions.map((suggested_action) => ({
        type,
        exact_range,
        suggested_action,
      })),
    ),
  );

  it.each(rows)("words and routes %o together", (edit) => {
    const route = pendingAcceptRoute(edit);
    const { accept } = pendingBarWords(edit);
    if (accept === "Approve") expect(route).toBe("cut");
    if (route === "own") expect(accept).not.toBe("Approve");
    expect(accept === "Leave").toBe(edit.suggested_action === "leave");
    if (edit.suggested_action === "leave") expect(route).toBe("own");
  });

  it.each([
    ["leave", "own"],
    ["shorten", "own"],
    ["lower", "own"],
    ["cut", "cut"],
    [null, "cut"],
  ] as const)("routes a %s suggestion to %s", (suggested_action, route) => {
    expect(pendingAcceptRoute({ type: "remove", suggested_action })).toBe(
      route,
    );
  });

  it("sends a split or an exact range that suggests shortening to the cut route", () => {
    expect(
      pendingAcceptRoute({ type: "split", suggested_action: "shorten" }),
    ).toBe("cut");
    expect(
      pendingAcceptRoute({
        type: "remove",
        suggested_action: "shorten",
        exact_range: { intervals: [] } as never,
      }),
    ).toBe("cut");
  });
});
