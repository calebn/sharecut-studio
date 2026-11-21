import { expect, it } from "vitest";
import { keptLine } from "./keptLine";

it("says when it sends by why the host cannot be reached", () => {
  expect(keptLine("Comment", "host")).toBe(
    "Comment kept. It sends when the host is back.",
  );
  expect(keptLine("Comment", "device")).toBe(
    "Comment kept. It sends when you're back online.",
  );
  expect(keptLine("Reply", null)).toBe(
    "Reply kept. It sends when you can reach the host.",
  );
});
