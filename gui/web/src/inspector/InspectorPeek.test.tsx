import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ProjectView, Selection } from "../types/project";
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
const announce = vi.fn<(message: string) => void>();

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
  api.setClipFade.mockReset().mockResolvedValue(undefined);
  api.setEnvelope.mockReset().mockResolvedValue(undefined);
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
    expect(api.setClipFade.mock.calls).toEqual([["/tmp/p.json", "c2", 310, 0]]);
    expect(announce).toHaveBeenLastCalledWith("Fade saved");
    vi.useRealTimers();
    await expectNoA11yViolations(group);
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
    expect(api.setClipFade.mock.calls).toEqual([["/tmp/p.json", "c2", 309, 0]]);
  });

  it("stops repeating when the finger leaves the button or the press is cancelled", async () => {
    open(FADE);
    const plus = button("Fade in 1 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    advance(500);
    fireEvent.pointerLeave(plus);
    advance(1000);
    await flush();
    expect(api.setClipFade.mock.calls).toEqual([["/tmp/p.json", "c2", 302, 0]]);

    fireEvent.pointerDown(plus, { button: 0 });
    fireEvent.pointerCancel(plus);
    advance(1000);
    await flush();
    expect(api.setClipFade.mock.calls.at(-1)).toEqual([
      "/tmp/p.json",
      "c2",
      303,
      0,
    ]);
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
    expect(api.setClipFade.mock.calls).toEqual([["/tmp/p.json", "c2", 304, 0]]);
  });

  it("steps once for an assistive-technology click with no press", async () => {
    open(FADE);
    fireEvent.click(button("Fade in 1 ms shorter"));
    await flush();
    expect(api.setClipFade.mock.calls).toEqual([["/tmp/p.json", "c2", 299, 0]]);
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
    );
    fireEvent.pointerUp(later);
    await flush();
    expect(announce).toHaveBeenLastCalledWith(
      "Envelope point saved at a clip edge",
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
    fireEvent.pointerDown(button("Envelope point level 0.1 higher"), {
      button: 0,
    });
    advance(2000);
    fireEvent.pointerUp(button("Envelope point level 0.1 higher"));
    await flush();
    expect(api.setEnvelope.mock.calls.map((c) => c[2])).toEqual([
      [{ id: "e1", time: 9.75, value: 1.5 }],
    ]);
    expect(announce).toHaveBeenCalledWith(
      "Envelope point level is at its limit",
    );
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
