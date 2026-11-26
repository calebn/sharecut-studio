import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../commands/execute";
import {
  resetServerClock,
  setServerClockOffsetForTests,
} from "../presence/clock";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import {
  clipRow,
  minimalProject,
  sampleTrack,
  sessionRoster,
} from "../test/fixtures";
import type { SessionClient } from "../types/session";
import { setRoleBubbleUp } from "../utils/roleBubble";
import { TimelinePresence } from "./TimelinePresence";
import { TimelineRuler } from "./TimelineRuler";

const leafRenders = vi.hoisted(() => vi.fn());

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

vi.mock("../system/Presence", async () => {
  const actual =
    await vi.importActual<typeof import("../system/Presence")>(
      "../system/Presence",
    );
  const Leaf = memo(function Leaf(
    props: Parameters<typeof actual.Presence>[0],
  ) {
    leafRenders(props);
    return <actual.Presence {...props} />;
  });
  return { ...actual, Presence: Leaf };
});

const NOW = 1_800_000_000_000;

function Host(
  props: Partial<React.ComponentProps<typeof TimelinePresence>> = {},
) {
  return (
    <TimelinePresence
      canvasWidthPx={600}
      viewportPx={300}
      zoomPxPerSec={10}
      laneHeight={80}
      markerLaneHeightPx={48}
      followingClientId={null}
      {...props}
    />
  );
}

const remote = (id: string, over: Partial<SessionClient> = {}) => ({
  client_id: id,
  role: "viewer",
  playhead_sec: 2,
  last_seen_ns: Date.now() * 1e6,
  meta: { display_name: id.toUpperCase() },
  ...over,
});

function seed(clients: SessionClient[]) {
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
      clips: {
        tracks: {
          host: [],
          guest: [
            clipRow({
              id: "c1",
              track_id: "guest",
              timeline_start: 10,
              timeline_end: 15,
            }),
          ],
        },
        clip_count: 1,
      },
    }),
  );
  useDawStore.setState({
    localClientId: "me",
    sessionRosterVersion: 5,
    sessionClients: sessionRoster([
      { client_id: "me", role: "viewer", playhead_sec: 1 },
      ...clients,
    ]),
  });
}

const persons = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>(".sys-presence-person"),
];
const xOf = (el: HTMLElement) => el.style.getPropertyValue("--sys-presence-x");

beforeEach(() => {
  leafRenders.mockClear();
  vi.mocked(execute).mockClear();
});

