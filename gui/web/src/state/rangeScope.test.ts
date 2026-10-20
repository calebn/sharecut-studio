import { beforeEach, describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

describe("rangeScopeTrackIds", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/a.project.json", minimalProject());
    useDawStore.getState().setRangeScopeTrackIds(["a"]);
  });

  it("clears when a range is armed", () => {
    useDawStore.getState().setRangeArmed(true);
    expect(useDawStore.getState().rangeScopeTrackIds).toBeNull();
  });

  it("clears when a range is disarmed", () => {
    useDawStore.getState().setRangeArmed(false);
    expect(useDawStore.getState().rangeScopeTrackIds).toBeNull();
  });

  it("clears when another project opens", () => {
    useDawStore.getState().hydrate("/tmp/b.project.json", minimalProject());
    expect(useDawStore.getState().rangeScopeTrackIds).toBeNull();
  });

  it("survives clearing the agent region", () => {
    useDawStore.getState().clearSessionRegion();
    expect(useDawStore.getState().rangeScopeTrackIds).toEqual(["a"]);
  });
});
