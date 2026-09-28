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
});
