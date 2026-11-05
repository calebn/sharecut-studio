import { describe, expect, it } from "vitest";
import { hostStateOf, stageAvailable } from "./hostModels";

describe("stageAvailable", () => {
  it.each([
    ["host", ["record", "prepare", "edit", "review", "deliver"]],
    ["editor", ["edit", "review", "deliver"]],
    ["commenter", ["review"]],
    ["viewer", ["review"]],
  ] as const)("%s opens only its stages", (role, open) => {
    for (const stage of [
      "record",
      "prepare",
      "edit",
      "review",
      "deliver",
    ] as const) {
      expect(stageAvailable(stage, role)).toBe(open.includes(stage as never));
    }
  });
});

describe("hostStateOf", () => {
  const failure = { message: "No answer.", onRetry: () => {} };

  it("is loading with no project and no failure", () => {
    expect(hostStateOf(null, null)).toBe("loading");
  });

  it("is ready with a project and no failure", () => {
    expect(hostStateOf({}, null)).toBe("ready");
  });

  it("is error for a failure, with or without a project open", () => {
    expect(hostStateOf(null, failure)).toBe("error");
    expect(hostStateOf({}, failure)).toBe("error");
  });
});
