import { act, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { _resetMixLanesForTests } from "../commands/trackMix";
import { _resetTrackMutateChainForTests } from "../commands/trackMutation";
import {
  applyDocumentSnapshot,
  mergeGuestActionDone,
  mergeReturnedComment,
} from "../document/applyDocumentUpdate";
import { documentAuthority } from "../document/authorityState";
import {
  currentDocumentSeq,
  resetDocumentSeqForTests,
} from "../document/cursor";
import { saveNudge } from "../edit/nudge";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import {
  field,
  initializeCommentProject,
  project,
} from "../test/trimNudgeData";
import { Harness } from "../test/trimNudgeFixture";
import type { TimelineComment } from "../types/project";

vi.mock("../edit/nudge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edit/nudge")>()),
  saveNudge: vi.fn(async () => {
    const state = useDawStore.getState();
    if (state.project) state.setProject(state.project);
    return true;
  }),
}));
vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(async () => ({})),
}));
describe("refused trim nudges", () => {
  beforeEach(() => {
    vi.mocked(saveNudge).mockClear();
  });
  it.each(["edited", "peer"])(
    "keeps and saves the last valid %s lane preview",
    async (placement) => {
      const anchor = clipRow({
        id: "anchor",
        source_end: 10,
        timeline_end: 10,
      });
      const follower = clipRow({
        id: "follower",
        track_id: placement === "edited" ? "host" : "guest",
        timeline_start: 0.015,
        timeline_end: 19.015,
        source_start: 0,
        source_end: 19,
        source_id: "alt",
        recording_key: "alt",
        fade_in_ms: 17,
      });
      const origin = minimalProject({
        tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
        clips: {
          tracks: {
            host: placement === "edited" ? [anchor, follower] : [anchor],
            guest:
              placement === "peer"
                ? [
                    clipRow({ ...anchor, id: "peer", track_id: "guest" }),
                    follower,
                  ]
                : [],
          },
          clip_count: placement === "peer" ? 3 : 2,
        },
      });
      useDawStore.getState().hydrate("/tmp/nudge.project.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const valid = useDawStore.getState().project;
      expect(
        valid?.clips.tracks[follower.track_id].find((c) => c.id === "follower"),
      ).toMatchObject({
        timeline_start: expect.closeTo(0.005, 9),
        source_start: 0,
        source_end: 19,
        fade_in_ms: 17,
      });
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      expect(useDawStore.getState().project).toBe(valid);
      expect(useDawStore.getState().statusAnnouncement).toContain(
        "before the timeline starts",
      );
      expect(saveNudge).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.keyUp(button, { key: "Enter" });
      });
      await waitFor(() => expect(saveNudge).toHaveBeenCalledOnce());
      expect(saveNudge).toHaveBeenCalledWith(
        "/tmp/nudge.project.json",
        origin,
        field,
        9.99,
        expect.any(Function),
        expect.any(Function),
      );
    },
  );
  it("classifies each accepted step from the saved lane", async () => {
    const anchor = clipRow({
      id: "anchor",
      source_start: 0,
      source_end: 10,
      timeline_end: 10,
    });
    const nested = clipRow({
      id: "nested",
      timeline_start: 1,
      timeline_end: 9,
      source_start: 0,
      source_end: 8,
      source_id: "alt",
      recording_key: "alt",
    });
    const origin = minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: { tracks: { host: [anchor, nested] }, clip_count: 2 },
    });
    useDawStore.getState().hydrate("/tmp/nudge.project.json", origin);
    const { getByRole } = render(<Harness delta={-1} />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    expect(useDawStore.getState().project?.clips.tracks.host).toEqual([
      { ...anchor, source_end: 7, timeline_end: 7 },
      nested,
    ]);
    await act(async () => {
      fireEvent.keyUp(button, { key: "Enter" });
    });
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/nudge.project.json",
      origin,
      field,
      7,
      expect.any(Function),
      expect.any(Function),
    );
  });
});

