import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("solo commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      project: minimalProject({
        tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
      }),
      soloTracks: {},
      statusAnnouncement: "",
    });
  });

  const announced = () => useDawStore.getState().statusAnnouncement;

  it("announces when solo turns on and when the last solo turns off", async () => {
    await execute("track.soloToggle", { trackId: "host" });
    expect(announced()).toBe("Solo on. Other tracks are silent for you only.");

    useDawStore.setState({ statusAnnouncement: "" });
    await execute("track.soloToggle", { trackId: "guest" });
    expect(announced()).toBe("");

    await execute("track.soloToggle", { trackId: "host" });
    expect(announced()).toBe("");
    await execute("track.soloToggle", { trackId: "guest" });
    expect(announced()).toBe("Solo off. Every track plays again.");
    expect(useDawStore.getState().soloTracks).toEqual({
      host: false,
      guest: false,
    });
  });

  it("clears every solo in one step and announces it", async () => {
    useDawStore.setState({ soloTracks: { host: true, guest: true } });
    expect(await execute("track.clearSolo")).toEqual({ status: "ok" });
    expect(useDawStore.getState().soloTracks).toEqual({});
    expect(announced()).toBe("Solo off. Every track plays again.");
  });

  it("explains why Clear solo does nothing when no track is soloed", async () => {
    useDawStore.setState({ soloTracks: { host: false } });
    expect(await execute("track.clearSolo", {}, { skipWhen: true })).toEqual({
      status: "disabled",
      reason: "No track is soloed",
    });
    expect(announced()).toBe("");
  });
});
