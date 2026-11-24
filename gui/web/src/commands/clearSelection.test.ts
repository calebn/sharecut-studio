import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/clear.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    stage: "edit",
    selection: { kind: "clip", id: "c1", trackId: "host" } as never,
    rangeArmed: true,
    afterCut: { words: "gone" } as never,
  });
  useDawStore.getState().setInspectorOpen(true);
});

describe("edit.clearSelection", () => {
  it("clears the armed range, the selection, the cut hint and the Inspector in one call from the bar", async () => {
    await execute("edit.clearSelection", { from: "bar" }, { skipWhen: true });
    const s = useDawStore.getState();
    expect(s.rangeArmed).toBe(false);
    expect(s.selection).toBeNull();
    expect(s.afterCut).toBeNull();
    expect(s.inspectorKey).toBeNull();
  });

  it("keeps the Esc ladder without a source", async () => {
    await execute("edit.clearSelection", {}, { skipWhen: true });
    expect(useDawStore.getState().rangeArmed).toBe(false);
    expect(useDawStore.getState().selection).not.toBeNull();
    await execute("edit.clearSelection", {}, { skipWhen: true });
    expect(useDawStore.getState().inspectorKey).toBeNull();
    expect(useDawStore.getState().selection).not.toBeNull();
    await execute("edit.clearSelection", {}, { skipWhen: true });
    expect(useDawStore.getState().selection).toBeNull();
  });
});