describe("trim nudge document lifetime", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    vi.mocked(saveNudge)
      .mockReset()
      .mockImplementation(async () => {
        const state = useDawStore.getState();
        if (state.project) state.setProject(state.project);
        return true;
      });
    vi.mocked(submitQueuedDocumentCommand).mockReset().mockResolvedValue({});
    clearRegisteredCommands();
    _resetTrackMutateChainForTests();
  });

  afterEach(() => _resetMixLanesForTests());

  it("same-path hydration cancels before release even with unchanged authority and epoch", async () => {
    const { origin } = initializeCommentProject();
    const button = render(<Harness />).getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    expect(
      useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
    ).toBe(10);
    expect(saveNudge).not.toHaveBeenCalled();
  });

  const localMerges = ["action", "returned comment", "metadata"] as const;
  function mergeLocal(
    change: (typeof localMerges)[number],
    comment: TimelineComment,
  ) {
    if (change === "action") mergeGuestActionDone("review", "action", true);
    else if (change === "returned comment") {
      mergeReturnedComment({ ...comment, body: "Keep the whole phrase" });
    } else {
      applyDocumentSnapshot({
        patch: { meta: { name: "Updated name", workspace_dir: "/tmp/new" } },
      });
    }
  }

  it.each(localMerges)(
    "removes only its trim preview after a local %s merge on repeat and release",
    async (change) => {
      const { origin, comment } = initializeCommentProject();
      const authority = documentAuthority.project;
      const button = render(<Harness />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.99);
      mergeLocal(change, comment);
      const merged = useDawStore.getState().project;
      expect(currentDocumentSeq()).toBe(4);
      expect(documentAuthority.project).toBe(authority);
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(useDawStore.getState().project).toEqual({
        ...merged,
        clips: origin.clips,
      });
      expect(useDawStore.getState().project?.clips.tracks.host).toMatchObject([
        { id: "anchor", source_end: 10, timeline_end: 10 },
        {
          id: "follower",
          source_start: 10,
          source_end: 20,
          timeline_start: 9.9996,
          timeline_end: 19.9996,
        },
      ]);
      if (change === "action")
        expect(
          useDawStore.getState().project?.comments[0]?.action_items[0]?.done,
        ).toBe(true);
      else if (change === "returned comment")
        expect(useDawStore.getState().project?.comments[0]?.body).toBe(
          "Keep the whole phrase",
        );
      else
        expect(useDawStore.getState().project?.meta.name).toBe("Updated name");
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it.each(["release", "unmount"])(
    "removes its preview on %s without a repeat after a returned comment",
    async (ending) => {
      const { origin, comment } = initializeCommentProject();
      const { getByRole, unmount } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      mergeReturnedComment({ ...comment, body: "Keep the whole phrase" });
      await act(async () => {
        if (ending === "release") fireEvent.keyUp(button, { key: "Enter" });
        else unmount();
      });
      expect(useDawStore.getState().project?.clips).toEqual(origin.clips);
      expect(useDawStore.getState().project?.comments[0]?.body).toBe(
        "Keep the whole phrase",
      );
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it.each(["action", "returned comment"] as const)(
    "removes its preview after a local %s merge before delayed pointer cancel and click",
    async (change) => {
      const { origin, comment } = initializeCommentProject();
      const button = render(<Harness />).getByRole("button");
      const user = userEvent.setup();
      await user.pointer({ target: button, keys: "[MouseLeft>]" });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.99);
      mergeLocal(change, comment);
      const merged = useDawStore.getState().project;
      await act(
        async () => new Promise((resolve) => setTimeout(resolve, 1100)),
      );
      fireEvent.pointerCancel(button, { pointerId: 1 });
      await user.pointer({ target: button, keys: "[/MouseLeft]" });
      expect(useDawStore.getState().project).toEqual({
        ...merged,
        clips: origin.clips,
      });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(10);
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("keeps comments after an initially refused negative trim without an owned preview", async () => {
    const { origin, comment } = initializeCommentProject(0.005);
    const button = render(<Harness />).getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    expect(useDawStore.getState().statusAnnouncement).toContain(
      "before the timeline starts",
    );
    expect(
      useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
    ).toBe(10);
    mergeGuestActionDone(comment.id, "action", true);
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    expect(useDawStore.getState().project?.clips).toEqual(origin.clips);
    expect(
      useDawStore.getState().project?.comments[0]?.action_items[0]?.done,
    ).toBe(true);
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it.each([
    "local geometry",
    "new sequence",
    "same-sequence authority",
    "project generation",
  ])(
    "preserves replacement geometry after %s instead of rolling back",
    async (change) => {
      const { origin, comment } = initializeCommentProject();
      const button = render(<Harness />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const preview = useDawStore.getState().project!;
      const fresh = {
        ...preview,
        meta: { ...preview.meta, name: "Fresh geometry" },
      };
      if (change === "local geometry") {
        applyDocumentSnapshot({
          patch: {
            clips: {
              ...origin.clips,
              tracks: {
                host: [
                  clipRow({ id: "anchor", source_end: 8, timeline_end: 8 }),
                ],
              },
            },
          },
        });
      } else if (change === "project generation") {
        act(() => {
          useDawStore.getState().hydrate("/tmp/two.json", origin);
          useDawStore.getState().hydrate("/tmp/one.json", fresh);
        });
      } else {
        applyDocumentSnapshot({
          server_seq: change === "new sequence" ? 5 : 4,
          project: fresh,
        });
      }
      mergeReturnedComment({
        ...comment,
        body: "New comment with fresh geometry",
      });
      const replacement = useDawStore.getState().project;
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(useDawStore.getState().project).toBe(replacement);
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(change === "local geometry" ? 8 : 9.99);
      expect(useDawStore.getState().project?.comments[0]?.body).toBe(
        "New comment with fresh geometry",
      );
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it.each(["metadata", "follower geometry"])(
    "keeps an authoritative %s update through repeat and release",
    async (change) => {
      const origin = project();
      useDawStore.getState().hydrate("/tmp/one.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const fresh = structuredClone(origin);
      if (change === "metadata") fresh.meta.name = "Committed name";
      else fresh.clips.tracks.host[1]!.timeline_start = 8;
      applyDocumentSnapshot({ server_seq: 1, project: fresh });
      const authoritative = useDawStore.getState().project;
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      expect(useDawStore.getState().project).toBe(authoritative);
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("discards a replacement snapshot at the current document sequence", () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    applyDocumentSnapshot({ server_seq: 1, project: origin });
    const fresh = {
      ...origin,
      meta: { ...origin.meta, name: "Same sequence" },
    };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    const authoritative = useDawStore.getState().project;
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    expect(useDawStore.getState().project).toBe(authoritative);
    expect(useDawStore.getState().project?.meta.name).toBe("Same sequence");
  });

  it.each(["new project", "switch away and back"])(
    "does not publish or save after %s during a held trim",
    async (change) => {
      const origin = project();
      useDawStore.getState().hydrate("/tmp/one.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const fresh = {
        ...origin,
        meta: { ...origin.meta, name: "Fresh project" },
      };
      if (change === "new project") {
        act(() => useDawStore.getState().hydrate("/tmp/two.json", fresh));
      } else {
        act(() => {
          useDawStore.getState().hydrate("/tmp/two.json", project());
          useDawStore.getState().hydrate("/tmp/one.json", fresh);
        });
      }
      const authoritative = useDawStore.getState().project;
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      expect(useDawStore.getState().project).toBe(authoritative);
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("does not save on release when an update arrives before the next repeat", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    expect(useDawStore.getState().project?.meta.name).toBe("Fresh");
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it("cancels a pending pointer repeat when a snapshot replaces the project", async () => {
    vi.useFakeTimers();
    try {
      const origin = project();
      useDawStore.getState().hydrate("/tmp/one.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.99);
      expect(vi.getTimerCount()).toBe(1);
      const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
      applyDocumentSnapshot({ server_seq: 1, project: fresh });
      const authoritative = useDawStore.getState().project;
      await act(async () => vi.advanceTimersByTime(500));
      expect(useDawStore.getState().project).toBe(authoritative);
      expect(vi.getTimerCount()).toBe(0);
      fireEvent.pointerUp(button, { pointerId: 1 });
      expect(saveNudge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows the release click after a repeated pointer run becomes stale", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    const user = userEvent.setup();
    await user.pointer({ target: button, keys: "[MouseLeft>]" });
    const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
    const authoritative = useDawStore.getState().project;
    expect(authoritative?.meta.name).toBe("Fresh");
    await user.pointer({ target: button, keys: "[/MouseLeft]" });
    expect(useDawStore.getState().project).toBe(authoritative);
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it("swallows a stale pointer release click after switching projects", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    const user = userEvent.setup();
    await user.pointer({ target: button, keys: "[MouseLeft>]" });
    const fresh = { ...project(), meta: { ...origin.meta, name: "Other" } };
    act(() => useDawStore.getState().hydrate("/tmp/two.json", fresh));
    await user.pointer({ target: button, keys: "[/MouseLeft]" });
    expect(useDawStore.getState().project).toBe(fresh);
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it("saves valid pointer and assistive click nudges once", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole, unmount } = render(<Harness />);
    const button = getByRole("button");
    const user = userEvent.setup();
    await user.pointer({ target: button, keys: "[MouseLeft>]" });
    await user.pointer({ target: button, keys: "[/MouseLeft]" });
    expect(saveNudge).toHaveBeenCalledOnce();
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/one.json",
      origin,
      field,
      9.99,
      expect.any(Function),
      expect.any(Function),
    );

    vi.mocked(saveNudge).mockClear();
    unmount();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const assistive = render(<Harness />).getByRole("button");
    fireEvent.click(assistive, { detail: 0 });
    await waitFor(() => expect(saveNudge).toHaveBeenCalledOnce());
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/one.json",
      origin,
      field,
      9.99,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("saves a keyboard nudge once without restarting from its generated click", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const button = render(<Harness />).getByRole("button");
    button.focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(saveNudge).toHaveBeenCalledOnce());
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/one.json",
      origin,
      field,
      9.99,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("does not restore its preview when a pending save rejects after an update", async () => {
    let rejectSave!: (error: Error) => void;
    vi.mocked(saveNudge).mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    await act(async () => rejectSave(new Error("stale")));
    expect(useDawStore.getState().project?.meta.name).toBe("Fresh");
  });

  it("discards the run on unmount after an authoritative update", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole, unmount } = render(<Harness />);
    fireEvent.keyDown(getByRole("button"), { key: "Enter" });
    const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    await act(async () => unmount());
    expect(useDawStore.getState().project?.meta.name).toBe("Fresh");
    expect(saveNudge).not.toHaveBeenCalled();
  });
});
