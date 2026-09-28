import { beforeEach, describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";
import { resetPublishKeyForTests, selectPublishKey } from "./publishKey";

describe("selectPublishKey", () => {
  beforeEach(() => {
    resetPublishKeyForTests();
    useDawStore.getState().hydrate("/tmp/ep.json", minimalProject());
    useDawStore.setState({
      auditionMode: "mix",
      sessionRegion: null,
      viewerMute: {},
      soloTracks: {},
      isPlaying: false,
    });
  });

  it("matches a JSON.stringify of exactly the published fields, in order", () => {
    useDawStore.setState({
      auditionMode: "fx",
      sessionRegion: { start_sec: 1, end_sec: 2 },
      viewerMute: { host: true },
      soloTracks: { guest: true },
      isPlaying: true,
    });
    const key = selectPublishKey(useDawStore.getState());
    expect(key).toBe(
      JSON.stringify({
        auditionMode: useDawStore.getState().auditionMode,
        selection: useDawStore.getState().selection,
        sessionRegion: useDawStore.getState().sessionRegion,
        viewerMute: useDawStore.getState().viewerMute,
        soloTracks: useDawStore.getState().soloTracks,
        isPlaying: useDawStore.getState().isPlaying,
      }),
    );
  });

  it("is stable (same string reference) across playhead, project and roster changes", () => {
    const first = selectPublishKey(useDawStore.getState());
    useDawStore.setState({
      playheadSec: 12,
      sessionClients: [{ client_id: "a", role: "viewer" }],
    });
    useDawStore.getState().setProject(minimalProject({ tracks: [] }));
    const second = selectPublishKey(useDawStore.getState());
    expect(second).toBe(first);
  });

  it("changes when a published field changes", () => {
    const first = selectPublishKey(useDawStore.getState());
    useDawStore.setState({ auditionMode: "fx" });
    const second = selectPublishKey(useDawStore.getState());
    expect(second).not.toBe(first);
    expect(second).not.toEqual(first);
  });
});
