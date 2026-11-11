import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sessionClient, sessionRoster } from "../test/fixtures";
import { COMMANDS } from "./catalog";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const PEER = sessionClient({
  client_id: "rosa",
  meta: {
    display_name: "Rosa",
    color_index: 2,
    ui: { tab: "impact" },
    transport: { playhead_sec: 40, playing: false, rate: 1 },
  },
  playhead_sec: 40,
});

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({
    project: minimalProject({ timeline_duration_sec: 100 }),
    projectPath: "/tmp/ep",
    guestMode: null,
    stage: "edit",
    playheadSec: 5,
    followingClientId: null,
    sessionClients: sessionRoster([PEER]),
  });
});

afterEach(() => {
  clearRegisteredCommands();
  useDawStore.setState({
    followingClientId: null,
    sessionClients: sessionRoster([]),
    playheadSec: 0,
  });
});

describe("presence.goTo", () => {
  it("is a session command that ends an earlier follow", () => {
    expect(COMMANDS["presence.goTo"].breaksFollow).toBe(true);
  });

  it("opens their stage and moves the playhead once, without following", async () => {
    expect(await execute("presence.goTo", { clientId: "rosa" })).toEqual({
      status: "ok",
    });
    const s = useDawStore.getState();
    expect(s.stage).toBe("review");
    expect(s.playheadSec).toBe(40);
    expect(s.followingClientId).toBeNull();
  });

  it("stops a follow that was running", async () => {
    useDawStore.setState({ followingClientId: "rosa" });
    await execute("presence.goTo", { clientId: "rosa" });
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("moves only the playhead when they share the stage", async () => {
    useDawStore.setState({ stage: "review" });
    await execute("presence.goTo", { clientId: "rosa" });
    expect(useDawStore.getState().stage).toBe("review");
    expect(useDawStore.getState().playheadSec).toBe(40);
  });

  it("refuses a person who is not here", async () => {
    expect((await execute("presence.goTo", { clientId: "gone" })).status).toBe(
      "disabled",
    );
    expect((await execute("presence.goTo", {})).status).toBe("disabled");
    expect(useDawStore.getState().playheadSec).toBe(5);
  });

  it("does not follow a host to a stage this link cannot open", async () => {
    useDawStore.setState({
      guestMode: "view",
      stage: "review",
      sessionClients: sessionRoster([
        { ...PEER, meta: { ...PEER.meta, ui: { tab: "pipeline" } } },
      ]),
    });
    const result = await execute("presence.goTo", { clientId: "rosa" });
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().stage).toBe("review");
    expect(useDawStore.getState().playheadSec).toBe(5);
  });
});
