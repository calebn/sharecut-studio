import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { selections } from "./episodeFixture";
import { EpisodeHydrator } from "./withEpisode";

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
      expect(globalThis.fetch).not.toBe(fetch);
      view.unmount();
      expect(useDawStore.getState()).toBe(before);
      expect(globalThis.fetch).toBe(fetch);
      expect(globalThis.WebSocket).toBe(WebSocket);
    }
  });
});
