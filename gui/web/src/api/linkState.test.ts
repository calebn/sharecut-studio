import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDeadLinkAnswer,
  isLinkEnded,
  markLinkEnded,
  reportLinkDoubt,
  subscribeLinkDoubt,
} from "./linkState";

describe("isDeadLinkAnswer", () => {
  it("is true only for a 404 that carries the dead-link code", () => {
    expect(isDeadLinkAnswer(404, "share_not_found")).toBe(true);
  });

  it.each([
    [404, null],
    [404, "comment_not_found"],
    [404, "project_not_found"],
    [403, "share_not_found"],
    [410, "share_not_found"],
    [500, "share_not_found"],
    [502, null],
    [503, "project_busy"],
    [429, null],
    [200, null],
    [null, "share_not_found"],
    [null, null],
  ])("is false for status %s with code %s", (status, code) => {
    expect(isDeadLinkAnswer(status, code)).toBe(false);
  });
});

describe("link doubt", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tells every subscriber which link was doubted, until one unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeLinkDoubt(first);
    const stopSecond = subscribeLinkDoubt(second);
    reportLinkDoubt("a");
    stopFirst();
    reportLinkDoubt("b");
    stopSecond();
    expect(first.mock.calls).toEqual([["a"]]);
    expect(second.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("does nothing, and keeps nothing, with no subscriber", () => {
    reportLinkDoubt("nobody");
    const late = vi.fn();
    const stop = subscribeLinkDoubt(late);
    expect(late).not.toHaveBeenCalled();
    stop();
  });

  it("does not let one subscriber's failure reach the reporter or the others", () => {
    const after = vi.fn();
    const stopBad = subscribeLinkDoubt(() => {
      throw new Error("listener broke");
    });
    const stopAfter = subscribeLinkDoubt(after);
    expect(() => reportLinkDoubt("a")).not.toThrow();
    expect(after).toHaveBeenCalledWith("a");
    stopBad();
    stopAfter();
  });
});

describe("an ended link", () => {
  it("is remembered for the page's life, link by link", () => {
    expect(isLinkEnded("alive-1")).toBe(false);
    markLinkEnded("dead-1");
    expect(isLinkEnded("dead-1")).toBe(true);
    expect(isLinkEnded("alive-1")).toBe(false);
  });
});
