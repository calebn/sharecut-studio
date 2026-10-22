import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDocumentSnapshot,
  mergeGuestActionDone,
  mergeReturnedComment,
} from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import {
  beginDocumentDraft,
  finishDocumentDraft,
} from "../document/pendingDrafts";
import { useDawStore } from "../state/dawStore";
import type { AnnounceOptions } from "../state/types";
import { useDaw } from "../state/useDaw";
import { expectNoA11yViolations } from "../test/a11y";
import { deferred } from "../test/deferred";
import {
  clipRow,
  minimalProject,
  sampleComment,
  sampleTrack,
} from "../test/fixtures";
import { replayPointer } from "../timeline/hitRouting";
import {
  type ProjectView,
  parseHistoryEntryId,
  type Selection,
} from "../types/project";
import { InspectorPeek } from "./InspectorPeek";
import { peekTarget } from "./peekTarget";

const api = vi.hoisted(() => ({
  setClipFade: vi.fn(),
  setEnvelope: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  setClipFade: api.setClipFade,
  setEnvelope: api.setEnvelope,
}));
const host = vi.hoisted(() => ({
  submit: vi.fn(),
  loadBoundaryContext: vi.fn(),
}));
vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: host.submit,
}));
vi.mock("../api/boundary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/boundary")>()),
  loadBoundaryContext: host.loadBoundaryContext,
}));

const left = clipRow({
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 10,
  timeline_start: 0,
  timeline_end: 10,
});
const clip = clipRow({
  id: "c2",
  track_id: "host",
  source_start: 10,
  source_end: 40,
  timeline_start: 10,
  timeline_end: 40,
  fade_in_ms: 300,
});
const project = minimalProject({
  tracks: [sampleTrack({ id: "host" })],
  clips: { tracks: { host: [left, clip] }, clip_count: 2 },
  envelopes: [
    {
      track_id: "host",
      parameter: "volume",
      points: [{ id: "e1", time: 9.75, value: 1 }],
    },
  ],
});
const announce = vi.fn<(message: string, options?: AnnounceOptions) => void>();
const FADE_HEAD = parseHistoryEntryId("h-fade");

/** The strip as the shell renders it: its peek follows the store's project. */
function Strip({
  selection,
  hit,
}: {
  selection: Selection;
  hit: Parameters<typeof peekTarget>[2];
}) {
  const current = useDaw((s) => s.project);
  const peek = current ? peekTarget(current, selection, hit) : null;
  return peek ? <InspectorPeek peek={peek} /> : null;
}

const FADE = {
  selection: { kind: "clip", id: "c2", trackId: "host" },
  hit: { kind: "fade-in", id: "c2" },
} as const;
const TRIM_END = {
  selection: { kind: "clip", id: "c2", trackId: "host" },
  hit: { kind: "trim-out", id: "c2" },
} as const;
const POINT = {
  selection: { kind: "envelopePoint", trackId: "host", pointId: "e1" },
  hit: null,
} as const;

function open(
  target: { selection: Selection; hit: Parameters<typeof peekTarget>[2] },
  p: ProjectView = project,
  path = "/tmp/p.json",
) {
  useDawStore.getState().hydrate(path, p, null);
  useDawStore
    .getState()
    .setLayerVisible("showLevels", target.selection?.kind === "envelopePoint");
  useDawStore.setState({ announceStatus: announce });
  return render(<Strip selection={target.selection} hit={target.hit} />);
}

const fadeIn = () =>
  useDawStore.getState().project?.clips.tracks.host[1].fade_in_ms;
