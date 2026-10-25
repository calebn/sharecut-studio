import { beforeEach, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import { TRIM_MODE } from "../edit/clipEdgeSave";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import {
  interceptDetailLoads,
  shellSnapshot,
  withoutWords,
  withWords,
} from "../test/transcriptHydration";
import { useDawStore } from "./dawStore";

vi.mock("../api/project", () => ({
  loadDocumentState: vi.fn(() => new Promise(() => undefined)),
}));

const path = "/tmp/trim.json";
const target = {
  trackId: "host",
  clipId: "anchor",
  edge: "out",
  mode: TRIM_MODE,
} as const;
const shell = () =>
  withoutWords(
    minimalProject({
      project_path: path,
      tracks: [sampleTrack()],
      clips: {
        tracks: {
          host: [
            clipRow({
              id: "anchor",
              track_id: "host",
              source_end: 10,
              timeline_end: 10,
            }),
          ],
        },
        clip_count: 1,
      },
      transcript: {
        utterances: [
          { track_id: "host", speaker: "Host", start: 0, end: 1, text: "Um." },
        ],
      },
    }),
  );

beforeEach(() => {
  resetDocumentAuthority(path);
  useDawStore.getState().hydrate(path, shell());
});

it("keeps a held trim when only the words arrive at the same seq", async () => {
  const detail = interceptDetailLoads();
  applyDocumentSnapshot(shellSnapshot(shell(), 4));
  const store = useDawStore.getState();
  const token = Symbol();
  store.changeHeldTrim({ kind: "begin", token, target });
  store.changeHeldTrim({ kind: "value", token, sourceSec: 9.99 });
  await detail.land(withWords(shell()));
  expect(useDawStore.getState().project?.meta.hydration?.transcript_words).toBe(
    true,
  );
  expect(useDawStore.getState().heldTrim?.token).toBe(token);
  expect(
    useDawStore
      .getState()
      .changeHeldTrim({ kind: "value", token, sourceSec: 9.98 }).kind,
  ).toBe("accepted");
});
