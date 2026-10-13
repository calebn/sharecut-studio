import { describe, expect, it } from "vitest";
import type { TimelineComment } from "../types/project";
import { commentTimeLabel } from "./commentTimeLabel";

function comment(start: number, end?: number): TimelineComment {
  return {
    timeline_start: start,
    timeline_end: end,
  } as unknown as TimelineComment;
}

describe("commentTimeLabel", () => {
  it("labels an instant comment", () => {
    expect(commentTimeLabel(comment(65.4))).toBe("1:05");
  });

  it("labels a span", () => {
    expect(commentTimeLabel(comment(10, 20))).toBe("0:10–0:20");
  });

  it("rounds to the second it shows, so 59.9995 s reads as the minute the transport shows", () => {
    expect(commentTimeLabel(comment(59.9995))).toBe("1:00");
    expect(commentTimeLabel(comment(59.4, 119.6))).toBe("0:59–2:00");
  });
});
