import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rosterFromList } from "../presence/roster";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sessionClient } from "../test/fixtures";
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

describe("applyPresenceFrame: out-of-band Presence ordering", () => {
  const a = sessionClient({ client_id: "a" });
  const b = sessionClient({ client_id: "b" });

  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    useDawStore.setState({
      sessionClients: rosterFromList([a, b]),
      sessionRosterVersion: 5,
    });
  });

  afterEach(() => {
    useDawStore.setState({ sessionRosterVersion: 0 });
  });

  it("drops a full Presence older than the local roster version", () => {
    applyPresenceFrame({ type: "Presence", clients: [a], roster_version: 4 });
    const state = useDawStore.getState();
    expect(state.sessionRosterVersion).toBe(5);
    expect(Object.keys(state.sessionClients).sort()).toEqual(["a", "b"]);
  });

  it("applies a full Presence at the equal version", () => {
    applyPresenceFrame({ type: "Presence", clients: [a], roster_version: 5 });
    const state = useDawStore.getState();
    expect(state.sessionRosterVersion).toBe(5);
    expect(Object.keys(state.sessionClients)).toEqual(["a"]);
  });

  it("applies a full Presence at a newer version", () => {
    applyPresenceFrame({ type: "Presence", clients: [a], roster_version: 6 });
    const state = useDawStore.getState();
    expect(state.sessionRosterVersion).toBe(6);
    expect(Object.keys(state.sessionClients)).toEqual(["a"]);
  });

  it("applies a full Presence with no roster_version", () => {
    applyPresenceFrame({ type: "Presence", clients: [a] });
    const state = useDawStore.getState();
    expect(Object.keys(state.sessionClients)).toEqual(["a"]);
  });

  it("a hello Snapshot always resets the version, even if older", () => {
    applyPresenceFrame({
      type: "Snapshot",
      snapshot: { clients: [a], roster_version: 1 } as never,
    });
    const state = useDawStore.getState();
    expect(state.sessionRosterVersion).toBe(1);
    expect(Object.keys(state.sessionClients)).toEqual(["a"]);
  });
});
