import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { clearClipboard, setClipboard } from "../edit/clipboard";
import { useDawKeymapListener } from "../keymap/listener";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { stubRaf } from "../test/raf";
import type { CreateView, HitRouter } from "./hitRouting";
import { TimelineCreateMenu } from "./TimelineCreateMenu";
import type { CreateMenuPlace } from "./touchGrammar";

const executePointerCommand = vi.hoisted(() => vi.fn());
vi.mock("../commands/pointer", () => ({ executePointerCommand }));
vi.mock("../commands/execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/execute")>();
  return { ...actual, execute: vi.fn(actual.execute) };
});

let router: HitRouter;
let view: CreateView;
const place: CreateMenuPlace = {
  atTime: 12.5,
  trackId: "host",
  trackLabel: "Avery",
  lane: { top: 100, bottom: 204 },
};
const bounds = { left: 0, top: 0, right: 430, bottom: 700 };

function Keymap() {
  useDawKeymapListener();
  return null;
}

function tree(phone: boolean, over: Partial<CreateView> = {}, open = true) {
  const content = { view: { ...view, ...over }, place, router };
  const menu = phone ? (
    <TimelineCreateMenu {...content} phone />
  ) : (
    <TimelineCreateMenu
      {...content}
      bounds={bounds}
      avoidX={215}
      phone={false}
    />
  );
  return (
    <>
      <Keymap />
      {open ? menu : null}
    </>
  );
}

function mount(phone = false, over: Partial<CreateView> = {}) {
  return render(tree(phone, over));
}

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  clearClipboard();
  executePointerCommand.mockReset();
  executePointerCommand.mockResolvedValue({ status: "ok" });
  vi.mocked(execute).mockClear();
  useDawStore.setState({
    projectPath: "/tmp/ep.project.json",
    shareCapabilities: null,
    guestMode: null,
    project: minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
    selection: null,
    statusAnnouncement: "",
    feedbackToast: null,
  });
  router = {
    dispose: vi.fn(),
    defers: vi.fn(() => false),
    claimsClick: vi.fn(() => false),
    longPress: vi.fn(),
    choose: vi.fn(),
    openCreate: vi.fn(),
    close: vi.fn(),
    disarm: vi.fn(),
  };
  view = {
    origin: { x: 120, y: 150 },
    surface: document.body,
    fingerDown: false,
    over: null,
  };
});

afterEach(() => {
  cleanup();
  clearRegisteredCommands();
});

