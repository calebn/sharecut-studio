import { beforeEach, describe, expect, it } from "vitest";
import {
  applyDocumentSnapshot,
  mergeReturnedComment,
} from "../document/applyDocumentUpdate";
import {
  documentAuthority,
  resetDocumentAuthority,
} from "../document/authorityState";
import {
  beginDocumentDraft,
  finishDocumentDraft,
} from "../document/pendingDrafts";
import { TRIM_MODE } from "../edit/clipEdgeSave";
import {
  clipRow,
  minimalProject,
  sampleComment,
  sampleTrack,
} from "../test/fixtures";
import { useDawStore } from "./dawStore";

describe("held trim publication", () => {
  const target = {
    trackId: "host",
    clipId: "anchor",
    edge: "out",
    mode: TRIM_MODE,
  } as const;
  beforeEach(() => {
    resetDocumentAuthority("/tmp/trim.json");
    const project = minimalProject({
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
            clipRow({
              id: "other",
              track_id: "host",
              timeline_start: 12,
              timeline_end: 22,
            }),
          ],
        },
        clip_count: 2,
      },
    });
    useDawStore.getState().hydrate("/tmp/trim.json", project);
    applyDocumentSnapshot({ server_seq: 4, project });
  });

  it("rejects a second owner and stale token endings cannot remove a newer hold", () => {
    const store = useDawStore.getState();
    const first = Symbol();
    const second = Symbol();
    expect(
      store.changeHeldTrim({ kind: "begin", token: first, target }).kind,
    ).toBe("accepted");
    expect(
      store.changeHeldTrim({ kind: "begin", token: second, target }).kind,
    ).toBe("gone");
    store.changeHeldTrim({ kind: "value", token: first, sourceSec: 9.99 });
    store.changeHeldTrim({
      kind: "finish",
      token: first,
      disposition: "discard",
    });
    store.changeHeldTrim({ kind: "begin", token: second, target });
    store.changeHeldTrim({ kind: "value", token: second, sourceSec: 9.98 });
    expect(
      store.changeHeldTrim({
        kind: "finish",
        token: first,
        disposition: "discard",
      }).kind,
    ).toBe("gone");
    expect(
      useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
    ).toBe(9.98);
    expect(store.projectEditBasis()?.clips.tracks.host[0]?.source_end).toBe(10);
    expect(
      store.changeHeldTrim({
        kind: "finish",
        token: second,
        disposition: "handoff",
      }),
    ).toMatchObject({ kind: "handoff", value: 9.98, path: "/tmp/trim.json" });
    expect(store.projectEditBasis()?.clips.tracks.host[0]?.source_end).toBe(
      9.98,
    );
    expect(
      store.changeHeldTrim({
        kind: "finish",
        token: second,
        disposition: "discard",
      }).kind,
    ).toBe("gone");
  });

  it("discard retains a newly registered absolute move without retaining trim source geometry", () => {
    const store = useDawStore.getState();
    const token = Symbol();
    store.changeHeldTrim({ kind: "begin", token, target });
    store.changeHeldTrim({ kind: "value", token, sourceSec: 9.99 });
    beginDocumentDraft("move", "MoveClips", {
      clips: [{ clip_id: "anchor", track_id: "host", timeline_start: 2 }],
    });
    expect(store.projectEditBasis()?.clips.tracks.host[0]).toMatchObject({
      source_end: 10,
      timeline_start: 2,
      timeline_end: 12,
    });
    store.changeHeldTrim({ kind: "finish", token, disposition: "discard" });
    expect(useDawStore.getState().project?.clips.tracks.host[0]).toMatchObject({
      source_end: 10,
      timeline_start: 2,
      timeline_end: 12,
    });
    finishDocumentDraft("move");
  });

  it.each(["same-sequence authority", "sequence", "generation", "epoch"])(
    "%s invalidation uses ready current authority and never old origin",
    (change) => {
      const store = useDawStore.getState();
      const token = Symbol();
      store.changeHeldTrim({ kind: "begin", token, target });
      store.changeHeldTrim({ kind: "value", token, sourceSec: 9.99 });
      const fresh = minimalProject({
        ...documentAuthority.project!,
        clips: {
          tracks: {
            host: [
              clipRow({
                id: "new",
                track_id: "host",
                source_end: 8,
                timeline_end: 8,
              }),
            ],
          },
          clip_count: 1,
        },
      });
      documentAuthority.project = fresh;
      if (change === "sequence") documentAuthority.seq += 1;
      if (change === "generation") documentAuthority.generation += 1;
      if (change === "epoch")
        useDawStore.setState({ projectEpoch: store.projectEpoch + 1 });
      expect(store.projectEditBasis()?.clips.tracks.host).toEqual(
        fresh.clips.tracks.host,
      );
      expect(
        store.changeHeldTrim({ kind: "finish", token, disposition: "discard" })
          .kind,
      ).toBe("gone");
      expect(useDawStore.getState().project?.clips.tracks.host).toEqual(
        fresh.clips.tracks.host,
      );
    },
  );

  it.each(["starting", "recovering"] as const)(
    "%s authority without a validated basis awaits replacement without exposing the old display as clean",
    (phase) => {
      const store = useDawStore.getState();
      const token = Symbol();
      store.changeHeldTrim({ kind: "begin", token, target });
      store.changeHeldTrim({ kind: "value", token, sourceSec: 9.99 });
      resetDocumentAuthority("/tmp/trim.json");
      documentAuthority.phase =
        phase === "starting" ? { kind: phase } : { kind: phase, minimum: 5 };
      expect(store.projectEditBasis()).toBeNull();
      expect(
        store.changeHeldTrim({ kind: "finish", token, disposition: "discard" })
          .kind,
      ).toBe("awaiting-document");
      expect(store.projectEditBasis()).toBeNull();
      const replacement = minimalProject({
        tracks: [sampleTrack()],
        clips: {
          tracks: {
            host: [
              clipRow({
                id: "anchor",
                track_id: "host",
                source_end: 8,
                timeline_end: 8,
              }),
            ],
          },
          clip_count: 1,
        },
      });
      store.setProject(replacement);
      expect(store.projectEditBasis()?.clips.tracks.host[0]?.source_end).toBe(
        8,
      );
    },
  );

  it("refuses a negative first or later step atomically and hands off the exact last accepted preview", () => {
    const store = useDawStore.getState();
    const basis = store.projectEditBasis()!;
    store.setProject({
      ...basis,
      clips: {
        tracks: {
          host: [
            basis.clips.tracks.host[0]!,
            clipRow({
              id: "follower",
              track_id: "host",
              timeline_start: 0.015,
              timeline_end: 19.015,
              source_end: 19,
              recording_key: "other",
            }),
          ],
        },
        clip_count: 2,
      },
    });
    const origin = useDawStore.getState().project;
    const token = Symbol();
    store.changeHeldTrim({ kind: "begin", token, target });
    const begun = useDawStore.getState();
    expect(() =>
      store.changeHeldTrim({ kind: "value", token, sourceSec: 9.98 }),
    ).toThrow("before the timeline starts");
    expect(useDawStore.getState()).toBe(begun);
    store.changeHeldTrim({ kind: "value", token, sourceSec: 9.99 });
    const accepted = useDawStore.getState();
    expect(() =>
      store.changeHeldTrim({ kind: "value", token, sourceSec: 9.98 }),
    ).toThrow("before the timeline starts");
    expect(useDawStore.getState()).toBe(accepted);
    const handoff = store.changeHeldTrim({
      kind: "finish",
      token,
      disposition: "handoff",
    });
    expect(handoff).toEqual({
      kind: "handoff",
      path: "/tmp/trim.json",
      origin,
      preview: accepted.project,
      value: 9.99,
    });
    expect(useDawStore.getState().project).toBe(accepted.project);
  });

  it("publishes foreign comments with layer retirement in the same store notification", () => {
    const store = useDawStore.getState();
    const token = Symbol();
    store.changeHeldTrim({ kind: "begin", token, target });
    store.changeHeldTrim({ kind: "value", token, sourceSec: 9.99 });
    const frames: Array<{
      end: number | undefined;
      body: string | undefined;
      active: boolean;
    }> = [];
    const stop = useDawStore.subscribe((state) =>
      frames.push({
        end: state.project?.clips.tracks.host[0]?.source_end,
        body: state.project?.comments[0]?.body,
        active: state.heldTrim !== null,
      }),
    );
    mergeReturnedComment(sampleComment({ body: "Fresh comment" }));
    stop();
    expect(frames).toEqual([{ end: 10, body: "Fresh comment", active: false }]);
  });
});
