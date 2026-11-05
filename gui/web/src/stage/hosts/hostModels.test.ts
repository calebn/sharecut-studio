import { describe, expect, it } from "vitest";
import { hostStateOf } from "./hostModels";

const failure = { message: "No answer.", onRetry: () => {} };

describe("hostStateOf", () => {
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
