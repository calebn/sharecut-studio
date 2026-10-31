import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synchronizePlaybackClipLatches } from "../../audio/playbackClipLatches";
import { bindPlaybackMeterSource } from "../../audio/playbackMeterSource";
import { execute } from "../../commands/execute";
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import { selectedTrackIdsOf } from "../../state/selection";
import { DawProvider } from "../../state/store";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { TRACK_REORDER_MIME } from "../../tracks/trackReorder";
import { TrackColumn, type TrackColumnProps } from "./TrackColumn";

vi.mock("../../commands/execute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/execute")>()),
  execute: vi.fn(async () => ({ status: "ok" })),
}));

function KeymapHost() {
  useDawKeymapListener();
  return null;
}

const PATH = "/tmp/p.json";
const SHARE = "share:viewer-link";

function project(over: Partial<ReturnType<typeof sampleTrack>> = {}) {
  return minimalProject({
    tracks: [
      sampleTrack({ id: "host", label: "Host", ...over }),
      sampleTrack({ id: "guest", label: "Guest" }),
    ],
  });
}

function mount(props: TrackColumnProps = {}, initial = project()) {
  useDawStore.getState().hydrate(PATH, initial);
  return render(
    <DawProvider projectPath={PATH} initialProject={initial}>
      <KeymapHost />
      <TrackColumn {...props} />
    </DawProvider>,
  );
}

const select = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  useDawStore.setState({
    selection: null,
    inspectorKey: null,
    soloTracks: {},
    viewerMute: {},
    highlightStaleRender: false,
  });
  synchronizePlaybackClipLatches(-1, []);
  vi.mocked(execute).mockClear();
});

describe("TrackColumn deselect well and corner", () => {
  it("deselects all tracks when the leftover header well is clicked", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    useDawStore.getState().selectTracks(["host", "guest"]);
    const wells = screen.getAllByRole("button", {
      name: "Deselect all tracks",
    });
    expect(wells).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Tracks" })).toBeInTheDocument();
    await user.click(wells[0]);
    expect(execute).toHaveBeenCalledWith(
      "track.deselectAll",
      {},
      { skipWhen: true },
    );
    await expectNoA11yViolations(container);
  });

  it("deselects all tracks when leftover header chrome is clicked", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    const overlay = container.querySelector(".track-headers-deselect");
    expect(overlay?.tagName).toBe("DIV");
    expect(overlay).toHaveAttribute("role", "presentation");
    expect(overlay).not.toHaveAttribute("aria-hidden");
    expect(overlay).not.toHaveAttribute("title");
    await user.click(overlay as HTMLElement);
    expect(execute).toHaveBeenCalledWith(
      "track.deselectAll",
      {},
      { skipWhen: true },
    );
  });

  it("has no layout control in the ruler corner", async () => {
    const { container } = mount();
    expect(screen.queryByRole("button", { name: /Focus|Maximize/ })).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("puts one lane-high slot per track, in order, between the corner and the well", () => {
    const { container } = mount();
    const group = screen.getByRole("group", { name: "Tracks" });
    const rows = [...group.querySelectorAll(":scope > .track-column-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].previousElementSibling).toHaveClass("track-headers-chrome");
    expect(rows[1].nextElementSibling).toHaveClass("track-headers-well");
    expect(
      rows.map(
        (row) => row.querySelector(".sys-track-name")?.textContent ?? null,
      ),
    ).toEqual(["Host", "Guest"]);
    expect(container.querySelectorAll(".sys-track")).toHaveLength(2);
  });

  it("shows the add row under the last header", () => {
    mount({ addRow: <button type="button">Add</button> });
    const well = document.querySelector(".track-headers-well");
    expect(screen.getByRole("button", { name: "Add" }).nextElementSibling).toBe(
      well,
    );
  });
});

describe("TrackColumn selection", () => {
  it("keeps exclusive select when a header is clicked", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(select("Guest"));
    expect(selectedTrackIdsOf(useDawStore.getState().selection)).toEqual([
      "guest",
    ]);
    expect(select("Guest")).toHaveAttribute("aria-pressed", "true");
    expect(select("Host")).toHaveAttribute("aria-pressed", "false");
  });

  it("opens the track's details when its header is pressed, but not when it is added to a selection", async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard("{Shift>}");
    await user.click(select("Host"));
    await user.keyboard("{/Shift}");
    expect(useDawStore.getState().inspectorKey).toBeNull();
    await user.click(select("Guest"));
    expect(useDawStore.getState().inspectorKey).toBe("track:guest");
  });

  it("carries the track's presence anchors on the header, Mute and Solo", () => {
    const { container } = mount();
    expect(container.querySelector(".sys-track")).toHaveAttribute(
      "data-presence-anchor",
      "track:host",
    );
    expect(screen.getByRole("button", { name: "Mute Host" })).toHaveAttribute(
      "data-presence-anchor",
      "track:host:mute",
    );
    expect(screen.getByRole("button", { name: "Solo Host" })).toHaveAttribute(
      "data-presence-anchor",
      "track:host:solo",
    );
  });
});

