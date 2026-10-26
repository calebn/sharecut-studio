import { describe, expect, it } from "vitest";
import { VERBS } from "../system/verbs";
import { type ReviewKeyEvent, reviewActionFor } from "./reviewKeys";

const press = (
  key: string,
  extra: Partial<ReviewKeyEvent> = {},
): ReviewKeyEvent => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...extra,
});

describe("reviewActionFor", () => {
  it.each([
    ["Enter", {}, "verb"],
    ["x", {}, "keep"],
    ["X", {}, "keep"],
    ["Tab", {}, "later"],
    ["ArrowDown", {}, "later"],
    ["Tab", { shiftKey: true }, "previous"],
    ["ArrowUp", {}, "previous"],
    ["a", {}, "hearBefore"],
    ["b", {}, "hearAfter"],
    [" ", { shiftKey: true }, "hear"],
    ["Enter", { shiftKey: true }, "applyAll"],
    ["e", {}, "openInEdit"],
    ["c", {}, "comment"],
  ] as const)("%s %j is %s", (key, extra, action) => {
    expect(reviewActionFor(press(key, extra))).toBe(action);
  });

  it("leaves Space and unbound keys alone", () => {
    expect(reviewActionFor(press(" "))).toBeNull();
    expect(reviewActionFor(press("j"))).toBeNull();
    expect(reviewActionFor(press("l"))).toBeNull();
  });

  it("does not take chords with Mod or Alt", () => {
    expect(reviewActionFor(press("x", { metaKey: true }))).toBeNull();
    expect(reviewActionFor(press("a", { ctrlKey: true }))).toBeNull();
    expect(reviewActionFor(press("b", { altKey: true }))).toBeNull();
  });

  it("leaves keys typed into a field to the field", () => {
    const input = document.createElement("input");
    document.body.append(input);
    expect(reviewActionFor(press("x", { target: input }))).toBeNull();
    expect(
      reviewActionFor(press("Enter", { target: input, shiftKey: true })),
    ).toBeNull();
    input.remove();
  });

  it("treats Backspace and Delete as the verb only when the primary is Cut", () => {
    expect(reviewActionFor(press("Backspace"))).toBeNull();
    expect(
      reviewActionFor(press("Backspace"), { primary: "shorten" }),
    ).toBeNull();
    expect(reviewActionFor(press("Backspace"), { primary: "cut" })).toBe(
      "verb",
    );
    expect(reviewActionFor(press("Delete"), { primary: "cut" })).toBe("verb");
  });

  it("takes every key from the verb table", () => {
    const keys = (id: string) =>
      VERBS.find((verb) => verb.id === id)?.keys.map((k) => k.key) ?? [];
    expect(keys("keep")).toEqual(["X"]);
    expect(keys("later")).toEqual(["Tab", "ArrowDown"]);
    expect(keys("hearBefore")).toEqual(["A"]);
    expect(keys("hearAfter")).toEqual(["B"]);
    expect(keys("applyAll")).toEqual(["Enter"]);
  });
});
