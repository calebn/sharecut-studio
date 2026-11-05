import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDocumentAuthority } from "../document/authorityState";
import type { NudgeField } from "../edit/nudge";
import { useDawStore } from "../state/dawStore";
import type { AnnounceOptions } from "../state/types";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { parseHistoryEntryId } from "../types/project";
import { SheetNudge } from "./SheetNudge";

const api = vi.hoisted(() => ({ setClipFade: vi.fn(), setEnvelope: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  setClipFade: api.setClipFade,
  setEnvelope: api.setEnvelope,
}));

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
  clips: { tracks: { host: [clip] }, clip_count: 1 },
  envelopes: [
    {
      track_id: "host",
      parameter: "volume",
      points: [{ id: "e1", time: 9.75, value: 1 }],
    },
  ],
});
const FADE: NudgeField = {
  kind: "fade",
  edge: "in",
  trackId: "host",
  clipId: "c2",
};
const announce = vi.fn<(message: string, options?: AnnounceOptions) => void>();
const HEAD = parseHistoryEntryId("h-fade");

function open(
  ui: React.ReactElement,
  patch: Partial<ReturnType<typeof useDawStore.getState>> = {},
  path = "/tmp/p.json",
) {
  useDawStore.getState().hydrate(path, project, null);
  useDawStore.getState().setLayerVisible("showLevels", true);
  useDawStore.setState({ announceStatus: announce, ...patch });
  return render(ui);
}
const button = (name: string) => screen.getByRole("button", { name });
const flush = () => act(async () => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  resetDocumentAuthority("/tmp/p.json");
  api.setClipFade.mockReset().mockResolvedValue(HEAD);
  api.setEnvelope.mockReset().mockResolvedValue(null);
  announce.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("SheetNudge", () => {
  it("names the group and each step, and saves one press as one edit", async () => {
    open(<SheetNudge field={FADE} name="Fade in" />);
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
    const plus = button("Fade in 10 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    fireEvent.pointerUp(plus);
    fireEvent.click(plus);
    await flush();
    expect(api.setClipFade.mock.calls).toEqual([
      ["/tmp/p.json", "c2", 310, 0, { fade_in_ms: 300, fade_out_ms: 0 }],
    ]);
    expect(announce).toHaveBeenLastCalledWith("Fade saved", { undo: HEAD });
    vi.useRealTimers();
    await expectNoA11yViolations(group);
  });

  it("repeats while held and saves once", async () => {
    open(<SheetNudge field={FADE} name="Fade in" />);
    const plus = button("Fade in 1 ms longer");
    fireEvent.pointerDown(plus, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const held =
      useDawStore.getState().project?.clips.tracks.host[0]?.fade_in_ms;
    expect(held).toBeGreaterThan(302);
    fireEvent.pointerUp(plus);
    await flush();
    expect(api.setClipFade).toHaveBeenCalledTimes(1);
    expect(api.setClipFade.mock.calls[0]?.[2]).toBe(held);
  });

  it("ends a held run when the row stops drawing", async () => {
    const view = open(<SheetNudge field={FADE} name="Fade in" />);
    fireEvent.pointerDown(button("Fade in 1 ms longer"), { button: 0 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    view.rerender(<SheetNudge field={FADE} name="Fade in" hidden />);
    await flush();
    const at = useDawStore.getState().project?.clips.tracks.host[0]?.fade_in_ms;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(
      useDawStore.getState().project?.clips.tracks.host[0]?.fade_in_ms,
    ).toBe(at);
    expect(screen.queryByRole("group", { name: /Nudge/ })).toBeNull();
  });

  it("marks a trim nudge as a ripple, and a fade not", () => {
    const view = open(
      <SheetNudge
        field={{ kind: "trim", edge: "out", trackId: "host", clipId: "c2" }}
        name="Trim end"
      />,
    );
    expect(view.container.querySelector(".ripple-mark")).not.toBeNull();
    view.rerender(<SheetNudge field={FADE} name="Fade in" />);
    expect(view.container.querySelector(".ripple-mark")).toBeNull();
  });

  it("steps a key press by one fine step", async () => {
    open(<SheetNudge field={FADE} name="Fade in" />);
    const minus = button("Fade in 1 ms shorter");
    fireEvent.keyDown(minus, { key: "Enter" });
    fireEvent.keyUp(minus, { key: "Enter" });
    await flush();
    expect(api.setClipFade.mock.calls[0]?.[2]).toBe(299);
  });

  it("names the envelope level group", () => {
    open(
      <SheetNudge
        field={{
          kind: "envelope-level",
          trackId: "host",
          pointId: "e1",
        }}
        name="Envelope point level"
      />,
    );
    expect(
      screen.getByRole("group", { name: "Nudge envelope point level" }),
    ).toBeVisible();
  });

  it("disables the lower button at level 0 and keeps the higher one", () => {
    const silent = minimalProject({
      ...project,
      envelopes: [
        {
          track_id: "host",
          parameter: "volume",
          points: [{ id: "e1", time: 9.75, value: 0 }],
        },
      ],
    });
    open(
      <SheetNudge
        field={{ kind: "envelope-level", trackId: "host", pointId: "e1" }}
        name="Envelope point level"
      />,
      {},
    );
    act(() => useDawStore.getState().hydrate("/tmp/p.json", silent, null));
    expect(button("Envelope point level 0.5 dB lower")).toBeDisabled();
    expect(button("Envelope point level 0.5 dB higher")).toBeEnabled();
  });

  it("draws nothing for a field that is read-only", () => {
    open(<SheetNudge field={FADE} name="Fade in" hidden />);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("draws buttons for a link that can edit", () => {
    open(
      <SheetNudge field={FADE} name="Fade in" />,
      { shareCapabilities: ["edit"] },
      "share:tok",
    );
    expect(screen.getByRole("group", { name: "Nudge fade in" })).toBeVisible();
  });

  it("draws nothing for a link that cannot edit", () => {
    open(
      <SheetNudge field={FADE} name="Fade in" />,
      { shareCapabilities: ["comment"] },
      "share:tok",
    );
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("draws nothing for an envelope point without edit rights", () => {
    open(
      <SheetNudge
        field={{ kind: "envelope-time", trackId: "host", pointId: "e1" }}
        name="Envelope point"
      />,
      { shareCapabilities: ["comment"] },
      "share:tok",
    );
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("draws nothing for a pending edit that is missing", () => {
    open(
      <SheetNudge
        field={{
          kind: "pending",
          trackId: "host",
          editId: "nope",
          edge: "start",
        }}
        name="Pending cut start"
      />,
    );
    expect(screen.queryByRole("group")).toBeNull();
  });
});
