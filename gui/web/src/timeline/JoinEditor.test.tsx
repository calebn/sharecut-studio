import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClipJoin } from "../api";
import { LONG_PRESS_MS } from "../hooks/gestureConstants";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { place } from "../test/hitDom";
import { JoinEditor } from "./JoinEditor";

vi.mock("../api", () => ({ setClipJoin: vi.fn(async () => undefined) }));
const left = clipRow({
  id: "left",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  timeline_end: 5,
  fade_out_ms: 20,
});
const right = clipRow({
  id: "right",
  source_start: 5,
  source_end: 10,
  timeline_start: 5,
  timeline_end: 10,
  fade_in_ms: 20,
  join_in_mode: "crossfade",
  join_left_clip_id: "left",
  join_crossfade_ms: 20,
});
const releaseCapture = vi.fn();
const base = {
  left,
  right,
  seamSec: 5,
  zoomPxPerSec: 50,
  trackFadeMaxMs: null as number | null,
};
function mount(overrides: Partial<typeof base> = {}) {
  const props = { ...base, ...overrides };
  useDawStore.getState().setProject(
    minimalProject({
      tracks: [sampleTrack({ fade_max_ms: props.trackFadeMaxMs })],
      clips: { tracks: { host: [props.left, props.right] }, clip_count: 2 },
    }),
  );
  const view = render(
    <main className="timeline-area">
      <div className="lane-row">
        <JoinEditor {...props} />
      </div>
    </main>,
  );
  fireEvent.click(screen.getByRole("button", { name: /join at/ }));
  return { ...view, props };
}
function pointer(el: HTMLElement, type: string, x: number) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }));
}
function grip() {
  return screen.getByRole("button", { name: /Drag crossfade/ });
}
function move(x = 1010) {
  pointer(grip(), "pointerdown", 1000);
  pointer(grip(), "pointermove", x);
}
beforeEach(() => {
  vi.mocked(setClipJoin).mockReset().mockResolvedValue(undefined);
  useDawStore.getState().hydrate(
    "/tmp/episode.json",
    minimalProject({
      tracks: [sampleTrack()],
      clips: { tracks: { host: [left, right] }, clip_count: 2 },
    }),
  );
  useDawStore.setState({
    openJoinId: null,
    joinMutationInFlight: false,
    zoomPxPerSec: 50,
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  releaseCapture.mockClear();
  HTMLElement.prototype.releasePointerCapture = releaseCapture;
});
describe("JoinEditor coupled length", () => {
  it("previews a centered X, submits one doubled relative delta and restores authoritative paint", async () => {
    const { container } = mount();
    expect(container.querySelector(".join-blend")).toHaveStyle({
      left: "249.5px",
      width: "1px",
    });
    move();
    expect(container.querySelector(".join-blend")).toHaveStyle({
      left: "239.5px",
      width: "21px",
    });
    pointer(grip(), "pointerup", 1010);
    expect(setClipJoin).toHaveBeenCalledExactlyOnceWith(
      "/tmp/episode.json",
      "left",
      "right",
      "crossfade",
      420,
    );
    expect(container.querySelector(".join-blend")).toHaveStyle({
      left: "249.5px",
      width: "1px",
    });
    await act(async () => {});
    await expectNoA11yViolations(document.body);
  });
  it("uses final release coordinates even without a move event", () => {
    mount();
    pointer(grip(), "pointerdown", 1000);
    pointer(grip(), "pointerup", 1005);
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/episode.json",
      "left",
      "right",
      "crossfade",
      220,
    );
  });
  it.each(["pointercancel", "lostpointercapture"])(
    "cancels %s without a command",
    (event) => {
      const { container } = mount();
      move();
      pointer(grip(), event, 1010);
      pointer(grip(), "pointerup", 1010);
      expect(setClipJoin).not.toHaveBeenCalled();
      expect(container.querySelector(".join-blend")).toHaveStyle({
        width: "1px",
      });
    },
  );
  it("cancels Escape and unmount without a command", () => {
    const view = mount();
    move();
    fireEvent.keyDown(grip(), { key: "Escape" });
    expect(setClipJoin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /join at/ }));
    move();
    view.unmount();
    expect(setClipJoin).not.toHaveBeenCalled();
  });
  it("does not mutate on a click, tiny motion or returning to the original equal length", () => {
    mount();
    pointer(grip(), "pointerdown", 1000);
    pointer(grip(), "pointerup", 1001);
    move();
    pointer(grip(), "pointerup", 1000);
    expect(setClipJoin).not.toHaveBeenCalled();
  });
  it("does not normalize asymmetric saved paint until an intentional edit", () => {
    const r = { ...right, fade_in_ms: 80, join_crossfade_ms: 40 };
    const { container } = mount({ right: r });
    expect(
      screen.getByText(/Stored fades 20 ms out \/ 80 ms in/),
    ).toBeInTheDocument();
    pointer(grip(), "pointerdown", 1000);
    pointer(grip(), "pointerup", 1000);
    expect(setClipJoin).not.toHaveBeenCalled();
    expect(container.querySelector(".join-blend")).toHaveStyle({
      width: "2px",
      left: "249px",
    });
    move();
    pointer(grip(), "pointerup", 1000);
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/episode.json",
      "left",
      "right",
      "crossfade",
      40,
    );
  });
  it.each([
    "fade_in_ms",
    "fade_out_ms",
    "source_end",
    "timeline_start",
    "source_id",
  ] as const)("rejects a stale right %s change before release", (field) => {
    mount();
    move();
    act(() => {
      const p = useDawStore.getState().project!;
      useDawStore.getState().setProject({
        ...p,
        clips: {
          ...p.clips,
          tracks: {
            host: [
              left,
              { ...right, [field]: field === "source_id" ? "other" : 99 },
            ],
          },
        },
      });
    });
    pointer(grip(), "pointerup", 1010);
    expect(setClipJoin).not.toHaveBeenCalled();
  });
  it.each([
    "left_fade",
    "zoom",
    "cap",
    "adjacency",
    "capability",
    "roll",
    "project",
  ] as const)("cancels an active draft for %s", (change) => {
    if (change === "capability")
      useDawStore.setState({
        projectPath: shareProjectKey("token"),
        shareCapabilities: ["view", "edit"],
      });
    const view = mount(),
      target = grip();
    move();
    expect(view.container.querySelector(".join-blend")).toHaveStyle({
      width: "21px",
    });
    act(() => {
      const store = useDawStore.getState(),
        p = store.project!;
      if (change === "zoom") useDawStore.setState({ zoomPxPerSec: 100 });
      if (change === "capability")
        useDawStore.setState({ shareCapabilities: ["view"] });
      if (change === "project")
        store.hydrate("/tmp/other.json", minimalProject());
      if (change === "left_fade")
        store.setProject({
          ...p,
          clips: {
            ...p.clips,
            tracks: { host: [{ ...left, fade_in_ms: 10 }, right] },
          },
        });
      if (change === "cap")
        store.setProject({
          ...p,
          tracks: p.tracks.map((t) => ({ ...t, fade_max_ms: 30 })),
        });
      if (change === "adjacency")
        store.setProject({
          ...p,
          clips: { ...p.clips, tracks: { host: [right, left] } },
        });
    });
    if (change === "roll")
      view.rerender(
        <main className="timeline-area">
          <div className="lane-row">
            <JoinEditor {...base} rolling />
          </div>
        </main>,
      );
    pointer(target, "pointerup", 1010);
    expect(setClipJoin).not.toHaveBeenCalled();
    if (change === "project") expect(releaseCapture).toHaveBeenCalled();
  });
  it("shares native range input and the direct grip mutation lock", () => {
    vi.mocked(setClipJoin).mockImplementationOnce(() => new Promise(() => {}));
    mount();
    const range = screen.getByRole("slider", { name: "Length" });
    fireEvent.input(range, { target: { value: "30" } });
    fireEvent.change(range, { target: { value: "30" } });
    move();
    pointer(grip(), "pointerup", 1010);
    expect(setClipJoin).toHaveBeenCalledExactlyOnceWith(
      "/tmp/episode.json",
      "left",
      "right",
      "crossfade",
      30,
    );
  });
  it("keeps mutation failure visible and restores saved paint", async () => {
    vi.mocked(setClipJoin).mockRejectedValueOnce(new Error("join rejected"));
    const { container } = mount();
    move();
    pointer(grip(), "pointerup", 1010);
    expect(await screen.findByRole("alert")).toHaveTextContent("join rejected");
    expect(container.querySelector(".join-blend")).toHaveStyle({
      width: "1px",
    });
  });
  it("restores saved paint for queued completion without a saved announcement", async () => {
    vi.mocked(setClipJoin).mockResolvedValueOnce({ queued: true } as never);
    const { container } = mount();
    move();
    pointer(grip(), "pointerup", 1010);
    await act(async () => {});
    expect(container.querySelector(".join-blend")).toHaveStyle({
      width: "1px",
    });
    expect(screen.queryByText(/saved/i)).toBeNull();
  });
  it("ignores an old project rejection and preserves a new project lock", async () => {
    let reject: (e: Error) => void = () => {};
    vi.mocked(setClipJoin).mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    mount();
    move();
    pointer(grip(), "pointerup", 1010);
    act(() => {
      useDawStore.getState().hydrate("/tmp/new.json", minimalProject());
      useDawStore.getState().setJoinMutationInFlight(true);
    });
    await act(async () => reject(new Error("old error")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useDawStore.getState().joinMutationInFlight).toBe(true);
  });
  it.each([0, 1])(
    "keeps max %s legal and fixed without an enabled resizing control",
    (max) => {
      mount({ trackFadeMaxMs: max });
      expect(grip()).toBeDisabled();
      if (max === 1)
        expect(screen.getByRole("slider", { name: "Length" })).toBeDisabled();
      else expect(screen.queryByRole("slider", { name: "Length" })).toBeNull();
      if (max === 0)
        expect(
          screen.getByRole("button", { name: /^Crossfade$/ }),
        ).toBeDisabled();
    },
  );
  it.each(["reorder", "remove", "mode", "cap", "capability"] as const)(
    "rejects %s changes even before a prop refresh",
    (change) => {
      if (change === "capability")
        useDawStore.setState({
          projectPath: shareProjectKey("token"),
          shareCapabilities: ["view", "edit"],
        });
      const { container } = mount();
      act(() => {
        const store = useDawStore.getState(),
          p = store.project!;
        if (change === "capability") {
          useDawStore.setState({
            guestMode: "view",
            shareCapabilities: ["view"],
          });
          return;
        }
        const rows =
          change === "reorder"
            ? [right, left]
            : change === "remove"
              ? [right]
              : [
                  left,
                  change === "mode" ? { ...right, join_in_mode: "cut" } : right,
                ];
        store.setProject({
          ...p,
          tracks:
            change === "cap"
              ? p.tracks.map((t) => ({ ...t, fade_max_ms: 30 }))
              : p.tracks,
          clips: { ...p.clips, tracks: { host: rows } },
        });
      });
      const target = screen.queryByRole("button", { name: /Drag crossfade/ });
      if (target) {
        pointer(target, "pointerdown", 1000);
        pointer(target, "pointerup", 1010);
      }
      expect(setClipJoin).not.toHaveBeenCalled();
      expect(container.querySelector(".join-blend")).toHaveStyle({
        width: "1px",
      });
    },
  );
  it.each(["scroll", "resize"] as const)(
    "cancels %s during a draft",
    (type) => {
      mount();
      move();
      fireEvent(window, new Event(type));
      pointer(grip(), "pointerup", 1010);
      expect(setClipJoin).not.toHaveBeenCalled();
    },
  );
  it("cancels a native range draft without applying it", () => {
    mount();
    const range = screen.getByRole("slider", { name: "Length" });
    fireEvent.input(range, { target: { value: "30" } });
    fireEvent.pointerCancel(range);
    fireEvent.change(range, { target: { value: "30" } });
    expect(setClipJoin).not.toHaveBeenCalled();
  });
  it("holds asymmetric authoritative paint above the coupled maximum until intentional motion", () => {
    const { container } = mount({
      right: { ...right, fade_in_ms: 80, join_crossfade_ms: 40 },
      trackFadeMaxMs: 30,
    });
    pointer(grip(), "pointerdown", 1000);
    pointer(grip(), "pointermove", 1001);
    expect(container.querySelector(".join-blend")).toHaveStyle({
      width: "2px",
    });
    pointer(grip(), "pointerup", 1001);
    expect(setClipJoin).not.toHaveBeenCalled();
  });
  it("warns about reducing the right fade-out without projecting neighboring rows", () => {
    mount({
      right: { ...right, source_end: 5.5, timeline_end: 5.5, fade_out_ms: 300 },
      trackFadeMaxMs: null,
    });
    move();
    expect(
      screen.getByText(/right clip fade-out to 80 ms/),
    ).toBeInTheDocument();
  });
  it("does not paint a blocked contradictory projected overlap", () => {
    const { container } = mount({
      right: {
        ...right,
        join_crossfade_ms: 50,
        join_crossfade_blocked: "no_fade_in",
      },
    });
    expect(container.querySelector(".join-blend")).toBeNull();
  });
});
describe("JoinEditor crossfade grip on touch", () => {
  const touch = {
    pointerType: "touch",
    pointerId: 4,
    isPrimary: true,
    button: 0,
    clientY: 20,
  };
  beforeEach(() => {
    vi.useFakeTimers();
    document.elementFromPoint = () => null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  function placedGrip() {
    mount();
    const el = grip();
    place(el, { left: 978, top: 0, right: 1022, bottom: 44 });
    return el;
  }

  it("a finger sliding on the grip edits nothing", () => {
    const el = placedGrip();
    fireEvent.pointerDown(el, { ...touch, clientX: 1000 });
    fireEvent.pointerMove(el, { ...touch, clientX: 1040 });
    fireEvent.pointerUp(el, { ...touch, clientX: 1040 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });

    expect(el.hasAttribute("data-hit-armed")).toBe(false);
    expect(screen.queryByText(/Draft overlap/)).toBeNull();
    expect(setClipJoin).not.toHaveBeenCalled();
  });

  it("a long press arms the grip, which then drags and saves on lift", () => {
    const el = placedGrip();
    fireEvent.pointerDown(el, { ...touch, clientX: 1000 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(el.hasAttribute("data-hit-armed")).toBe(true);
    fireEvent.pointerMove(el, { ...touch, clientX: 1010 });
    expect(screen.getByText(/Draft overlap 420/)).toBeInTheDocument();
    fireEvent.pointerUp(el, { ...touch, clientX: 1010 });

    expect(el.hasAttribute("data-hit-armed")).toBe(false);
    expect(setClipJoin).toHaveBeenCalledExactlyOnceWith(
      "/tmp/episode.json",
      "left",
      "right",
      "crossfade",
      420,
    );
  });
});
