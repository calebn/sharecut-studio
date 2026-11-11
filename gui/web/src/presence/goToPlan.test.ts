import { describe, expect, it } from "vitest";
import { sessionClient } from "../test/fixtures";
import type { PresenceUi } from "../types/session";
import type { FollowUiCaps } from "./followSync";
import { planGoTo } from "./goToPlan";

const HOST: FollowUiCaps = {
  guestShare: false,
  breakpoint: "desktop",
  role: "host",
};

function at(ui: PresenceUi | null, playhead?: number) {
  return sessionClient({
    meta: {
      ui,
      ...(playhead === undefined
        ? {}
        : { transport: { playhead_sec: playhead, playing: false, rate: 1 } }),
    },
  });
}

describe("planGoTo", () => {
  it("moves when they are in another stage", () => {
    const plan = planGoTo(at({ tab: "impact" }), HOST, 100, "edit");
    expect(plan?.apply.stage?.stage).toBe("review");
    expect(plan?.moves).toBe(true);
  });

  it("does not move for the same stage with no playhead", () => {
    expect(planGoTo(at({ tab: "transcript" }), HOST, 100, "edit")?.moves).toBe(
      false,
    );
  });

  it("moves for the same stage when they have a playhead", () => {
    const plan = planGoTo(at({ tab: "transcript" }, 12), HOST, 100, "edit");
    expect(plan).toMatchObject({ sec: 12, moves: true });
  });

  it("clamps their playhead to the episode", () => {
    expect(
      planGoTo(at({ tab: "transcript" }, 500), HOST, 100, "edit")?.sec,
    ).toBe(100);
  });

  it("is null for a stage this link cannot open", () => {
    const viewer: FollowUiCaps = {
      guestShare: true,
      breakpoint: "desktop",
      role: "viewer",
    };
    expect(
      planGoTo(at({ tab: "pipeline" }, 4), viewer, 100, "review"),
    ).toBeNull();
  });
});
