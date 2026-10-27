import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT, walkTsFiles } from "../test/sourceFiles";

const FAILURE_WORDING =
  /errorMessage|\b(?:reason|error|fail\w*|could not|couldn't|can't|cannot|unable|refus\w*|STALE\w*)\b/i;

/** Disabled-by-policy reasons ("Select a range"); a handler's own failure sets `announced`. */
const POLICY_REASONS = ["stage/dialogs/CommandPalette.tsx"];

/** Every `announceStatus(...)` call in production source, with its text. */
function calls(): { where: string; text: string }[] {
  const found: { where: string; text: string }[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    if (/\.(test|stories)\.tsx?$/.test(file)) continue;
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/announceStatus\(/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (depth > 0 && i < src.length) {
        if (src[i] === "(") depth += 1;
        else if (src[i] === ")") depth -= 1;
        i += 1;
      }
      const line = src.slice(0, m.index).split("\n").length;
      found.push({
        where: `${relative(SRC_ROOT, file)}:${line}`,
        text: src.slice(m.index, i),
      });
    }
  }
  return found;
}

describe("failure feedback", () => {
  it("announces every failure in the error tone, so plainError filters it", () => {
    const untoned = calls()
      .filter(
        (c) =>
          FAILURE_WORDING.test(c.text) &&
          !/tone:/.test(c.text) &&
          !POLICY_REASONS.some((p) => c.where.startsWith(p)),
      )
      .map((c) => c.where);
    expect(untoned).toEqual([]);
  });
});