afterEach(() => {
  setRoleBubbleUp(false);
  // Unmount first: a mounted host would announce the roster reset below.
  cleanup();
  useDawStore.setState({
    rulerCovered: new Set(),
    pointerKind: "fine",
    guestMode: null,
    localClientId: null,
    sessionClients: sessionRoster([]),
    statusAnnouncement: "",
    scrollLeft: 0,
  });
  resetServerClock();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TimelinePresence", () => {
  it("reads the roster and local id, drawing each remote playhead and not the local one", () => {
    seed([remote("bea")]);
    const { container } = render(<Host />);
    const lines = persons(container);
    expect(lines).toHaveLength(1);
    expect(xOf(lines[0]!)).toBe("20px");
    expect(container.querySelector(".sys-presence-flag")?.textContent).toBe(
      "B",
    );
    act(() => useDawStore.setState({ sessionClients: sessionRoster([]) }));
    expect(persons(container)).toHaveLength(0);
    expect(container.querySelector(".sys-presence")).not.toBeNull();
  });

  it("draws nothing for the person you follow, playhead or selection", () => {
    seed([
      remote("bea", { meta: { selection: { kind: "clip", id: "c1" } } }),
      remote("cy"),
    ]);
    const { container, rerender } = render(<Host />);
    expect(persons(container)).toHaveLength(2);
    expect(container.querySelectorAll(".sys-presence-sel")).toHaveLength(1);
    rerender(<Host followingClientId="bea" />);
    expect(persons(container).map((el) => el.dataset.person)).toEqual(["cy"]);
    expect(container.querySelectorAll(".sys-presence-sel")).toHaveLength(0);
  });

  it("draws no playhead for an observer", () => {
    seed([remote("bea", { meta: { following: "cy" } })]);
    const { container } = render(<Host />);
    expect(persons(container)).toHaveLength(0);
  });

  it("places selections by the lane heights and the marker lane height it is given", () => {
    seed([remote("bea", { meta: { selection: { kind: "clip", id: "c1" } } })]);
    const { container, rerender } = render(<Host />);
    const sel = () =>
      container.querySelector<HTMLElement>(".sys-presence-sel")!.style;
    // Ruler 24 + marker lane 48 + one lane of 80 above the guest lane.
    expect(sel().getPropertyValue("--sys-presence-top")).toBe("152px");
    expect(sel().getPropertyValue("--sys-presence-height")).toBe("80px");
    expect(sel().getPropertyValue("--sys-presence-left")).toBe("100px");
    expect(sel().getPropertyValue("--sys-presence-right")).toBe("150px");
    rerender(<Host markerLaneHeightPx={72} laneHeight={96} />);
    expect(sel().getPropertyValue("--sys-presence-top")).toBe("192px");
    expect(sel().getPropertyValue("--sys-presence-height")).toBe("96px");
  });

  it("draws a point selection at its px minimum", () => {
    seed([
      remote("bea", {
        meta: { selection: { kind: "pending", track_id: "host", time: 3 } },
      }),
    ]);
    const { container } = render(<Host />);
    const s = container.querySelector<HTMLElement>(".sys-presence-sel")!.style;
    const w =
      Number.parseFloat(s.getPropertyValue("--sys-presence-right")) -
      Number.parseFloat(s.getPropertyValue("--sys-presence-left"));
    expect(w).toBeCloseTo(2);
  });

  it("sits in the ruler's own window for every scroll, with the leaf's start and width from it", () => {
    seed([remote("bea")]);
    for (const scrollLeft of [0, 299, 300, 650, 9_000]) {
      useDawStore.setState({ scrollLeft });
      const { container, unmount } = render(
        <>
          <TimelineRuler
            canvasWidthPx={9_600}
            viewportPx={300}
            sessionSec={960}
            zoomPxPerSec={10}
            fixedPlayhead={false}
            onSeek={vi.fn()}
            onFit={vi.fn()}
          />
          <Host canvasWidthPx={9_600} />
        </>,
      );
      const rulerWindow = container.querySelector<HTMLElement>(
        ".timeline-ruler-window",
      )!;
      const presenceWindow = container.querySelector<HTMLElement>(
        ".timeline-presence-window",
      )!;
      expect(presenceWindow.style.insetInlineStart).toBe(
        rulerWindow.style.insetInlineStart,
      );
      const left = Number.parseFloat(presenceWindow.style.insetInlineStart);
      const lastProps = leafRenders.mock.lastCall![0];
      expect(lastProps.start).toBeCloseTo(left / 10);
      expect(lastProps.width).toBe(
        Number.parseFloat(presenceWindow.style.inlineSize),
      );
      unmount();
    }
  });

  describe("flags you can press", () => {
    const pill = (c: HTMLElement) =>
      c.querySelector<HTMLElement>("button.sys-presence-hit");
    const anchor = () =>
      document.querySelector<HTMLElement>(".timeline-presence-anchor")!;
    const crowd = () =>
      seed([
        remote("bea", { playhead_sec: 2 }),
        remote("cy", { playhead_sec: 2.1 }),
        remote("di", { playhead_sec: 2.2 }),
      ]);

    it("jumps to a single person on click", async () => {
      seed([remote("bea")]);
      const { container } = render(<Host />);
      await userEvent.click(pill(container)!);
      expect(execute).toHaveBeenCalledExactlyOnceWith("presence.goTo", {
        clientId: "bea",
      });
    });

    it("is a plain mark, with no button, where the link cannot open where they are", () => {
      seed([
        remote("bea", {
          meta: { display_name: "BEA", ui: { tab: "history" } },
        }),
      ]);
      useDawStore.setState({ guestMode: "view" });
      const { container } = render(<Host />);
      expect(container.querySelector(".sys-presence-flag")).not.toBeNull();
      expect(container.querySelector("button")).toBeNull();
    });

    it("is a button for a guest whose link can open where they are", () => {
      useDawStore.setState({ guestMode: "view" });
      seed([remote("bea")]);
      const { container } = render(<Host />);
      expect(pill(container)).not.toBeNull();
    });

    it("sizes the press area from the pointer in use: 24 px for a mouse, 44 px for a finger", () => {
      seed([remote("bea")]);
      const { container, rerender } = render(<Host />);
      const side = () =>
        pill(container)!.style.getPropertyValue("--sys-presence-hit-w");
      expect(side()).toBe("24px");
      act(() => useDawStore.setState({ pointerKind: "coarse" }));
      rerender(<Host />);
      expect(side()).toBe("44px");
    });

    it("merges people whose press areas overlap into one +N flag", () => {
      crowd();
      const { container } = render(<Host />);
      expect(container.querySelectorAll(".sys-presence-line")).toHaveLength(3);
      expect(pill(container)).toHaveTextContent("+3");
    });

    it("opens a menu of the people beside the overlay, not inside it, and jumps from a row", async () => {
      crowd();
      const { container } = render(<Host />);
      await userEvent.click(pill(container)!);
      const menu = await screen.findByRole("menu", {
        name: "3 people near 0:02",
      });
      expect(menu.closest("[aria-hidden='true']")).toBeNull();
      expect(menu.closest(".sys-presence")).toBeNull();
      const rows = within(menu).getAllByRole("menuitem");
      expect(rows.map((row) => row.textContent)).toEqual([
        "BEA0:02",
        "CY0:02",
        "DI0:02",
      ]);
      await userEvent.click(rows[1]!);
      expect(execute).toHaveBeenCalledExactlyOnceWith("presence.goTo", {
        clientId: "cy",
      });
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("keeps the rows it opened with while the flag moves on, and closes when fewer than two remain", async () => {
      crowd();
      const { container } = render(
        <>
          <TimelineRuler
            canvasWidthPx={600}
            viewportPx={300}
            sessionSec={60}
            zoomPxPerSec={10}
            fixedPlayhead={false}
            onSeek={vi.fn()}
            onFit={vi.fn()}
          />
          <Host />
        </>,
      );
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      act(() =>
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer", playhead_sec: 1 },
            remote("bea", { playhead_sec: 2 }),
            remote("cy", { playhead_sec: 2.1 }),
            remote("di", { playhead_sec: 40 }),
          ]),
        }),
      );
      expect(
        within(screen.getByRole("menu")).getAllByRole("menuitem"),
      ).toHaveLength(3);
      act(() =>
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer", playhead_sec: 1 },
            remote("bea", { playhead_sec: 2 }),
            remote("cy", { playhead_sec: 40 }),
            remote("di", { playhead_sec: 90 }),
          ]),
        }),
      );
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(
        container.querySelector(".sys-ruler-body"),
      );
    });

    it("closes on Escape and returns focus to the flag", async () => {
      crowd();
      const { container } = render(<Host />);
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(pill(container));
    });

    it("closes on a press outside, and a press on the unseen trigger over its own pill closes it", async () => {
      crowd();
      const { container } = render(
        <>
          <button type="button">elsewhere</button>
          <Host />
        </>,
      );
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
      expect(screen.queryByRole("menu")).toBeNull();
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      await userEvent.click(anchor());
      expect(screen.queryByRole("menu")).toBeNull();
      await userEvent.click(pill(container)!);
      expect(await screen.findByRole("menu")).toBeInTheDocument();
    });

    it("anchors the menu to the pill's own box and reaches the trigger out to the press area", async () => {
      crowd();
      const { container } = render(<Host />);
      const box = (left: number, top: number, size: number) =>
        new DOMRect(left, top, size, size);
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        function (this: Element) {
          if (this.classList.contains("sys-presence-flag"))
            return box(30, 4, 16);
          if (this.classList.contains("sys-presence-hit"))
            return box(16, 0, 44);
          return new DOMRect();
        },
      );
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      const style = anchor().style;
      expect(style.getPropertyValue("--anchor-left")).toBe("30px");
      expect(style.getPropertyValue("--anchor-top")).toBe("4px");
      expect(style.getPropertyValue("--anchor-width")).toBe("16px");
      expect(style.getPropertyValue("--anchor-height")).toBe("16px");
      expect(style.getPropertyValue("--anchor-press-left")).toBe("-14px");
      expect(style.getPropertyValue("--anchor-press-top")).toBe("-4px");
      expect(style.getPropertyValue("--anchor-press-width")).toBe("44px");
      expect(style.getPropertyValue("--anchor-press-height")).toBe("44px");
    });

    it("hides its trigger from a virtual cursor and names the menu itself", async () => {
      crowd();
      const { container } = render(<Host />);
      await userEvent.click(pill(container)!);
      const menu = await screen.findByRole("menu", {
        name: "3 people near 0:02",
      });
      expect(anchor()).toHaveAttribute("aria-hidden", "true");
      expect(anchor()).toHaveAttribute("tabindex", "-1");
      expect(menu.closest("[aria-hidden='true']")).toBeNull();
      await expectNoA11yViolations(container);
    });

    it("closes when the window zooms or scrolls, and stays shut", async () => {
      crowd();
      const { container, rerender } = render(<Host canvasWidthPx={1200} />);
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      rerender(<Host zoomPxPerSec={20} canvasWidthPx={1200} />);
      expect(screen.queryByRole("menu")).toBeNull();
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      act(() => useDawStore.setState({ scrollLeft: 700 }));
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("leaves focus where the press put it after a press on empty space", async () => {
      crowd();
      const { container } = render(
        <>
          <div data-testid="empty">empty</div>
          <TimelineRuler
            canvasWidthPx={600}
            viewportPx={300}
            sessionSec={60}
            zoomPxPerSec={10}
            fixedPlayhead={false}
            onSeek={vi.fn()}
            onFit={vi.fn()}
          />
          <Host />
        </>,
      );
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      await userEvent.click(screen.getByTestId("empty"));
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(document.body);
    });

    it("drops a person who left from an open list while two remain", async () => {
      crowd();
      const { container } = render(<Host />);
      await userEvent.click(pill(container)!);
      await screen.findByRole("menu");
      act(() =>
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer", playhead_sec: 1 },
            remote("bea", { playhead_sec: 2 }),
            remote("cy", { playhead_sec: 2.1 }),
          ]),
        }),
      );
      const menu = screen.getByRole("menu");
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((row) => row.textContent),
      ).toEqual(["BEA0:02", "CY0:02"]);
    });

    it("says how many were near even where the link opens only some of them", async () => {
      seed([
        remote("bea", { playhead_sec: 2 }),
        remote("cy", {
          playhead_sec: 2.1,
          meta: { display_name: "CY", ui: { tab: "history" } },
        }),
      ]);
      useDawStore.setState({ guestMode: "view" });
      const { container } = render(<Host />);
      await userEvent.click(pill(container)!);
      const menu = await screen.findByRole("menu");
      expect(menu).toHaveTextContent("2 people here");
      expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    });

    it("lists only the people the link can open where they are", async () => {
      seed([
        remote("bea", { playhead_sec: 2 }),
        remote("cy", {
          playhead_sec: 2.1,
          meta: { display_name: "CY", ui: { tab: "history" } },
        }),
      ]);
      useDawStore.setState({ guestMode: "view" });
      const { container } = render(<Host />);
      await userEvent.click(pill(container)!);
      const menu = await screen.findByRole("menu");
      expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    });

    it("fades the ruler label under a flag, and publishes the set only when it changes", () => {
      seed([remote("bea", { playhead_sec: 10 })]);
      render(<Host canvasWidthPx={9600} />);
      expect(useDawStore.getState().rulerCovered.size).toBeGreaterThan(0);
      const first = useDawStore.getState().rulerCovered;
      act(() =>
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer", playhead_sec: 1 },
            remote("bea", { playhead_sec: 10.1 }),
          ]),
        }),
      );
      expect(useDawStore.getState().rulerCovered).toBe(first);
      act(() =>
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer", playhead_sec: 1 },
            remote("bea", { playhead_sec: 14 }),
          ]),
        }),
      );
      expect(useDawStore.getState().rulerCovered.size).toBe(0);
    });
  });

  describe("announcer", () => {
    it("announces a departed client and says nothing for one that joins", () => {
      seed([]);
      const { rerender } = render(<Host />);
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([remote("bea")]),
        });
      });
      rerender(<Host />);
      expect(useDawStore.getState().statusAnnouncement).toBe("");
      act(() => {
        useDawStore.setState({ sessionClients: sessionRoster([]) });
      });
      rerender(<Host />);
      expect(useDawStore.getState().statusAnnouncement).toBe("Someone left");
    });

    it("drops a leave while a role bubble is up, and speaks the next one after it closes", () => {
      seed([remote("bea"), remote("cal")]);
      render(<Host />);
      setRoleBubbleUp(true);
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer" },
            remote("cal"),
          ]),
        });
      });
      expect(useDawStore.getState().statusAnnouncement).toBe("");
      setRoleBubbleUp(false);
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([{ client_id: "me", role: "viewer" }]),
        });
      });
      expect(useDawStore.getState().statusAnnouncement).toBe("Someone left");
    });

    it("announces nothing when a present client only moves", () => {
      seed([remote("bea")]);
      render(<Host />);
      const spy = vi.spyOn(useDawStore.getState(), "announceStatus");
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer" },
            remote("bea", { playhead_sec: 9 }),
          ]),
        });
      });
      expect(spy).not.toHaveBeenCalled();
      expect(useDawStore.getState().statusAnnouncement).toBe("");
    });

    it("announces a client already present at mount as nobody joining", () => {
      seed([remote("bea")]);
      render(<Host />);
      expect(useDawStore.getState().statusAnnouncement).toBe("");
    });

    it("drops and announces a client that stops heartbeating with no other store change", () => {
      vi.useFakeTimers({ now: NOW });
      const setIntervalSpy = vi.spyOn(window, "setInterval");
      const clearIntervalSpy = vi.spyOn(window, "clearInterval");
      seed([remote("bea", { last_seen_ns: Date.now() * 1e6 })]);
      const { container } = render(<Host />);
      expect(persons(container)).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(35_000);
      });
      expect(persons(container)).toHaveLength(0);
      expect(useDawStore.getState().statusAnnouncement).toBe("Someone left");
      const tickIds = setIntervalSpy.mock.calls.flatMap((call, i) =>
        call[1] === 5_000 ? [setIntervalSpy.mock.results[i]!.value] : [],
      );
      expect(tickIds.length).toBeGreaterThan(0);
      for (const id of tickIds) {
        expect(clearIntervalSpy).toHaveBeenCalledWith(id);
      }
    });
  });

  it("treats a just-seen client as stale when the server clock offset makes it look old", () => {
    seed([remote("bea")]);
    setServerClockOffsetForTests(60_000);
    const { container } = render(<Host />);
    expect(persons(container)).toHaveLength(0);
  });

  it("runs no staleness tick while there is no local client id", () => {
    vi.useFakeTimers({ now: NOW });
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    seed([remote("bea")]);
    useDawStore.setState({ localClientId: null });
    render(<Host />);
    expect(setIntervalSpy.mock.calls.some((call) => call[1] === 5_000)).toBe(
      false,
    );
  });

  describe("render isolation", () => {
    it("an unrelated store change re-renders neither the leaf nor its people", () => {
      seed([remote("a"), remote("b"), remote("c")]);
      render(<Host />);
      leafRenders.mockClear();
      act(() => {
        useDawStore.setState({ statusAnnouncement: "x" });
      });
      expect(leafRenders).not.toHaveBeenCalled();
    });

    it("a cursor-only change redraws nothing: people and selections keep their arrays", () => {
      seed([remote("a"), remote("b")]);
      render(<Host />);
      const before = leafRenders.mock.lastCall![0];
      leafRenders.mockClear();
      act(() => {
        useDawStore
          .getState()
          .applyPresenceDelta("a", { meta: { cursor: { x: 4, y: 5 } } }, 5);
      });
      expect(leafRenders).not.toHaveBeenCalled();
      expect(leafRenders.mock.calls).toHaveLength(0);
      expect(
        before.flags.flatMap((f: { people: unknown[] }) => f.people),
      ).toHaveLength(2);
    });

    it("a change of one client's name renders the leaf once and leaves the other's flag as it was by value", () => {
      seed([
        remote("a", { playhead_sec: 1 }),
        remote("b", { playhead_sec: 30 }),
      ]);
      render(<Host />);
      const before = leafRenders.mock.lastCall![0].flags;
      leafRenders.mockClear();
      act(() => {
        useDawStore
          .getState()
          .applyPresenceDelta("a", { meta: { display_name: "A2" } }, 5);
      });
      expect(leafRenders).toHaveBeenCalledTimes(1);
      const after = leafRenders.mock.lastCall![0].flags;
      expect(after.find((f: { key: string }) => f.key === "b")).toEqual(
        before.find((f: { key: string }) => f.key === "b"),
      );
      expect(
        after.find((f: { key: string }) => f.key === "a").people[0].name,
      ).toBe("A2");
    });

    it("a project edit that no selection reads re-renders nothing", () => {
      seed([remote("a", { meta: { selection: { kind: "clip", id: "c1" } } })]);
      render(<Host />);
      const first = leafRenders.mock.lastCall![0];
      leafRenders.mockClear();
      act(() => {
        const project = useDawStore.getState().project!;
        useDawStore.setState({ project: { ...project, chapters: [] } });
      });
      expect(leafRenders).not.toHaveBeenCalled();
      expect(first.selections).toHaveLength(1);
      // A rebuild that finds the same selection draws nothing new.
      act(() => {
        const project = useDawStore.getState().project!;
        useDawStore.setState({
          project: {
            ...project,
            clips: { ...project.clips, tracks: { ...project.clips.tracks } },
          },
        });
      });
      expect(leafRenders).not.toHaveBeenCalled();
      // Moving the selected clip does.
      act(() => {
        const project = useDawStore.getState().project!;
        useDawStore.setState({
          project: {
            ...project,
            clips: {
              ...project.clips,
              tracks: {
                ...project.clips.tracks,
                guest: [
                  clipRow({
                    id: "c1",
                    track_id: "guest",
                    timeline_start: 20,
                    timeline_end: 25,
                  }),
                ],
              },
            },
          },
        });
      });
      expect(leafRenders).toHaveBeenCalledTimes(1);
      expect(leafRenders.mock.lastCall![0].selections).not.toBe(
        first.selections,
      );
    });

    it("a zoom change keeps the rows and the selections that did not move", () => {
      seed([remote("a", { meta: { selection: { kind: "clip", id: "c1" } } })]);
      const { rerender } = render(<Host />);
      const first = leafRenders.mock.lastCall![0];
      rerender(<Host zoomPxPerSec={20} />);
      const second = leafRenders.mock.lastCall![0];
      expect(second.rows).toBe(first.rows);
      expect(second.selections).toBe(first.selections);
      expect(second.pxPerSecond).toBe(20);
    });
  });

  describe("playing playhead", () => {
    let frames: Map<number, FrameRequestCallback>;
    let nextId: number;
    let cancel: ReturnType<typeof vi.fn>;
    const flush = () => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(0);
    };

    beforeEach(() => {
      vi.useFakeTimers({
        now: NOW,
        toFake: ["Date", "setInterval", "clearInterval"],
      });
      frames = new Map();
      nextId = 0;
      cancel = vi.fn((id: number) => {
        frames.delete(id);
      });
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((cb: FrameRequestCallback) => {
          nextId += 1;
          frames.set(nextId, cb);
          return nextId;
        }),
      );
      vi.stubGlobal("cancelAnimationFrame", cancel);
    });
    afterEach(() => vi.unstubAllGlobals());

    const playing = (id = "bea", over: Partial<SessionClient> = {}) =>
      remote(id, {
        last_seen_ns: NOW * 1e6,
        meta: {
          display_name: id,
          transport: {
            playing: true,
            playhead_sec: 2,
            rate: 1,
            stamped_ns: NOW * 1e6,
          },
        },
        ...over,
      });

    it("runs no frame while nobody plays", () => {
      seed([remote("bea")]);
      render(<Host />);
      expect(frames.size).toBe(0);
      expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it("moves the line by whole px as the server clock advances, and renders only when a px changes", () => {
      seed([playing()]);
      const { container } = render(<Host />);
      expect(xOf(persons(container)[0]!)).toBe("20px");
      leafRenders.mockClear();
      // 10 ms at 10 px/s is a hundredth of a px: no new px, no render.
      vi.setSystemTime(NOW + 10);
      act(flush);
      expect(leafRenders).not.toHaveBeenCalled();
      vi.setSystemTime(NOW + 1_000);
      act(flush);
      expect(xOf(persons(container)[0]!)).toBe("30px");
      expect(leafRenders).toHaveBeenCalledTimes(1);
      vi.setSystemTime(NOW + 2_000);
      act(flush);
      expect(xOf(persons(container)[0]!)).toBe("40px");
    });

    it("ticks no one who is followed or following, and stops when the last player stops", () => {
      seed([playing("bea"), playing("cy", { meta: { following: "bea" } })]);
      const { rerender } = render(<Host followingClientId="bea" />);
      expect(frames.size).toBe(0);
      rerender(<Host />);
      expect(frames.size).toBe(1);
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer" },
            remote("bea"),
          ]),
        });
      });
      expect(cancel).toHaveBeenCalled();
      expect(frames.size).toBe(0);
    });

    it("cancels its frame on unmount", () => {
      seed([playing()]);
      const { unmount } = render(<Host />);
      expect(frames.size).toBe(1);
      unmount();
      expect(frames.size).toBe(0);
      expect(cancel).toHaveBeenCalled();
    });
  });

  describe("covered ruler labels", () => {
    const covered = () => [...useDawStore.getState().rulerCovered];

    it("publishes the ticks a flag sits over, and clears them when the person goes", () => {
      // 10 px/s: bea's line at 2 s is 20 px, her flag 21..37 over the 0:00 label.
      seed([remote("bea")]);
      render(<Host />);
      expect(covered()).toEqual(["0"]);
      act(() => useDawStore.setState({ sessionClients: sessionRoster([]) }));
      expect(covered()).toEqual([]);
    });

    it("publishes nothing for a flag between labels", () => {
      seed([remote("bea", { playhead_sec: 5 })]);
      render(<Host />);
      expect(covered()).toEqual([]);
    });

    it("publishes nothing for the person you follow", () => {
      seed([remote("bea")]);
      const { rerender } = render(<Host />);
      expect(covered()).toEqual(["0"]);
      rerender(<Host followingClientId="bea" />);
      expect(covered()).toEqual([]);
    });

    it("keeps the published set while a playhead moves and the covered ticks do not change", () => {
      seed([remote("bea", { playhead_sec: 2 })]);
      render(<Host />);
      const held = useDawStore.getState().rulerCovered;
      let notified = 0;
      const off = useDawStore.subscribe((s, prev) => {
        if (s.rulerCovered !== prev.rulerCovered) notified++;
      });
      for (const playhead_sec of [2.1, 2.2, 2.3]) {
        act(() =>
          useDawStore.setState({
            sessionClients: sessionRoster([
              { client_id: "me", role: "viewer", playhead_sec: 1 },
              remote("bea", { playhead_sec }),
            ]),
          }),
        );
      }
      off();
      expect(notified).toBe(0);
      expect(useDawStore.getState().rulerCovered).toBe(held);
    });

    it("lets go of a label only past the wider margin: the host hands its last set back", () => {
      const at = (sec: number) =>
        sessionRoster([
          { client_id: "me", role: "viewer", playhead_sec: 1 },
          remote("bea", { playhead_sec: sec }),
        ]);
      seed([remote("bea", { playhead_sec: 2 })]);
      const held = render(<Host />);
      expect(covered()).toEqual(["0"]);
      let heldAt = 2;
      for (let sec = 2.1; sec < 6; sec += 0.1) {
        act(() => useDawStore.setState({ sessionClients: at(sec) }));
        if (covered().length === 0) break;
        heldAt = sec;
      }
      expect(heldAt).toBeGreaterThan(2);
      held.unmount();
      seed([remote("bea", { playhead_sec: heldAt })]);
      render(<Host />);
      expect(covered()).toEqual([]);
    });

    it("publishes the flag's merged box: two people on one spot cover as one", () => {
      seed([remote("bea"), remote("cy")]);
      render(<Host />);
      expect(covered()).toEqual(["0"]);
    });

    it("clears on unmount", () => {
      seed([remote("bea")]);
      const { unmount } = render(<Host />);
      expect(covered()).toEqual(["0"]);
      unmount();
      expect(covered()).toEqual([]);
    });
  });

  it("has no axe violations", async () => {
    seed([remote("bea", { meta: { selection: { kind: "clip", id: "c1" } } })]);
    const { container } = render(<Host />);
    await expectNoA11yViolations(container);
  });
});