const button = (name: string) => screen.getByRole("button", { name });
const flush = () => act(async () => undefined);
/** Runs the repeat timers `ms` forward, rendering what they change. */
const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  resetDocumentAuthority("/tmp/p.json");
  api.setClipFade.mockReset().mockResolvedValue(FADE_HEAD);
  api.setEnvelope.mockReset().mockResolvedValue(null);
  announce.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InspectorPeek nudges", () => {
  it("shows the value, labels each step, and saves one press as one edit", async () => {
    open(FADE);
    expect(screen.getByRole("status")).toHaveTextContent("300 ms");
    const group = screen.getByRole("group", { name: "Nudge fade in" });
    expect(
      [...group.querySelectorAll("button")].map((b) => [
        b.textContent,
        b.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["−10", "Fade in 10 ms shorter"],
      ["−1", "Fade in 1 ms shorter"],
      ["+1", "Fade in 1 ms longer"],
      ["+10", "Fade in 10 ms longer"],
    ]);
    fireEvent.pointerDown(button("Fade in 10 ms longer"), { button: 0 });
    fireEvent.pointerUp(button("Fade in 10 ms longer"));
    fireEvent.click(button("Fade in 10 ms longer"));
    await flush();
    expect(api.setClipFade.mock.calls).toEqual([
      ["/tmp/p.json", "c2", 310, 0, { fade_in_ms: 300, fade_out_ms: 0 }],
    ]);
    expect(announce).toHaveBeenLastCalledWith("Fade saved", {
      undo: FADE_HEAD,
    });
    vi.useRealTimers();
    await expectNoA11yViolations(group);
  });

  it("keeps a held fade shown when a push lands that leaves the fade alone", async () => {
    open(FADE);
    const plus = button("Fade in 10 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    expect(fadeIn()).toBe(310);
    const pushed = structuredClone(project);
    pushed.tracks[0]!.label = "Renamed";
    applyDocumentSnapshot({ server_seq: 1, project: pushed });
    expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Renamed");
    expect(fadeIn()).toBe(310);
    fireEvent.pointerUp(plus);
    await flush();
    expect(api.setClipFade.mock.calls[0]?.slice(1, 4)).toEqual(["c2", 310, 0]);
  });

  it("shows a pushed fade as it is, and not the held one, when the push changed it", async () => {
    open(FADE);
    const plus = button("Fade in 10 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    const pushed = structuredClone(project);
    pushed.clips.tracks.host![1]!.fade_in_ms = 120;
    applyDocumentSnapshot({ server_seq: 1, project: pushed });
    expect(fadeIn()).toBe(120);
    fireEvent.pointerUp(plus);
    await flush();
    expect(api.setClipFade).not.toHaveBeenCalled();
    expect(fadeIn()).toBe(120);
  });

  it("keeps a queued fade shown after its save settles, until the queue finishes it", async () => {
    api.setClipFade.mockImplementationOnce(
      async (_path: string, clipId: string, inMs: number, outMs: number) => {
        beginDocumentDraft("queued-fade", "SetClipFade", {
          clip_id: clipId,
          fade_in_ms: inMs,
          fade_out_ms: outMs,
        });
        return FADE_HEAD;
      },
    );
    open(FADE);
    const plus = button("Fade in 10 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    fireEvent.pointerUp(plus);
    await flush();
    expect(fadeIn()).toBe(310);
    // The host replies with an older snapshot while the command waits.
    applyDocumentSnapshot({ server_seq: 1, project: structuredClone(project) });
    expect(fadeIn()).toBe(310);
    act(() => finishDocumentDraft("queued-fade"));
    applyDocumentSnapshot({ server_seq: 2, project: structuredClone(project) });
    expect(fadeIn()).toBe(300);
  });

  it("retains its saved baseline and reports refusal after restored fades arrive", async () => {
    open(FADE);
    let refuse!: (error: Error) => void;
    api.setClipFade.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const plus = button("Fade in 1 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    fireEvent.pointerUp(plus);
    await flush();
    expect(api.setClipFade.mock.calls[0]).toEqual([
      "/tmp/p.json",
      "c2",
      301,
      0,
      { fade_in_ms: 300, fade_out_ms: 0 },
    ]);
    const restored = { ...clip, fade_in_ms: 0 };
    act(() =>
      useDawStore.setState({
        project: {
          ...project,
          clips: { tracks: { host: [left, restored] }, clip_count: 2 },
        },
      }),
    );
    await act(async () =>
      refuse(
        new Error(
          "This clip changed. Nothing was saved. Adjust the fade again.",
        ),
      ),
    );
    expect(fadeIn()).toBe(0);
    expect(announce).toHaveBeenLastCalledWith(
      "Fade in not saved: This clip changed. Nothing was saved. Adjust the fade again.",
      { tone: "error" },
    );
    advance(500);
    fireEvent.pointerDown(button("Fade in 1 ms longer"), { button: 0 });
    fireEvent.pointerUp(button("Fade in 1 ms longer"));
    await flush();
    expect(api.setClipFade.mock.calls.at(-1)).toEqual([
      "/tmp/p.json",
      "c2",
      1,
      0,
      { fade_in_ms: 0, fade_out_ms: 0 },
    ]);
    expect(fadeIn()).toBe(1);
  });

  it("repeats while held, after the hold, faster after a few steps, and saves the run once", async () => {
    open(FADE);
    const plus = button("Fade in 1 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    expect(fadeIn()).toBe(301);
    advance(499);
    expect(fadeIn()).toBe(301);
    advance(1);
    expect(fadeIn()).toBe(302);
    // Three more at 100 ms, then every 50 ms.
    advance(300);
    expect(fadeIn()).toBe(305);
    advance(200);
    expect(fadeIn()).toBe(309);
    expect(screen.getByRole("status")).toHaveTextContent("309 ms");
    expect(api.setClipFade).not.toHaveBeenCalled();
    fireEvent.pointerUp(plus);
    advance(1000);
    await flush();
    expect(api.setClipFade.mock.calls).toEqual([
      ["/tmp/p.json", "c2", 309, 0, { fade_in_ms: 300, fade_out_ms: 0 }],
    ]);
  });

  it("stops repeating when the finger leaves the button or the press is cancelled", async () => {
    open(FADE);
    const plus = button("Fade in 1 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    advance(500);
    fireEvent.pointerLeave(plus);
    advance(1000);
    await flush();
    expect(api.setClipFade.mock.calls).toEqual([
      ["/tmp/p.json", "c2", 302, 0, { fade_in_ms: 300, fade_out_ms: 0 }],
    ]);

    fireEvent.pointerDown(plus, { button: 0 });
    fireEvent.pointerCancel(plus);
    advance(1000);
    await flush();
    expect(api.setClipFade.mock.calls.at(-1)).toEqual([
      "/tmp/p.json",
      "c2",
      303,
      0,
      { fade_in_ms: 302, fade_out_ms: 0 },
    ]);
  });

  it("rolls a held run back, saving nothing, when the router cancels it for a second finger", async () => {
    open(FADE);
    const plus = button("Fade in 1 ms longer");
    const down = new PointerEvent("pointerdown", {
      pointerId: 9,
      pointerType: "touch",
    });
    fireEvent.pointerDown(plus, { button: 0 });
    advance(1300);
    expect(fadeIn()).toBe(315);
    replayPointer("pointercancel", plus, down);
    advance(1000);
    await flush();
    expect(fadeIn()).toBe(300);
    expect(api.setClipFade).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    fireEvent.pointerUp(plus);
    advance(1000);
    await flush();
    expect(api.setClipFade).not.toHaveBeenCalled();
  });

  it("follows the keyboard's own repeat, saving once on key up", async () => {
    open(FADE);
    const plus = button("Fade in 1 ms longer");
    fireEvent.keyDown(plus, { key: "Enter" });
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(plus, { key: "Enter", repeat: true });
    }
    expect(fadeIn()).toBe(304);
    fireEvent.keyUp(plus, { key: "Enter" });
    fireEvent.click(plus);
    await flush();
    expect(api.setClipFade.mock.calls).toEqual([
      ["/tmp/p.json", "c2", 304, 0, { fade_in_ms: 300, fade_out_ms: 0 }],
    ]);
  });

  it("steps once for an assistive-technology click with no press", async () => {
    open(FADE);
    fireEvent.click(button("Fade in 1 ms shorter"));
    await flush();
    expect(api.setClipFade.mock.calls).toEqual([
      ["/tmp/p.json", "c2", 299, 0, { fade_in_ms: 300, fade_out_ms: 0 }],
    ]);
  });

  it("stops a held run at a neighbouring clip edge with a cue; a fresh press goes past", async () => {
    open(POINT);
    const later = button("Envelope point 0.01 s later");
    fireEvent.pointerDown(later, { button: 0 });
    advance(2000);
    const row = later.closest(".nudge-row");
    expect(row).toHaveAttribute("data-bump");
    expect(row?.querySelector("output")).toHaveTextContent("0:10.000");
    expect(announce).toHaveBeenLastCalledWith(
      "Envelope point stopped at a clip edge",
      { gesture: true },
    );
    fireEvent.pointerUp(later);
    await flush();
    expect(announce).toHaveBeenLastCalledWith(
      "Envelope point saved at a clip edge",
      { undo: null },
    );
    expect(api.setEnvelope.mock.calls).toEqual([
      [
        "/tmp/p.json",
        "host",
        [{ id: "e1", time: 10, value: 1 }],
        [{ id: "e1", time: 9.75, value: 1 }],
      ],
    ]);

    // The saved project now has the point on the edge.
    act(() =>
      useDawStore.getState().setProject({
        ...project,
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: [{ id: "e1", time: 10, value: 1 }],
          },
        ],
      }),
    );
    fireEvent.pointerDown(later, { button: 0 });
    fireEvent.pointerUp(later);
    await flush();
    expect(api.setEnvelope.mock.calls.at(-1)?.[2]).toEqual([
      { id: "e1", time: 10.01, value: 1 },
    ]);
  });

  it("stops at a hard limit and saves nothing when nothing moved", async () => {
    open(POINT);
    fireEvent.pointerDown(button("Envelope point level 0.5 dB higher"), {
      button: 0,
    });
    advance(2000);
    fireEvent.pointerUp(button("Envelope point level 0.5 dB higher"));
    await flush();
    expect(api.setEnvelope.mock.calls.map((c) => c[2])).toEqual([
      [{ id: "e1", time: 9.75, value: 1.5 }],
    ]);
    expect(announce).toHaveBeenCalledWith(
      "Envelope point level is at its limit",
      { gesture: true },
    );
  });

  it("does not preview or save an envelope nudge while the shared layer is hidden", async () => {
    open(POINT);
    act(() => useDawStore.getState().setLayerVisible("showLevels", false));
    const plus = button("Envelope point level 0.5 dB higher");
    expect(plus).toHaveAttribute("aria-disabled", "true");

    fireEvent.pointerDown(plus, { button: 0 });
    fireEvent.pointerUp(plus);
    fireEvent.click(plus);
    await flush();

    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).toEqual([{ id: "e1", time: 9.75, value: 1 }]);
  });

  it.each([
    { kind: "level", button: "Envelope point level 0.5 dB higher" },
    { kind: "time", button: "Envelope point 0.01 s later" },
  ])(
    "discards an active envelope $kind preview when the layer is hidden and shown before release",
    async ({ button: name }) => {
      open(POINT);
      const plus = button(name);
      fireEvent.pointerDown(plus, { button: 0 });
      advance(300);
      expect(
        useDawStore
          .getState()
          .project!.envelopes.find((envelope) => envelope.track_id === "host")
          ?.points,
      ).not.toEqual([{ id: "e1", time: 9.75, value: 1 }]);

      act(() => useDawStore.getState().setLayerVisible("showLevels", false));
      act(() => useDawStore.getState().setLayerVisible("showLevels", true));
      advance(600);
      fireEvent.pointerUp(plus);
      fireEvent.click(plus, { detail: 1 });
      await flush();

      expect(api.setEnvelope).not.toHaveBeenCalled();
      expect(
        useDawStore
          .getState()
          .project!.envelopes.find((envelope) => envelope.track_id === "host")
          ?.points,
      ).toEqual([{ id: "e1", time: 9.75, value: 1 }]);
    },
  );

  it("hiding after a comment merge discards only the envelope preview", async () => {
    open(POINT);
    const plus = button("Envelope point level 0.5 dB higher");
    fireEvent.pointerDown(plus, { button: 0 });
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).not.toEqual([{ id: "e1", time: 9.75, value: 1 }]);

    mergeReturnedComment(sampleComment({ id: "c-merged", body: "Published" }));
    act(() => useDawStore.getState().setLayerVisible("showLevels", false));
    fireEvent.pointerUp(plus);
    await flush();

    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(useDawStore.getState().project?.comments).toContainEqual(
      sampleComment({ id: "c-merged", body: "Published" }),
    );
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).toEqual([{ id: "e1", time: 9.75, value: 1 }]);
  });

  it.each(["returned comment", "guest action"] as const)(
    "keeps a %s merge when a repeated envelope preview is hidden",
    async (kind) => {
      const origin = structuredClone(project);
      origin.comments = [
        sampleComment({
          id: "c1",
          body: "Before",
          action_items: [
            {
              id: "a1",
              text: "Review",
              done: false,
              completed_at: null,
              completed_by: null,
            },
          ],
        }),
      ];
      open(POINT, origin);
      const plus = button("Envelope point level 0.5 dB higher");
      fireEvent.pointerDown(plus, { button: 0 });
      if (kind === "returned comment")
        mergeReturnedComment({ ...origin.comments[0]!, body: "Published" });
      else mergeGuestActionDone("c1", "a1", true);
      advance(600);

      expect(
        useDawStore
          .getState()
          .project!.envelopes.find((envelope) => envelope.track_id === "host")
          ?.points,
      ).not.toEqual([{ id: "e1", time: 9.75, value: 1 }]);
      act(() => useDawStore.getState().setLayerVisible("showLevels", false));
      act(() => useDawStore.getState().setLayerVisible("showLevels", true));
      fireEvent.pointerUp(plus);
      fireEvent.click(plus, { detail: 1 });
      await flush();

      const shown = useDawStore.getState().project!;
      expect(api.setEnvelope).not.toHaveBeenCalled();
      expect(
        shown.envelopes.find((envelope) => envelope.track_id === "host")
          ?.points,
      ).toEqual([{ id: "e1", time: 9.75, value: 1 }]);
      expect(shown.comments[0]?.body).toBe(
        kind === "returned comment" ? "Published" : "Before",
      );
      expect(shown.comments[0]?.action_items[0]?.done).toBe(
        kind === "guest action",
      );
    },
  );

  it("keeps a newer authoritative envelope when hiding a stale preview", async () => {
    open(POINT);
    const plus = button("Envelope point level 0.5 dB higher");
    fireEvent.pointerDown(plus, { button: 0 });
    const fresh = structuredClone(project);
    fresh.envelopes[0]!.points[0]!.value = 0.75;
    applyDocumentSnapshot({ server_seq: 1, project: fresh });

    act(() => useDawStore.getState().setLayerVisible("showLevels", false));
    fireEvent.pointerUp(plus);
    await flush();

    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).toEqual([{ id: "e1", time: 9.75, value: 0.75 }]);
  });

  it.each(["pointer", "key"] as const)(
    "keeps a newer authoritative envelope after a %s repeat and hide",
    async (input) => {
      open(POINT);
      const plus = button("Envelope point level 0.5 dB higher");
      if (input === "pointer") fireEvent.pointerDown(plus, { button: 0 });
      else fireEvent.keyDown(plus, { key: "Enter" });
      const fresh = structuredClone(project);
      fresh.envelopes[0]!.points[0]!.value = 0.75;
      applyDocumentSnapshot({ server_seq: 1, project: fresh });
      if (input === "pointer") advance(600);
      else fireEvent.keyDown(plus, { key: "Enter", repeat: true });

      act(() => useDawStore.getState().setLayerVisible("showLevels", false));
      act(() => useDawStore.getState().setLayerVisible("showLevels", true));
      if (input === "pointer") fireEvent.pointerUp(plus);
      else fireEvent.keyUp(plus, { key: "Enter" });
      if (input === "pointer") fireEvent.click(plus, { detail: 1 });
      await flush();

      expect(api.setEnvelope).not.toHaveBeenCalled();
      expect(
        useDawStore
          .getState()
          .project!.envelopes.find((envelope) => envelope.track_id === "host")
          ?.points,
      ).toEqual([{ id: "e1", time: 9.75, value: 0.75 }]);
    },
  );

  it("does not let an active envelope repeat write into a new project lifetime", async () => {
    open(POINT);
    const plus = button("Envelope point level 0.5 dB higher");
    fireEvent.pointerDown(plus, { button: 0 });
    const fresh = structuredClone(project);
    fresh.envelopes[0]!.points[0]!.value = 0.75;
    act(() => useDawStore.getState().hydrate("/tmp/other.json", fresh, null));
    advance(600);

    act(() => useDawStore.getState().setLayerVisible("showLevels", false));
    act(() => useDawStore.getState().setLayerVisible("showLevels", true));
    fireEvent.pointerUp(plus);
    fireEvent.click(plus, { detail: 1 });
    await flush();

    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(useDawStore.getState().projectPath).toBe("/tmp/other.json");
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).toEqual([{ id: "e1", time: 9.75, value: 0.75 }]);
  });

  it("keeps a replacement curve at the same sequence before a key repeat", async () => {
    open(POINT);
    const plus = button("Envelope point level 0.5 dB higher");
    fireEvent.keyDown(plus, { key: "Enter" });
    const fresh = structuredClone(project);
    fresh.envelopes[0]!.points[0]!.value = 0.75;
    applyDocumentSnapshot({ project: fresh });
    fireEvent.keyDown(plus, { key: "Enter", repeat: true });

    act(() => useDawStore.getState().setLayerVisible("showLevels", false));
    act(() => useDawStore.getState().setLayerVisible("showLevels", true));
    fireEvent.keyUp(plus, { key: "Enter" });
    await flush();

    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(useDawStore.getState().project!.envelopes[0]!.points).toEqual([
      { id: "e1", time: 9.75, value: 0.75 },
    ]);
  });

  it("relinquishes an envelope preview when a new sequence retains its curve", async () => {
    open(POINT);
    const plus = button("Envelope point level 0.5 dB higher");
    fireEvent.pointerDown(plus, { button: 0 });
    applyDocumentSnapshot({
      server_seq: 1,
      project: useDawStore.getState().project!,
    });
    advance(600);
    fireEvent.pointerUp(plus);
    fireEvent.click(plus, { detail: 1 });
    await flush();

    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(useDawStore.getState().project!.envelopes[0]!.points).toEqual([
      { id: "e1", time: 9.75, value: 1.059254 },
    ]);
  });

  it("keeps an accepted envelope save pending when the layer is hidden", async () => {
    const save = deferred<void>();
    api.setEnvelope.mockReturnValueOnce(save.promise);
    open(POINT);
    const plus = button("Envelope point level 0.5 dB higher");
    fireEvent.pointerDown(plus, { button: 0 });
    fireEvent.pointerUp(plus);
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);

    act(() => useDawStore.getState().setLayerVisible("showLevels", false));
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).toEqual([{ id: "e1", time: 9.75, value: 1.059254 }]);
    await act(async () => save.resolve());

    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).toEqual([{ id: "e1", time: 9.75, value: 1.059254 }]);
  });

  it("saves a manual ripple trim directly with its current boundary token", async () => {
    host.loadBoundaryContext.mockResolvedValue({ token: "ripple-token" });
    host.submit.mockImplementation(async () => {
      const saved = structuredClone(project);
      saved.clips.tracks.host[1].source_end = 39.9;
      saved.clips.tracks.host[1].timeline_end = 39.9;
      applyDocumentSnapshot({ server_seq: 1, project: saved });
      return { ok: true };
    });
    open(TRIM_END);
    const earlier = button("Trim end 0.1 s earlier");
    fireEvent.pointerDown(earlier, { button: 0 });
    expect(
      useDawStore.getState().project?.clips.tracks.host[1].source_end,
    ).toBe(39.9);
    fireEvent.pointerUp(earlier);
    await flush();
    await flush();
    expect(host.loadBoundaryContext.mock.calls[0]?.[1]).toEqual({
      kind: "trim",
      clip_id: "c2",
      edge: "out",
      mode: "ripple",
    });
    expect(host.submit.mock.calls[0]?.slice(1, 3)).toEqual([
      "TrimClipEdge",
      {
        clip_id: "c2",
        edge: "out",
        source_sec: 39.9,
        mode: "ripple",
        expected_token: "ripple-token",
      },
    ]);
    const state = useDawStore.getState();
    expect(state.project?.clips.tracks.host[1].source_end).toBe(39.9);
    expect(host.submit).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Trim saved", { undo: null });
  });

  it("offers envelope nudges to editors only (D-touch-input-grammar), and fade nudges from a guest without edit", () => {
    open(POINT, project, "share:tok");
    act(() => useDawStore.setState({ shareCapabilities: ["comment"] }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("1.00× at 00:09.750");
    act(() => useDawStore.setState({ shareCapabilities: ["edit"] }));
    expect(
      screen.getByRole("group", { name: "Nudge envelope point level" }),
    ).toBeVisible();
    cleanup();
    open(FADE, project, "share:tok");
    act(() => useDawStore.setState({ shareCapabilities: ["comment"] }));
    expect(screen.queryByRole("group")).toBeNull();
    act(() => useDawStore.setState({ shareCapabilities: ["edit"] }));
    expect(screen.getByRole("group", { name: "Nudge fade in" })).toBeVisible();
  });
});
