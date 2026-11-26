import { describe, expect, it } from "vitest";
import storiesSource from "./HostMcpDialog.stories.tsx?raw";
import dialogSource from "./HostMcpDialog.tsx?raw";
import {
  type ActivityState,
  activityClass,
  activityFromResponse,
  activityText,
} from "./hostMcp";
import helperSource from "./hostMcp.ts?raw";

const at = (ageAtReceipt: number): ActivityState => ({
  kind: "used",
  ageAtReceipt,
  receivedAt: 1000,
});

describe("activityFromResponse", () => {
  it("maps the three answers", () => {
    expect(
      activityFromResponse({ mounted: false, age_seconds: null }, 5),
    ).toEqual({ kind: "unavailable" });
    expect(
      activityFromResponse({ mounted: true, age_seconds: null }, 5),
    ).toEqual({ kind: "never" });
    expect(activityFromResponse({ mounted: true, age_seconds: 12 }, 5)).toEqual(
      { kind: "used", ageAtReceipt: 12, receivedAt: 5 },
    );
  });
});

describe("activityClass", () => {
  it("is recent through 600 s and stale after", () => {
    expect(activityClass(at(600), 1000)).toBe("recent");
    expect(activityClass(at(601), 1000)).toBe("stale");
    expect(activityClass({ kind: "never" }, 0)).toBe("never");
    expect(activityClass({ kind: "unknown" }, 0)).toBe("unknown");
    expect(activityClass({ kind: "unavailable" }, 0)).toBe("unavailable");
  });

  it("counts up from the age at receipt plus the time since", () => {
    expect(activityClass(at(590), 1000)).toBe("recent");
    expect(activityClass(at(590), 1000 + 9999)).toBe("recent");
    expect(activityClass(at(590), 1000 + 11_000)).toBe("stale");
  });
});

describe("activityText", () => {
  it.each([
    [0, "An app used this address just now."],
    [59, "An app used this address just now."],
    [60, "An app used this address 1 minute ago."],
    [119, "An app used this address 1 minute ago."],
    [120, "An app used this address 2 minutes ago."],
    [600, "An app used this address 10 minutes ago."],
    [601, "Last used 10 minutes ago."],
    [3599, "Last used 59 minutes ago."],
    [3600, "Last used 1 hour ago."],
    [86_399, "Last used 23 hours ago."],
    [86_400, "Last used 1 day ago."],
  ])("%i s reads %s", (age, expected) => {
    expect(activityText(at(age), 1000)).toBe(expected);
  });

  it("adds the time since the answer", () => {
    expect(activityText(at(50), 1000 + 130_000)).toBe(
      "An app used this address 3 minutes ago.",
    );
  });

  it("is null while unknown and never says connected", () => {
    expect(activityText({ kind: "unknown" }, 0)).toBeNull();
    for (const s of [
      { kind: "never" },
      { kind: "unavailable" },
      at(5),
      at(5000),
    ] as ActivityState[]) {
      expect(activityText(s, 1000)).not.toMatch(/connected|online|live/i);
    }
  });
});

describe("no app is named in the dialog", () => {
  it.each([
    ["HostMcpDialog.tsx", dialogSource],
    ["hostMcp.ts", helperSource],
    ["HostMcpDialog.stories.tsx", storiesSource],
  ])("%s", (_name, source) => {
    expect(source).not.toMatch(
      /cursor|claude|figma|chatgpt|codex|windsurf|vs ?code|mcp\.json/i,
    );
  });
});
