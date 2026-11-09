import { beforeEach, describe, expect, it } from "vitest";
import { makeRangeTarget } from "../edit/rangeSelection";
import { editFixtureProject, MIRA } from "../test/actionBarFixtures";
import { useDawStore } from "./dawStore";

const draft = { start: 12, end: 17, trackIds: [MIRA] };

describe("rangeDraft", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/a.project.json", editFixtureProject());
    useDawStore.getState().armRange(draft);
  });

  it("arms with the draft", () => {
    expect(useDawStore.getState().rangeArmed).toBe(true);
    expect(useDawStore.getState().rangeDraft).toEqual(draft);
  });

  it("replaces the draft while armed", () => {
    useDawStore.getState().setRangeDraft({ ...draft, end: 20 });
    expect(useDawStore.getState().rangeDraft).toEqual({ ...draft, end: 20 });
    expect(useDawStore.getState().rangeArmed).toBe(true);
  });

  it("clears when a range is disarmed", () => {
    useDawStore.getState().setRangeArmed(false);
    expect(useDawStore.getState().rangeDraft).toBeNull();
    expect(useDawStore.getState().rangeArmed).toBe(false);
  });

  it("clears when another project opens", () => {
    useDawStore.getState().hydrate("/tmp/b.project.json", editFixtureProject());
    expect(useDawStore.getState().rangeDraft).toBeNull();
  });

  it("survives clearing the agent region", () => {
    useDawStore.getState().clearSessionRegion();
    expect(useDawStore.getState().rangeDraft).toEqual(draft);
  });

  it("commits to a range selection with the Inspector open and no draft", () => {
    const project = useDawStore.getState().project!;
    const target = makeRangeTarget(project, [draft], [MIRA])!;
    useDawStore.getState().commitRange(target);
    const s = useDawStore.getState();
    expect(s.selection).toEqual({ kind: "range", target });
    expect(s.inspectorKey).toBe("range");
    expect(s.rangeArmed).toBe(false);
    expect(s.rangeDraft).toBeNull();
  });

  it("drops the draft and the arm when a range selection is set", () => {
    const project = useDawStore.getState().project!;
    const target = makeRangeTarget(project, [draft], [MIRA])!;
    useDawStore.getState().setSelection({ kind: "range", target });
    expect(useDawStore.getState().rangeDraft).toBeNull();
    expect(useDawStore.getState().rangeArmed).toBe(false);
  });

  it("keeps the draft and the arm for a non-range selection", () => {
    useDawStore.getState().setSelection(null);
    expect(useDawStore.getState().rangeDraft).toEqual(draft);
    expect(useDawStore.getState().rangeArmed).toBe(true);
  });

  it("drops the draft and the arm when a remote range selection is adopted", () => {
    const project = useDawStore.getState().project!;
    const target = makeRangeTarget(project, [draft], [MIRA])!;
    useDawStore.getState().adoptRemoteSelection({ kind: "range", target });
    expect(useDawStore.getState().rangeDraft).toBeNull();
    expect(useDawStore.getState().rangeArmed).toBe(false);
  });

  it("leaves the undo stack alone across arm, edit and disarm", () => {
    const before = useDawStore.getState().project?.history;
    useDawStore.getState().setRangeDraft({ ...draft, start: 13 });
    useDawStore.getState().setRangeArmed(false);
    expect(useDawStore.getState().project?.history).toBe(before);
  });
});