describe("TrackColumn mixing", () => {
  it("runs the track commands for Mute, Solo and a typed level without selecting", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Mute Guest" }));
    await user.click(screen.getByRole("button", { name: "Solo Guest" }));
    screen.getByRole("spinbutton", { name: "Guest level" }).focus();
    await user.keyboard("{Enter}-6{Enter}");
    expect(vi.mocked(execute).mock.calls).toEqual([
      ["track.muteToggle", { trackId: "guest" }, { skipWhen: true }],
      ["track.soloToggle", { trackId: "guest" }, { skipWhen: true }],
      ["track.setVolume", { trackId: "guest", db: -6 }, { skipWhen: true }],
    ]);
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("shows the saved volume as the level, not the staging gain", () => {
    mount({}, project({ gain_db: -4, fader_db: 2.5 }));
    expect(
      screen.getByRole("spinbutton", { name: "Host level" }),
    ).toHaveAttribute("aria-valuenow", "2.5");
  });

  it("reads a saved mute, a listen-only mute and a mute your solo implies from the same state as the lane", () => {
    mount({}, project({ muted: true }));
    expect(select("Host")).toHaveAccessibleDescription("Muted in the mix");
    act(() => useDawStore.setState({ viewerMute: { guest: true } }));
    expect(select("Guest")).toHaveAccessibleDescription("Muted for you only");
    act(() => {
      useDawStore.setState({ viewerMute: {} });
      useDawStore.getState().setSoloMap({ host: true });
    });
    expect(select("Guest")).toHaveAccessibleDescription(
      "Silent while another track is soloed",
    );
    expect(screen.getByRole("button", { name: "Solo Host" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    act(() => useDawStore.getState().setSoloMap({ host: true, guest: true }));
    expect(select("Guest")).not.toHaveAccessibleDescription(
      "Silent while another track is soloed",
    );
  });

  it("fixes the level and a mix mute for a guest who cannot edit the mix", async () => {
    const user = userEvent.setup();
    const initial = project({ muted: true });
    useDawStore.getState().hydrate(SHARE, initial, "guest", ["comment"]);
    render(
      <DawProvider
        projectPath={SHARE}
        initialProject={initial}
        guestMode="guest"
        shareCapabilities={["comment"]}
      >
        <TrackColumn />
      </DawProvider>,
    );
    expect(
      screen.getByRole("spinbutton", { name: "Host level" }),
    ).toHaveAttribute("aria-readonly", "true");
    await user.click(screen.getByRole("button", { name: "Mute Host" }));
    expect(execute).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Solo Host" }));
    expect(execute).toHaveBeenCalledWith(
      "track.soloToggle",
      { trackId: "host" },
      { skipWhen: true },
    );
  });

  it.each([
    ["the select button", /^Guest$/],
    ["Mute", /^Mute Guest$/],
    ["Solo", /^Solo Guest$/],
  ])("Space on %s activates it instead of playing", async (_label, name) => {
    const user = userEvent.setup();
    mount();
    useDawStore.setState({ timelineFocused: true });
    screen.getByRole("button", { name }).focus();
    await user.keyboard(" ");
    expect(execute).not.toHaveBeenCalledWith(
      "transport.togglePlay",
      expect.anything(),
      expect.anything(),
    );
    expect(execute).not.toHaveBeenCalledWith("transport.togglePlay");
  });
});

describe("TrackColumn stems", () => {
  it("hollows the ring of a track with an out-of-date stem and says so", () => {
    const { container } = mount({}, project({ stem_is_fresh: false }));
    expect(container.querySelector(".sys-track")).toHaveAttribute(
      "data-rebuilding",
      "true",
    );
    expect(select("Host")).toHaveAccessibleDescription(
      "Rebuilding. Stem out of date",
    );
    expect(select("Host")).toHaveAttribute("title", "Stem out of date");
    expect(select("Guest")).not.toHaveAccessibleDescription();
  });

  it("shows no stale state for a new track with no audio, matching the status bar", () => {
    const { container } = mount(
      {},
      project({
        duration_sec: 0,
        media_path: undefined,
        stem_is_fresh: false,
      }),
    );
    expect(container.querySelector("[data-rebuilding]")).toBeNull();
  });

  it("names the reasons a whole track is out of date when stale highlighting is on", () => {
    const initial = minimalProject({
      tracks: [
        sampleTrack({ id: "host", label: "Host", stem_is_fresh: false }),
      ],
      render_status: {
        needs_rerender: true,
        reconciliation: { stale: true },
        premix: { exists: true },
        invalidations: [
          {
            id: "inv-1",
            reason: "fx",
            track_ids: ["host"],
            timeline_start: null,
            timeline_end: null,
          },
        ],
      } as never,
    });
    mount({}, initial);
    act(() => useDawStore.setState({ highlightStaleRender: true }));
    expect(select("Host")).toHaveAttribute("title", "Stem out of date: FX");
  });
});

describe("TrackColumn live level", () => {
  let tick: FrameRequestCallback | null = null;
  let unbind: (() => void) | null = null;
  const frame = (now: number) =>
    act(() => {
      tick?.(now);
    });

  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((next: FrameRequestCallback) => {
        tick = next;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => {
    unbind?.();
    unbind = null;
    act(() => useDawStore.setState({ isPlaying: false }));
    vi.unstubAllGlobals();
  });

  const levelOf = (index: number) =>
    document
      .querySelectorAll<HTMLElement>(".sys-track")
      [index].style.getPropertyValue("--sys-track-level");

  it("follows a playing track's peak in twelfths at about 8 Hz, and goes quiet when playback stops", () => {
    let peak = 0.1;
    unbind = bindPlaybackMeterSource({
      read: (id) => (id === "host" ? [peak] : [0]),
    });
    mount();
    expect(levelOf(0)).toBe("0");
    act(() => useDawStore.setState({ isPlaying: true, sourcePreview: null }));
    frame(1000);
    // 0.1 is -20 dBFS: two thirds of the way from -60 dB to 0.
    expect(Number(levelOf(0))).toBeCloseTo(8 / 12, 5);
    expect(levelOf(1)).toBe("0");
    peak = 0.5;
    frame(1050);
    expect(Number(levelOf(0))).toBeCloseTo(8 / 12, 5);
    frame(1200);
    expect(Number(levelOf(0))).toBeCloseTo(11 / 12, 5);
    act(() => useDawStore.setState({ isPlaying: false }));
    expect(levelOf(0)).toBe("0");
  });

  it("lights a clip light that stays lit across a stop, and badges the header", () => {
    unbind = bindPlaybackMeterSource({ read: () => [1] });
    const { container } = mount();
    act(() => useDawStore.setState({ isPlaying: true, sourcePreview: null }));
    frame(1000);
    expect(container.querySelector(".sys-track")).toHaveAttribute(
      "data-clipped",
      "true",
    );
    expect(select("Host")).toHaveAccessibleDescription("Clipped in playback");
    act(() => useDawStore.setState({ isPlaying: false }));
    expect(container.querySelector(".sys-track")).toHaveAttribute(
      "data-clipped",
      "true",
    );
  });

  it("freezes the ring but still lights clipping under reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("reduce"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    unbind = bindPlaybackMeterSource({ read: () => [1] });
    const { container } = mount();
    act(() => useDawStore.setState({ isPlaying: true, sourcePreview: null }));
    frame(1000);
    expect(levelOf(0)).toBe("0");
    expect(container.querySelector(".sys-track")).toHaveAttribute(
      "data-clipped",
      "true",
    );
  });
});

describe("TrackColumn reorder", () => {
  it("selects the track and asks to move it for Shift with an arrow on its select button", async () => {
    const user = userEvent.setup();
    mount();
    select("Guest").focus();
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(useDawStore.getState().selection).toEqual({
      kind: "track",
      trackId: "guest",
    });
    expect(execute).toHaveBeenCalledWith(
      "track.moveUp",
      { trackId: "guest" },
      { skipWhen: true },
    );
    select("Host").focus();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(execute).toHaveBeenLastCalledWith(
      "track.moveDown",
      { trackId: "host" },
      { skipWhen: true },
    );
  });

  function dataTransfer() {
    const data = new Map<string, string>();
    return {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      types: [] as string[],
      effectAllowed: "none",
      dropEffect: "none",
    };
  }

  function rowOf(name: string) {
    return select(name).closest(".track-column-row") as HTMLElement;
  }

  /** jsdom has no DragEvent, so give the event the pointer height a browser would. */
  function at(event: Event, y: number) {
    Object.defineProperty(event, "clientY", { value: y });
    return event;
  }

  function over(row: HTMLElement, y: number, dt: object) {
    row.getBoundingClientRect = () =>
      ({ top: 0, height: 100, bottom: 100 }) as DOMRect;
    fireEvent(row, at(createEvent.dragOver(row, { dataTransfer: dt }), y));
  }

  function dropAt(row: HTMLElement, y: number, dt: object) {
    fireEvent(row, at(createEvent.drop(row, { dataTransfer: dt }), y));
  }

  it("lifts the dragged header, draws the drop line on the header under it and moves the track on drop", () => {
    mount();
    const dt = dataTransfer();
    const source = document.querySelectorAll(".sys-track")[0] as HTMLElement;
    fireEvent.dragStart(source, { dataTransfer: dt });
    expect(dt.getData(TRACK_REORDER_MIME)).toBe("host");
    expect(source).toHaveAttribute("data-reorder", "lifted");
    expect(useDawStore.getState().selection).toEqual({
      kind: "track",
      trackId: "host",
    });
    over(rowOf("Guest"), 80, dt);
    expect(document.querySelectorAll(".sys-track")[1]).toHaveAttribute(
      "data-reorder",
      "after",
    );
    over(rowOf("Guest"), 10, dt);
    expect(document.querySelectorAll(".sys-track")[1]).toHaveAttribute(
      "data-reorder",
      "before",
    );
    over(rowOf("Guest"), 80, dt);
    dropAt(rowOf("Guest"), 80, dt);
    expect(execute).toHaveBeenCalledWith(
      "track.reorder",
      { trackId: "host", index: 1 },
      { skipWhen: true },
    );
    expect(document.querySelector("[data-reorder]")).toBeNull();
  });

  it("does nothing when the header is dropped where it already stands, and clears on drag end", () => {
    mount();
    const dt = dataTransfer();
    const source = document.querySelectorAll(".sys-track")[0] as HTMLElement;
    fireEvent.dragStart(source, { dataTransfer: dt });
    over(rowOf("Guest"), 10, dt);
    dropAt(rowOf("Guest"), 10, dt);
    expect(execute).not.toHaveBeenCalledWith(
      "track.reorder",
      expect.anything(),
      expect.anything(),
    );
    fireEvent.dragStart(source, { dataTransfer: dt });
    expect(source).toHaveAttribute("data-reorder", "lifted");
    fireEvent.dragEnd(source, { dataTransfer: dt });
    expect(document.querySelector("[data-reorder]")).toBeNull();
  });

  it("ignores a file dragged over a header so the audio drop still lands", () => {
    mount();
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    rowOf("Guest").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("is not draggable for someone who cannot change the project", () => {
    const initial = project();
    useDawStore.getState().hydrate(SHARE, initial, "guest", ["comment"]);
    const { container } = render(
      <DawProvider
        projectPath={SHARE}
        initialProject={initial}
        guestMode="guest"
        shareCapabilities={["comment"]}
      >
        <TrackColumn />
      </DawProvider>,
    );
    expect(container.querySelector(".sys-track")).not.toHaveAttribute(
      "draggable",
    );
  });
});

describe("TrackColumn forms and loading", () => {
  it("draws the 56 px avatar form on a phone: no Mute, Solo or level", () => {
    const { container } = mount({ form: "phone" });
    expect(container.querySelector(".sys-track")).toHaveAttribute(
      "data-form",
      "phone",
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Mute / })).toBeNull();
  });

  it("exposes the labeled loading headers as a group", async () => {
    useDawStore.setState({ project: null });
    const { container } = render(
      <DawProvider projectPath={PATH} initialProject={null}>
        <TrackColumn />
      </DawProvider>,
    );
    const headers = screen.getByRole("group", { name: "Tracks" });
    expect(headers).toHaveAttribute("aria-busy", "true");
    await expectNoA11yViolations(container);
  });

  it("has no accessibility violations in the default or phone form", async () => {
    for (const form of ["default", "phone"] as const) {
      const { container, unmount } = mount({ form });
      await expectNoA11yViolations(container);
      unmount();
    }
  });
});
