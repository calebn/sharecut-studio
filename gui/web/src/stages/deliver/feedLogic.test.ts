import { describe, expect, it } from "vitest";
import { CHECKS, PENDING, READY } from "./feedFixture";
import {
  driftCopy,
  formatDuration,
  formatStamp,
  markOf,
  readiness,
  readinessTitle,
  sortFindings,
  writeLine,
  xmlLines,
} from "./feedLogic";

describe("readiness", () => {
  it("is ready when only optional findings remain", () => {
    expect(readiness(READY.findings)).toEqual({ kind: "ready" });
    expect(readinessTitle({ kind: "ready" })).toBe("Ready to publish");
  });

  it("counts blockers and warnings and leads with the blocker", () => {
    const state = readiness(CHECKS.findings);
    expect(state).toMatchObject({ kind: "open", left: 2, blockers: 1 });
    expect(state.kind === "open" && state.first.id).toBe("needs-hosting");
    expect(readinessTitle(state)).toBe("2 things left");
  });

  it("uses the singular for one thing", () => {
    const one = PENDING.findings.filter((f) => f.id !== "needs-intro");
    expect(readinessTitle(readiness(one))).toBe("1 thing left");
  });
});

describe("sortFindings", () => {
  it("orders blockers, warnings, then info without mutating", () => {
    const ids = sortFindings(CHECKS.findings).map((f) => f.severity);
    expect(ids).toEqual(["blocker", "warn", "info", "info", "info"]);
  });
});

describe("writeLine", () => {
  it("offers Write when the file is stale and nothing blocks", () => {
    expect(writeLine({ ...READY, file: "stale" })).toEqual({
      status: "Feed file is out of date.",
      action: "Write",
      blockedReason: undefined,
    });
  });

  it("offers nothing when the file is current", () => {
    expect(writeLine(READY).action).toBeNull();
  });

  it("names the blocker as the reason", () => {
    expect(writeLine(CHECKS).blockedReason).toBe("Fix the blocker first.");
  });
});

describe("marks and drift", () => {
  it("marks auto and agent values, never a person's pin", () => {
    expect(markOf({ kind: "derived", rule: "x" })).toBe("Auto");
    expect(markOf({ kind: "pinned", by: "agent", drifted: null })).toBe(
      "Agent",
    );
    expect(markOf({ kind: "pinned", by: "person", drifted: null })).toBeNull();
  });

  it("says which source changed", () => {
    expect(driftCopy("chapters")).toBe(
      "Chapters changed since you edited this",
    );
  });
});

describe("formatting", () => {
  it("rounds a duration to minutes and adds hours", () => {
    expect(formatDuration(3120)).toBe("52 min");
    expect(formatDuration(3900)).toBe("1 hr 5 min");
    expect(formatDuration(7200)).toBe("2 hr");
  });

  it("stamps chapters without tenths", () => {
    expect(formatStamp(312.4)).toBe("5:12");
    expect(formatStamp(3909)).toBe("1:05:09");
  });

  it("splits xml into markup and content", () => {
    expect(xmlLines("<a>hi</a>\n<b/>")).toEqual([
      {
        id: 0,
        segments: [
          { id: 0, text: "<a>", tag: true },
          { id: 1, text: "hi", tag: false },
          { id: 2, text: "</a>", tag: true },
        ],
      },
      { id: 1, segments: [{ id: 0, text: "<b/>", tag: true }] },
    ]);
  });
});
