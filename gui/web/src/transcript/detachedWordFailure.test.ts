import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import {
  detachedWordFailure,
  isDetachedWordFailureMoot,
  reportDetachedWordFailure,
} from "./detachedWordFailure";

describe("detachedWordFailure", () => {
  beforeEach(() => {
    useDawStore.setState({ transcriptInlineEditFailure: null });
  });

  it("formats a failed text fix", () => {
    const result = detachedWordFailure({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      word: { text: "hello" },
      action: "fix",
      failure: new Error("boom"),
    });
    expect(result.message).toBe("Could not fix “hello”: boom");
    expect(result.originalText).toBe("hello");
  });

  it("formats a failed Suppress / Ignore toggle as an update", () => {
    const result = detachedWordFailure({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      word: { text: "hello" },
      action: "suppressed",
      failure: new Error("boom"),
    });
    expect(result.message).toBe("Could not update “hello”: boom");
  });

  it("records the flag and its pre-action value for a failed suppress", () => {
    const result = detachedWordFailure({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      word: { text: "hello", suppressed: false },
      action: "suppressed",
      failure: new Error("boom"),
    });
    expect(result.flag).toEqual({ name: "suppressed", was: false });
  });

  it("records the flag and its pre-action value for a failed ignore", () => {
    const result = detachedWordFailure({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      word: { text: "hello", ignored: true },
      action: "ignored",
      failure: new Error("boom"),
    });
    expect(result.flag).toEqual({ name: "ignored", was: true });
  });

  it("has no flag for a failed text fix", () => {
    const result = detachedWordFailure({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      word: { text: "hello" },
      action: "fix",
      failure: new Error("boom"),
    });
    expect(result).not.toHaveProperty("flag");
  });

  it("reportDetachedWordFailure writes it to the DAW store", () => {
    const input = {
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      word: { text: "hello" },
      action: "fix" as const,
      failure: new Error("boom"),
    };
    reportDetachedWordFailure(input);
    expect(useDawStore.getState().transcriptInlineEditFailure).toEqual(
      detachedWordFailure(input),
    );
  });

  describe("isDetachedWordFailureMoot", () => {
    const failure = detachedWordFailure({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      word: { text: "hello" },
      action: "fix",
      failure: new Error("boom"),
    });

    it("is moot for a different project", () => {
      expect(
        isDetachedWordFailureMoot(failure, "/tmp/other", { text: "hello" }),
      ).toBe(true);
    });

    it("is moot when the word is gone", () => {
      expect(isDetachedWordFailureMoot(failure, "/tmp/ep", null)).toBe(true);
    });

    it("is moot when the word's text changed", () => {
      expect(
        isDetachedWordFailureMoot(failure, "/tmp/ep", { text: "Hello" }),
      ).toBe(true);
    });

    it("is not moot for the same project and unchanged text", () => {
      expect(
        isDetachedWordFailureMoot(failure, "/tmp/ep", { text: "hello" }),
      ).toBe(false);
    });
  });

  describe("isDetachedWordFailureMoot for a failed flag toggle", () => {
    const flagFailure = detachedWordFailure({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      word: { text: "hello", suppressed: false },
      action: "suppressed",
      failure: new Error("boom"),
    });

    it("is moot once the flag flips (a retry succeeded)", () => {
      expect(
        isDetachedWordFailureMoot(flagFailure, "/tmp/ep", {
          text: "hello",
          suppressed: true,
        }),
      ).toBe(true);
    });

    it("is not moot while the flag is unchanged", () => {
      expect(
        isDetachedWordFailureMoot(flagFailure, "/tmp/ep", {
          text: "hello",
          suppressed: false,
        }),
      ).toBe(false);
    });

    it("is not moot when an unrelated flag changes", () => {
      expect(
        isDetachedWordFailureMoot(flagFailure, "/tmp/ep", {
          text: "hello",
          suppressed: false,
          ignored: true,
        }),
      ).toBe(false);
    });

    it("a text-fix failure (no flag) is unaffected by flag changes", () => {
      const textFailure = detachedWordFailure({
        projectPath: "/tmp/ep",
        trackId: "host",
        wordIndex: 0,
        word: { text: "hello" },
        action: "fix",
        failure: new Error("boom"),
      });
      expect(
        isDetachedWordFailureMoot(textFailure, "/tmp/ep", {
          text: "hello",
          suppressed: true,
        }),
      ).toBe(false);
    });
  });
});
