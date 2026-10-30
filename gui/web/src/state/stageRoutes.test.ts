import { describe, expect, it } from "vitest";
import type { PresenceTab } from "../types/session";
import { STAGE_IDS, type StageId, type StageRole } from "../types/stage";
import {
  type LandingInput,
  landingStage,
  mobileModeForStage,
  STAGE_FOR_TAB,
  stageRoleOf,
  stagesForRole,
  tabForStage,
  wireTabOf,
} from "./stageRoutes";

const TABS: PresenceTab[] = [
  "transcript",
  "history",
  "impact",
  "tighten",
  "pipeline",
  "comments",
];

const host = (over: Partial<LandingInput> = {}): LandingInput => ({
  role: "host",
  trackCount: 2,
  jobBusy: false,
  pendingReviewCount: 0,
  lastStage: null,
  ...over,
});

describe("stagesForRole", () => {
  it.each<[StageRole, StageId[]]>([
    ["host", [...STAGE_IDS]],
    ["editor", ["edit", "review"]],
    ["commenter", ["review"]],
    ["viewer", ["review"]],
  ])("%s may open %j", (role, stages) => {
    expect(stagesForRole(role)).toEqual(stages);
  });

  it("maps a share mode to a role", () => {
    expect(stageRoleOf(null)).toBe("host");
    expect(stageRoleOf("edit")).toBe("editor");
    expect(stageRoleOf("comment")).toBe("commenter");
    expect(stageRoleOf("view")).toBe("viewer");
    expect(stageRoleOf("none")).toBe("viewer");
  });
});

describe("landingStage", () => {
  it("opens a guest on the stage their role allows", () => {
    expect(landingStage(host({ role: "viewer", lastStage: "edit" }))).toBe(
      "review",
    );
    expect(landingStage(host({ role: "commenter", trackCount: 0 }))).toBe(
      "review",
    );
    expect(landingStage(host({ role: "editor", pendingReviewCount: 3 }))).toBe(
      "edit",
    );
  });

  it("opens an empty project on Prepare", () => {
    expect(landingStage(host({ trackCount: 0, pendingReviewCount: 4 }))).toBe(
      "prepare",
    );
  });

  it("opens on Prepare while a job runs, ahead of Review", () => {
    expect(landingStage(host({ jobBusy: true, pendingReviewCount: 4 }))).toBe(
      "prepare",
    );
  });

  it("opens on Review when anything is undecided", () => {
    expect(
      landingStage(host({ pendingReviewCount: 1, lastStage: "edit" })),
    ).toBe("review");
  });

  it("falls back to the stage last used, then Edit", () => {
    expect(landingStage(host({ lastStage: "deliver" }))).toBe("deliver");
    expect(landingStage(host({ lastStage: "record" }))).toBe("record");
    expect(landingStage(host())).toBe("edit");
  });
});

describe("tab and stage mapping", () => {
  it("places every legacy tab", () => {
    expect(STAGE_FOR_TAB).toEqual({
      transcript: { stage: "edit" },
      history: { stage: "edit", sheet: "history" },
      impact: { stage: "review", section: "queue" },
      tighten: { stage: "review", section: "queue" },
      comments: { stage: "review", section: "queue" },
      pipeline: { stage: "prepare" },
    });
  });

  it("round trips every tab that has a stage of its own", () => {
    for (const tab of TABS) {
      const { stage, sheet } = STAGE_FOR_TAB[tab];
      const back = tabForStage(stage);
      const expected = tab === "tighten" || tab === "comments" ? "impact" : tab;
      expect(back).toBe(sheet ? "transcript" : expected);
    }
  });

  it("gives Record and Deliver no tab", () => {
    expect(tabForStage("record")).toBeNull();
    expect(tabForStage("deliver", "comments")).toBeNull();
  });

  it("publishes the Queue as impact, or comments for a guest", () => {
    expect(tabForStage("review")).toBe("impact");
    expect(tabForStage("review", "comments")).toBe("comments");
  });

  it("keeps the wire name impact for the Queue section only", () => {
    expect(wireTabOf("queue")).toBe("impact");
  });

  it("derives the legacy phone mode", () => {
    expect(mobileModeForStage("edit", "lanes")).toBe("timeline");
    expect(mobileModeForStage("edit", "text")).toBe("text");
    expect(mobileModeForStage("review", "lanes")).toBe("listen");
    for (const stage of ["record", "prepare", "deliver"] as const) {
      expect(mobileModeForStage(stage, "text")).toBe("more");
    }
  });
});
