import { beforeEach, describe, expect, it } from "vitest";
import { makeRangeTarget } from "../edit/rangeSelection";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { useDawStore } from "./dawStore";

const rangeProject = minimalProject({
  tracks: [
    sampleTrack({ id: "a", label: "Speaker", range_media_seal: "seal" }),
  ],
  clips: {
    tracks: {
      a: [
        clipRow({
          track_id: "a",
          timeline_start: 0,
          timeline_end: 5,
          source_start: 0,
          source_end: 5,
        }),
      ],
    },
    clip_count: 1,
  },
});

describe("agentRangeScope", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/a.project.json", minimalProject());
    useDawStore.getState().setAgentRangeScope(["a"]);
  });

  it("clears when a range is armed", () => {
    useDawStore.getState().armRange({ start: 0, end: 1, trackIds: ["a"] });
    expect(useDawStore.getState().agentRangeScope).toBeNull();
  });

  it("clears when a range is armed or disarmed without a draft", () => {
    useDawStore.getState().setRangeArmed(true);
    expect(useDawStore.getState().agentRangeScope).toBeNull();
    useDawStore.getState().setAgentRangeScope(["a"]);
    useDawStore.getState().setRangeArmed(false);
    expect(useDawStore.getState().agentRangeScope).toBeNull();
  });

  it("clears when a range is committed", () => {
    const target = makeRangeTarget(rangeProject, [{ start: 0, end: 1 }], ["a"]);
    if (!target) throw new Error("fixture has no range target");
    useDawStore.getState().commitRange(target);
    expect(useDawStore.getState().agentRangeScope).toBeNull();
  });

  it("clears when another project opens", () => {
    useDawStore.getState().hydrate("/tmp/b.project.json", minimalProject());
    expect(useDawStore.getState().agentRangeScope).toBeNull();
  });

  it("survives the agent region going away", () => {
    useDawStore.getState().clearSessionRegion();
    expect(useDawStore.getState().agentRangeScope).toEqual(["a"]);
  });
});
