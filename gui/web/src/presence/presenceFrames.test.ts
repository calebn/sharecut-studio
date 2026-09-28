import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { applyPresenceFrame, isPresenceOnlyFrame } from "./presenceFrames";

describe("PresenceResync", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
  });

  it("applyPresenceFrame requests a resync", () => {
    expect(applyPresenceFrame({ type: "PresenceResync" })).toBe(true);
  });

  it("isPresenceOnlyFrame is true for PresenceResync", () => {
    expect(isPresenceOnlyFrame({ type: "PresenceResync" })).toBe(true);
  });
});
