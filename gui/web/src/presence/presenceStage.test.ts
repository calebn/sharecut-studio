import { describe, expect, it } from "vitest";
import { STAGE_FOR_TAB } from "../state/stageRoutes";
import { sessionClient } from "../test/fixtures";
import type { PresenceTab } from "../types/session";
import { clientStage, presenceStage } from "./presenceStage";

function at(tab: PresenceTab | undefined) {
  return sessionClient({ meta: { ui: tab ? { tab } : {} } });
}

describe("presenceStage", () => {
  it.each(Object.keys(STAGE_FOR_TAB) as PresenceTab[])(
    "badges %s with the stage planFollowUi would open",
    (tab) => {
      const stage = STAGE_FOR_TAB[tab].stage;
      const viewer = stage === "deliver" ? "record" : "deliver";
      expect(presenceStage(at(tab), viewer)).toBe(stage);
    },
  );

  it("gives no badge for the viewer's own stage", () => {
    expect(presenceStage(at("transcript"), "edit")).toBeNull();
    expect(presenceStage(at("impact"), "review")).toBeNull();
  });

  it("gives no badge without a tab or for a tab it does not know", () => {
    expect(presenceStage(at(undefined), "edit")).toBeNull();
    expect(presenceStage(sessionClient({ meta: null }), "edit")).toBeNull();
    expect(
      presenceStage(at("sidebar" as unknown as PresenceTab), "edit"),
    ).toBeNull();
  });
});

describe("clientStage", () => {
  it("names the stage whatever the viewer has open", () => {
    expect(clientStage(at("transcript"))).toBe("edit");
    expect(clientStage(at("comments"))).toBe("review");
    expect(clientStage(at(undefined))).toBeNull();
  });
});
