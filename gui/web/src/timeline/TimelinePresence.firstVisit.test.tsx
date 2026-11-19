import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetServerClock } from "../presence/clock";
import { useDawStore } from "../state/dawStore";
import {
  clipRow,
  minimalProject,
  sampleTrack,
  sessionRoster,
} from "../test/fixtures";
import { TimelinePresence } from "./TimelinePresence";

const SENTENCE = "You can edit and comment. The host decides what ships.";

describe("first-visit sentence and the presence announcer", () => {
  afterEach(() => {
    cleanup();
    useDawStore.setState({
      localClientId: null,
      sessionClients: sessionRoster([]),
      statusAnnouncement: "",
    });
    resetServerClock();
  });

  it("keeps the sentence when the host's roster arrives after it", () => {
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        clips: {
          tracks: {
            host: [
              clipRow({
                id: "c1",
                track_id: "host",
                timeline_start: 0,
                timeline_end: 5,
              }),
            ],
          },
          clip_count: 1,
        },
      }),
    );
    useDawStore.setState({
      localClientId: "me",
      sessionRosterVersion: 5,
      sessionClients: sessionRoster([{ client_id: "me", role: "editor" }]),
    });
    render(
      <TimelinePresence
        canvasWidthPx={600}
        viewportPx={300}
        zoomPxPerSec={10}
        laneHeight={80}
        markerLaneHeightPx={48}
        followingClientId={null}
      />,
    );
    const writes: string[] = [];
    const unsubscribe = useDawStore.subscribe((state, prev) => {
      if (state.statusAnnouncementSeq !== prev.statusAnnouncementSeq) {
        writes.push(state.statusAnnouncement);
      }
    });
    act(() => {
      useDawStore.getState().announceStatus(SENTENCE, { toast: false });
    });
    act(() => {
      useDawStore.setState({
        sessionClients: sessionRoster([
          { client_id: "me", role: "editor", playhead_sec: 1 },
          {
            client_id: "host",
            role: "host",
            playhead_sec: 2,
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Host" },
          },
        ]),
      });
    });
    unsubscribe();
    expect(writes).toEqual([SENTENCE]);
    expect(useDawStore.getState().statusAnnouncement).toBe(SENTENCE);
  });
});
