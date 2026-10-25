import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { listRegisteredIds } from "../commands/execute";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { EpisodeHydrator } from "./EpisodeHydrator";
import { recordRoom, selections } from "./episodeFixture";

function Probe() {
  const trackCount = useDawStore((s) => s.project?.tracks.length ?? 0);
  return <p>{trackCount} tracks</p>;
}

describe("EpisodeHydrator", () => {
  it("renders only once the episode is hydrated", () => {
    render(
      <EpisodeHydrator>
        <Probe />
      </EpisodeHydrator>,
    );
    expect(screen.getByText("2 tracks")).toBeInTheDocument();
  });

  it("opens a host by path and a guest by share key with the role's capabilities", () => {
    const host = render(
      <EpisodeHydrator>
        <Probe />
      </EpisodeHydrator>,
    );
    expect(useDawStore.getState().projectPath).toBe(
      "/episodes/after-hours/episode.project.json",
    );
    expect(useDawStore.getState().guestMode).toBeNull();
    host.unmount();

    render(
      <EpisodeHydrator
        config={{ role: "commenter", selection: selections.comment }}
      >
        <Probe />
      </EpisodeHydrator>,
    );
    const state = useDawStore.getState();
    expect(state.projectPath).toBe("share:episode");
    expect(state.guestMode).toBe("comment");
    expect(state.shareCapabilities).toContain("comment");
    expect(state.selection).toEqual(selections.comment);
  });

  it("answers configured URLs with JSON and everything else with a 503", async () => {
    render(
      <EpisodeHydrator
        config={{ responses: { "/api/steps": ["clean"] }, hang: ["/api/slow"] }}
      >
        <Probe />
      </EpisodeHydrator>,
    );
    const known = await fetch("/api/steps?x=1");
    expect(await known.json()).toEqual(["clean"]);
    expect((await fetch("/api/other")).status).toBe(503);
    const outcome = await Promise.race([
      fetch("/api/slow").then(() => "answered"),
      Promise.resolve("pending"),
    ]);
    expect(outcome).toBe("pending");
  });

  it("restores the store and the network stubs when it unmounts, twice", () => {
    const before = useDawStore.getState();
    const { fetch, WebSocket } = globalThis;
    for (let round = 0; round < 2; round += 1) {
      const view = render(
        <EpisodeHydrator config={{ role: "editor" }}>
          <Probe />
        </EpisodeHydrator>,
      );
      expect(useDawStore.getState()).not.toBe(before);
      expect(listRegisteredIds()).toContain("tighten.applyHit");
      expect(globalThis.fetch).not.toBe(fetch);
      view.unmount();
      expect(useDawStore.getState()).toBe(before);
      expect(listRegisteredIds()).toEqual([]);
      expect(globalThis.fetch).toBe(fetch);
      expect(globalThis.WebSocket).toBe(WebSocket);
    }
  });

  it("shows the host's record room and clears it on unmount", () => {
    const view = render(
      <EpisodeHydrator config={{ record: recordRoom }}>
        <Probe />
      </EpisodeHydrator>,
    );
    expect(useRecordHostStore.getState().snapshot?.state).toBe("recording");
    expect(useRecordHostStore.getState().connected).toBe(true);
    view.unmount();
    expect(useRecordHostStore.getState().snapshot).toBeNull();
    expect(useRecordHostStore.getState().connected).toBe(false);
  });
});
