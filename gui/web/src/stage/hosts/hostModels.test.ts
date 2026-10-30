import { describe, expect, it } from "vitest";
import { stageAvailable } from "./hostModels";

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
