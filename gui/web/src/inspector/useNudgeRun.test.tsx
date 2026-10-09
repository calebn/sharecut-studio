import { act, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentSeqForTests } from "../document/cursor";
import { type NudgeField, saveNudge } from "../edit/nudge";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { useNudgeRun } from "./useNudgeRun";

vi.mock("../edit/nudge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edit/nudge")>()),
  saveNudge: vi.fn(async () => true),
}));
const field: NudgeField = {
  kind: "trim",
  trackId: "host",
  clipId: "anchor",
  edge: "out",
};
function Harness({ delta = -0.01 }: { delta?: number }) {
  const run = useNudgeRun();
  return <button {...run.buttonProps(field, delta, "Trim end")}>Nudge</button>;
}

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
    );
  });
});

describe("trim nudge document lifetime", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    vi.mocked(saveNudge).mockReset().mockResolvedValue(true);
  });

  function project() {
    return minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: {
        tracks: {
          host: [
            clipRow({ id: "anchor", source_end: 10, timeline_end: 10 }),
            clipRow({
              id: "follower",
              source_start: 10,
              source_end: 20,
              timeline_start: 9.9996,
              timeline_end: 19.9996,
            }),
          ],
        },
        clip_count: 2,
      },
    });
  }

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