describe("TimelineCreateMenu popover form", () => {
  it("keeps same-title content and focus while using the current held place and numeric bounds", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(220);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(198);
    const reads = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(198);
    try {
      const at = (atTime: number, right: number) => (
        <TimelineCreateMenu
          view={{ ...view, origin: { x: 300, y: 500 } }}
          place={{ ...place, atTime }}
          router={router}
          bounds={{ left: 0, top: 0, right, bottom: 700 }}
          avoidX={null}
          phone={false}
        />
      );
      const { rerender } = render(at(12.5001, 600));
      const menu = screen.getByRole("menu");
      const first = screen.getAllByRole("menuitem")[0];
      await waitFor(() => expect(first).toHaveFocus());
      expect(menu.style.left).toBe("190px");
      rerender(at(12.5002, 300));
      expect(screen.getByRole("menu")).toBe(menu);
      expect(first).toHaveFocus();
      expect(menu.style.left).toBe("64px");
      expect(
        reads.mock.contexts.filter(
          (node) =>
            node instanceof HTMLElement &&
            node.classList.contains("edit-create-menu"),
        ),
      ).toHaveLength(1);
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Add chapter here" }),
      );
      expect(executePointerCommand).toHaveBeenCalledExactlyOnceWith(
        "edit.addChapter",
        { atTime: 12.5002 },
      );
      expect(router.close).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("remeasures changed-title content without a frame before focusing the new menu", () => {
    const raf = stubRaf();
    vi.stubGlobal("innerHeight", 300);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(220);
    const outer = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(500);
    const client = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(498);
    const reads = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(498);
    try {
      const { rerender } = render(
        <TimelineCreateMenu
          view={{ ...view, origin: { x: 300, y: 100 } }}
          place={place}
          router={router}
          bounds={{ left: 0, top: 0, right: 430, bottom: 300 }}
          avoidX={null}
          phone={false}
        />,
      );
      const old = screen.getByRole("menu");
      expect(old.style.maxBlockSize).toBe("268px");
      vi.stubGlobal("innerHeight", 800);
      outer.mockReturnValue(200);
      client.mockReturnValue(198);
      reads.mockReturnValue(198);
      rerender(
        <TimelineCreateMenu
          view={{ ...view, origin: { x: 300, y: 500 } }}
          place={{ ...place, atTime: 15.5 }}
          router={router}
          bounds={{ left: 0, top: 0, right: 600, bottom: 700 }}
          avoidX={null}
          phone={false}
        />,
      );
      const current = screen.getByRole("menu");
      expect(current).not.toBe(old);
      expect(current.style.maxBlockSize).toBe("");
      expect(current.style.top).toBe("276px");
      expect(
        reads.mock.contexts.filter(
          (node) =>
            node instanceof HTMLElement &&
            node.classList.contains("edit-create-menu"),
        ),
      ).toHaveLength(2);
      expect(raf.pendingCount()).toBe(1);
      act(() => {
        raf.fire(20);
      });
      expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Add chapter here" }),
      );
      expect(executePointerCommand).toHaveBeenCalledExactlyOnceWith(
        "edit.addChapter",
        { atTime: 15.5 },
      );
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("names the held time and lane, lists the rows, and announces without a toast", () => {
    mount();
    const menu = screen.getByRole("menu", { name: /^Create at .* · Avery$/ });
    expect(
      [...menu.querySelectorAll('[role="menuitem"]')].map((el) =>
        el.textContent?.trim().replace(/\s+/g, " "),
      ),
    ).toEqual([
      expect.stringMatching(/^Split here/),
      expect.stringMatching(/^Comment here/),
      expect.stringMatching(/^Add chapter here/),
      "Record here",
      "Add volume point",
    ]);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Create at 00:12.500 on Avery, 5 actions",
    );
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("counts the rows it shows, not the ones it could have", () => {
    setClipboard({
      timelineStart: 0,
      timelineEnd: 5,
      mode: "copy",
      extracts: [],
    });
    mount();
    expect(useDawStore.getState().statusAnnouncement).toMatch(/, 6 actions$/);
  });

  it("says each open once, however many times it renders", () => {
    const { rerender } = mount();
    useDawStore.setState({ statusAnnouncement: "", statusAnnouncementSeq: 0 });
    rerender(tree(false, { over: 1 }));
    rerender(tree(false, { over: 2 }));
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(0);
  });

  it("enters the top layer as a popover and leaves it on close", () => {
    const show = vi.spyOn(HTMLElement.prototype, "showPopover");
    const hide = vi.spyOn(HTMLElement.prototype, "hidePopover");
    const { unmount } = mount();
    const layer = document.body.querySelector(".timeline-create-layer");
    expect(layer).not.toBeNull();
    expect(show.mock.contexts).toContain(layer);
    unmount();
    expect(hide.mock.contexts).toContain(layer);
    show.mockRestore();
    hide.mockRestore();
  });

  it("mounts the menu only once its layer is showing, since the menu measures itself as it mounts and a closed popover has no size", () => {
    const menuAtShow: (Element | null)[] = [];
    const show = vi
      .spyOn(HTMLElement.prototype, "showPopover")
      .mockImplementation(() => {
        menuAtShow.push(document.querySelector(".edit-create-menu"));
      });
    try {
      mount();
      expect(menuAtShow).toEqual([null]);
      expect(document.querySelector(".edit-create-menu")).not.toBeNull();
    } finally {
      show.mockRestore();
    }
  });

  it("puts the held point where the finger is, with no conversion, and the mark on its lane", () => {
    mount();
    const layer = document.body.querySelector(".timeline-create-layer");
    expect(layer?.querySelector(".edit-create-menu")).not.toBeNull();
    const circle = layer?.querySelector(".edit-create-mark circle");
    expect(circle?.getAttribute("cx")).toBe("120");
    expect(circle?.getAttribute("cy")).toBe("150");
    const line = layer?.querySelector(".edit-create-mark line");
    expect([line?.getAttribute("y1"), line?.getAttribute("y2")]).toEqual([
      "100",
      "204",
    ]);
  });

  it("marks the row under a sliding finger", () => {
    mount(false, { fingerDown: true, over: 0 });
    expect(screen.getByRole("menuitem", { name: /^Split here/ })).toHaveClass(
      "is-over",
    );
  });

  it("closes from its scrim on any press, and keeps the native menu from opening there", () => {
    mount();
    const scrim = document.body.querySelector(".timeline-create-scrim");
    expect(scrim).not.toBeNull();
    expect(fireEvent.pointerDown(scrim as Element)).toBe(false);
    expect(router.close).toHaveBeenCalledOnce();
    expect(fireEvent.contextMenu(scrim as Element)).toBe(false);
    expect(router.close).toHaveBeenCalledOnce();
    expect(fireEvent.mouseDown(scrim as Element)).toBe(false);
    expect(executePointerCommand).not.toHaveBeenCalled();
  });

  it("closes the menu before it runs the picked row's command, at the held place", () => {
    mount();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Comment here/ }));
    expect(router.close).toHaveBeenCalledOnce();
    expect(executePointerCommand).toHaveBeenCalledWith("comment.draftAt", {
      atTime: 12.5,
      trackId: "host",
    });
    expect(vi.mocked(router.close).mock.invocationCallOrder[0]).toBeLessThan(
      executePointerCommand.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("turns the volume envelope on when it adds a point to a hidden one", async () => {
    useDawStore.getState().setLayerVisible("showLevels", false);
    mount();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add volume point" }));
    await waitFor(() =>
      expect(executePointerCommand).toHaveBeenCalledWith("envelope.addPoint", {
        atTime: 12.5,
        trackId: "host",
      }),
    );
    expect(useDawStore.getState().layers.showLevels).toBe(true);
  });

  it("takes its rows once, when it opens: a copy made while it is open does not add Paste", () => {
    const { rerender } = mount();
    setClipboard({
      timelineStart: 0,
      timelineEnd: 5,
      mode: "copy",
      extracts: [],
    });
    rerender(tree(false, { over: 1 }));
    expect(screen.queryByRole("menuitem", { name: "Paste" })).toBeNull();
  });

  it("leaves out a row a view-only link may not run", () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view", "play", "comment", "reply"],
      guestMode: "edit",
    });
    mount();
    expect(
      screen.getAllByRole("menuitem").map((el) => el.textContent?.trim()),
    ).toEqual([expect.stringMatching(/^Comment here/)]);
  });

  it("opens nothing, and closes at once, when the session may run no row here", () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view", "play"],
      guestMode: "view",
    });
    render(
      <TimelineCreateMenu
        view={view}
        place={{ ...place, trackId: null, trackLabel: null, lane: null }}
        router={router}
        bounds={bounds}
        avoidX={null}
        phone={false}
      />,
    );
    expect(
      document.querySelector(".timeline-create-layer .edit-create-menu"),
    ).toBeNull();
    expect(router.close).toHaveBeenCalledOnce();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("takes its rows afresh for a second open on another lane", () => {
    useDawStore.getState().setLayerVisible("showLevels", true);
    const at = (p: CreateMenuPlace) => (
      <TimelineCreateMenu
        view={view}
        place={p}
        router={router}
        bounds={bounds}
        avoidX={null}
        phone={false}
      />
    );
    const { rerender } = render(at(place));
    expect(
      screen.getByRole("menuitem", { name: "Add volume point" }),
    ).toBeVisible();
    rerender(at({ ...place, trackId: null, trackLabel: null, lane: null }));
    expect(
      screen.queryByRole("menuitem", { name: "Add volume point" }),
    ).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Create at 00:12.500, 4 actions",
    );
  });

  it("names no key on Split, whose chord is held while the menu is open", () => {
    mount();
    const split = screen.getByRole("menuitem", { name: /^Split here/ });
    expect(split).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("keeps Paste, and the focus on it, when the clipboard is cleared while it is open", async () => {
    setClipboard({
      timelineStart: 0,
      timelineEnd: 5,
      mode: "copy",
      extracts: [],
    });
    const { rerender } = mount();
    const paste = screen.getByRole("menuitem", { name: "Paste" });
    paste.focus();
    clearClipboard();
    rerender(tree(false, { over: 1 }));
    expect(screen.getByRole("menuitem", { name: "Paste" })).toBe(paste);
    expect(paste).toHaveFocus();
  });

  it("hands focus back to where the press began after a mouse pick", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = mount();
    await user.click(screen.getByRole("menuitem", { name: /^Comment here/ }));
    rerender(tree(false, {}, false));
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("closes on Escape without the keymap also clearing the selection", async () => {
    useDawStore.setState({ selection: { kind: "chapter", id: "c1", time: 1 } });
    const user = userEvent.setup();
    mount();
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")[0]).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    expect(router.close).toHaveBeenCalledOnce();
    expect(vi.mocked(execute)).not.toHaveBeenCalled();
    expect(useDawStore.getState().selection).not.toBeNull();
  });

  it("has no axe violations", async () => {
    mount();
    await expectNoA11yViolations(
      document.querySelector(".timeline-create-layer") as HTMLElement,
    );
  });
});

describe("TimelineCreateMenu focus after close", () => {
  function lane() {
    const row = document.createElement("div");
    row.className = "lane-row";
    row.dataset.trackId = "host";
    const empty = document.createElement("div");
    row.append(empty);
    document.body.append(row);
    return { row, empty };
  }

  it("lands on the held lane when the press target has no focusable of its own", async () => {
    const { row, empty } = lane();
    const { rerender } = mount(false, { surface: empty });
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")[0]).toHaveFocus(),
    );
    rerender(tree(false, { surface: empty }, false));
    await waitFor(() => expect(row).toHaveFocus());
    row.remove();
  });

  it("lands on the held lane after a phone Sheet goes", async () => {
    const { row, empty } = lane();
    const { unmount } = mount(true, { surface: empty });
    await screen.findByRole("dialog");
    unmount();
    await waitFor(() => expect(row).toHaveFocus());
    row.remove();
  });
});

describe("TimelineCreateMenu phone form", () => {
  it("keeps the phone Sheet and command target across unrelated parent commits without desktop geometry", async () => {
    const renderPhone = () => (
      <TimelineCreateMenu view={view} place={place} router={router} phone />
    );
    const { rerender } = render(renderPhone());
    const dialog = await screen.findByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    const chapter = screen.getByRole("button", { name: "Add chapter here" });
    rerender(renderPhone());
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByRole("button", { name: "Close" })).toBe(close);
    expect(close).toHaveFocus();
    rerender(renderPhone());
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByRole("button", { name: "Add chapter here" })).toBe(
      chapter,
    );
    expect(close).toHaveFocus();
    fireEvent.click(chapter);
    expect(router.close).toHaveBeenCalledOnce();
    expect(executePointerCommand).toHaveBeenCalledExactlyOnceWith(
      "edit.addChapter",
      {
        atTime: 12.5,
      },
    );
  });

  it("is the Sheet alone, named for the held time and lane, with no top-layer wrapper", async () => {
    mount(true);
    const dialog = await screen.findByRole("dialog", {
      name: "Create at 00:12.500 · Avery",
    });
    expect(
      [...dialog.querySelectorAll(".sys-row-btn")].map((el) => el.textContent),
    ).toEqual([
      "Split here",
      "Comment here",
      "Add chapter here",
      "Record here",
      "Add volume point",
    ]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.body.querySelector(".timeline-create-layer")).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Create at 00:12.500 on Avery, 5 actions",
    );
  });

  it("closes the menu, then runs the tapped row's command", async () => {
    mount(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Add chapter here" }),
    );
    expect(router.close).toHaveBeenCalledOnce();
    expect(executePointerCommand).toHaveBeenCalledWith("edit.addChapter", {
      atTime: 12.5,
    });
  });

  it("marks each Sheet row for the router, which picks the row a finger lifts over", async () => {
    mount(true);
    const dialog = await screen.findByRole("dialog");
    expect(
      [...dialog.querySelectorAll(".sys-row-btn")].map((el) =>
        el.getAttribute("data-create-item"),
      ),
    ).toEqual(["0", "1", "2", "3", "4"]);
    // The router replays that lift as one click: one pick, one command.
    fireEvent.click(dialog.querySelector('[data-create-item="1"]') as Element);
    expect(executePointerCommand).toHaveBeenCalledOnce();
  });

  it("hands focus to the ruler's position slider when it goes after a touch open, which focused nothing", async () => {
    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");
    slider.setAttribute("aria-label", "Timeline position");
    slider.tabIndex = 0;
    document.body.append(slider);
    const { unmount } = mount(true);
    await screen.findByRole("dialog");
    unmount();
    await waitFor(() => expect(slider).toHaveFocus());
    slider.remove();
  });

  it("closes on a press outside the Sheet, through a clear scrim of its own", async () => {
    mount(true);
    await screen.findByRole("dialog");
    const scrims = document.body.querySelectorAll(".timeline-create-scrim");
    expect(scrims).toHaveLength(1);
    expect(scrims[0]).toHaveAttribute("data-phone");
    expect(fireEvent.pointerDown(scrims[0] as Element)).toBe(false);
    expect(router.close).toHaveBeenCalledOnce();
  });

  it("closes on Escape and Close, and holds every other key from the keymap while open", async () => {
    const user = userEvent.setup();
    const { rerender } = mount(true);
    await screen.findByRole("dialog");
    // The Sheet focuses Close a frame after it mounts; wait for that, or it
    // lands after the blur below and the keys go to the button, not the keymap.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
    );
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard(" ");
    await user.keyboard("{Control>}z{/Control}");
    await user.keyboard("k");
    expect(vi.mocked(execute)).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(router.close).toHaveBeenCalledOnce();
    expect(vi.mocked(execute)).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(router.close).toHaveBeenCalledTimes(2);

    rerender(tree(true, {}, false));
    await user.keyboard("k");
    await waitFor(() => expect(vi.mocked(execute)).toHaveBeenCalled());
  });

  it("has no axe violations", async () => {
    mount(true);
    await screen.findByRole("dialog");
    await expectNoA11yViolations(document.body);
  });
});
