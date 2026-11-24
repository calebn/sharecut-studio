import { beforeEach, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ProjectView } from "../types/project";
import { applyDocumentSnapshot, redisplayDrafts } from "./applyDocumentUpdate";
import { resetDocumentAuthority } from "./authorityState";
import { beginDocumentDraft, hasDocumentDrafts } from "./pendingDrafts";

const path = "/tmp/stale-trim.json";
const withEnd = (sourceEnd: number): ProjectView =>
  minimalProject({
    project_path: path,
    tracks: [sampleTrack({ id: "host" })],
    clips: {
      tracks: {
        host: [
          clipRow({
            id: "c1",
            track_id: "host",
            source_start: 0,
            source_end: sourceEnd,
            timeline_start: 0,
            timeline_end: sourceEnd,
            source_duration_sec: 60,
          }),
        ],
      },
      clip_count: 1,
    },
  });
const shownEnd = () =>
  useDawStore.getState().project?.clips.tracks.host?.[0]?.source_end;

beforeEach(() => {
  resetDocumentAuthority(path);
  useDawStore.getState().hydrate(path, withEnd(10));
  applyDocumentSnapshot({ server_seq: 1, project: withEnd(10) });
});

it("a trim another tab already sent does not trim again after an undo", () => {
  beginDocumentDraft("queued-trim", "TrimClipEdge", {
    clip_id: "c1",
    edge: "out",
    source_sec: 8,
    mode: "ripple",
    expected_token: "token",
  });
  redisplayDrafts();
  expect(shownEnd()).toBe(8);

  applyDocumentSnapshot({ server_seq: 2, project: withEnd(8) });
  expect(shownEnd()).toBe(8);

  applyDocumentSnapshot({ server_seq: 3, project: withEnd(10) });
  expect(shownEnd()).toBe(10);
  expect(hasDocumentDrafts()).toBe(false);
});

it("keeps a queued trim the host has not taken yet over a snapshot that does not hold it", () => {
  beginDocumentDraft("queued-trim", "TrimClipEdge", {
    clip_id: "c1",
    edge: "out",
    source_sec: 8,
    mode: "ripple",
    expected_token: "token",
  });
  applyDocumentSnapshot({ server_seq: 2, project: withEnd(10) });
  expect(shownEnd()).toBe(8);
  expect(hasDocumentDrafts()).toBe(true);
});
