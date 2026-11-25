import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import {
  type ClipBleedSnapshot,
  clipBleedSession,
} from "../../edit/clipBleedSession";
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import {
  clipRow,
  editBoundaries,
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../../test/fixtures";
import {
  FakeResizeObserver,
  stubResizeObserver,
} from "../../test/resizeObserver";
import { stubViewportShell } from "../../test/viewportShell";
import { usePressedControl } from "../../ui";
import { EditWorkspace } from "./EditWorkspace";
import { InspectorHost } from "./InspectorHost";

const TRACK = { kind: "track", trackId: "host" } as const;

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(
    "/tmp/inspector-host/episode.sharecut",
    minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: {
        tracks: { host: [clipRow({ id: "c1", track_id: "host" })] },
        clip_count: 1,
      },
    }),
  );
  useDawStore.setState({
    stage: "edit",
    guestMode: null,
    scriptCollapsed: false,
    scriptFocus: false,
    editSurface: "lanes",
    openSheet: null,
    selection: TRACK,
    inspectorKey: null,
    rangeArmed: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRegisteredCommands();
});

/**
 * Gives the timeline scroller a box and every selection anchor a rect inside
 * it, or far outside while `away` is set; the pin is bounds math, and the
 * observer only says when to redo it.
 */
function stubAnchorBounds() {
  const state = { away: false };
  const rect = (l: number, t: number, r: number, b: number) =>
    ({
      x: l,
      y: t,
      left: l,
      top: t,
      right: r,
      bottom: b,
      width: r - l,
      height: b - t,
    }) as DOMRect;
  const spy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("timeline-scroll"))
        return rect(0, 0, 1000, 800);
      if (
        this.matches(
          ".lane-row, [data-clip-id], [data-pending-id], .range-overlay, .sys-script-word",
        )
      )
        return state.away
          ? rect(5000, 5000, 5100, 5040)
          : rect(100, 100, 200, 140);
      return rect(0, 0, 0, 0);
    });
  return { state, spy };
}

function Keys() {
  useDawKeymapListener();
  return null;
}

function PressedControls() {
  usePressedControl();
  return null;
}

const inspect = () =>
  act(async () => {
    await execute("edit.inspect", {}, { skipWhen: true });
  });

function opener() {
  const button = document.createElement("button");
  button.textContent = "Opener";
  document.body.append(button);
  button.focus();
  return button;
}

function pointerEvent(type: string, pointerId: number) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "button", { value: 0 });
  return event as PointerEvent;
}

describe("the Inspector card on the desktop and the tablet", () => {
  it.each(["desktop", "tablet"] as const)(
    "opens on Inspect and not on selection on the %s shell",
    async (shell) => {
      stubViewportShell(shell);
      render(<EditWorkspace />);
      expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
      await inspect();
      expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    },
  );

  it("anchors the card to the floating Action bar instead of the selected lane", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const root = document.createElement("div");
    root.getBoundingClientRect = () => new DOMRect(20, 50, 360, 400);
    const lane = document.createElement("div");
    lane.className = "lane-row";
    lane.dataset.trackId = "host";
    lane.getBoundingClientRect = () => new DOMRect(200, 100, 40, 60);
    const bar = document.createElement("div");
    bar.className = "sys-actions--floating";
    bar.getBoundingClientRect = () => new DOMRect(100, 177, 200, 40);
    root.append(lane, bar);
    document.body.append(root);

    try {
      render(
        <InspectorHost
          shell="desktop"
          root={root}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close: vi.fn(),
            dismiss: vi.fn(),
          }}
        />,
      );

      const card = screen.getByRole("dialog", { name: "Inspector" });
      expect(card.style.insetBlockStart).toBe("175px");
      expect(card.style.maxBlockSize).toBe("217px");
    } finally {
      root.remove();
    }
  });

  it("places the card again when the Action bar moves under it, or is replaced", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const root = document.createElement("div");
    root.getBoundingClientRect = () => new DOMRect(20, 50, 360, 400);
    const lane = document.createElement("div");
    lane.className = "lane-row";
    lane.dataset.trackId = "host";
    lane.getBoundingClientRect = () => new DOMRect(200, 100, 40, 60);
    const floatingBar = (top: string) => {
      const el = document.createElement("div");
      el.className = "sys-actions--floating";
      el.style.top = top;
      el.getBoundingClientRect = () =>
        new DOMRect(100, Number.parseFloat(el.style.top), 200, 40);
      return el;
    };
    const bar = floatingBar("177px");
    root.append(lane, bar);
    document.body.append(root);

    try {
      render(
        <InspectorHost
          shell="desktop"
          root={root}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close: vi.fn(),
            dismiss: vi.fn(),
          }}
        />,
      );
      const card = screen.getByRole("dialog", { name: "Inspector" });
      expect(card.style.insetBlockStart).toBe("175px");

      await act(async () => {
        bar.style.top = "227px";
      });

      await waitFor(() => expect(card.style.insetBlockStart).toBe("225px"));

      const replacement = floatingBar("227px");
      bar.replaceWith(replacement);
      await act(async () => {
        replacement.style.top = "127px";
      });

      await waitFor(() => expect(card.style.insetBlockStart).toBe("125px"));
    } finally {
      root.remove();
    }
  });

  it("clears the floating Action bar for a pending selection", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    useDawStore.setState({
      selection: { kind: "pending", id: "p1", trackId: "host" },
    });
    const ROOT = { x: 0, y: 49, width: 812, height: 326 };
    const CARD_WIDTH = 320;
    const root = document.createElement("div");
    root.getBoundingClientRect = () =>
      new DOMRect(ROOT.x, ROOT.y, ROOT.width, ROOT.height);
    const lane = document.createElement("div");
    lane.className = "lane-row";
    lane.dataset.trackId = "host";
    lane.getBoundingClientRect = () => new DOMRect(200, 100, 40, 60);
    const strip = document.createElement("div");
    strip.className = "sys-actions--floating";
    strip.style.left = "520px";
    strip.getBoundingClientRect = () =>
      new DOMRect(Number.parseFloat(strip.style.left), 194, 284, 46);
    root.append(lane, strip);
    document.body.append(root);
    try {
      render(
        <InspectorHost
          shell="desktop"
          root={root}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close: vi.fn(),
            dismiss: vi.fn(),
          }}
        />,
      );
      const card = screen.getByRole("dialog", { name: "Inspector" });
      const overlapArea = () => {
        const size = Number.parseFloat(card.style.maxBlockSize);
        const top = card.style.insetBlockStart
          ? ROOT.y + Number.parseFloat(card.style.insetBlockStart)
          : ROOT.y +
            ROOT.height -
            Number.parseFloat(card.style.insetBlockEnd) -
            size;
        const left = ROOT.x + Number.parseFloat(card.style.insetInlineStart);
        const bar = strip.getBoundingClientRect();
        const across =
          Math.min(left + CARD_WIDTH, bar.right) - Math.max(left, bar.left);
        const down = Math.min(top + size, bar.bottom) - Math.max(top, bar.top);
        return Math.max(0, across) * Math.max(0, down);
      };
      expect(overlapArea()).toBe(0);
      const before = card.style.insetInlineStart;

      await act(async () => {
        strip.style.left = "264px";
      });
      await waitFor(() => expect(card.style.insetInlineStart).not.toBe(before));
      expect(overlapArea()).toBe(0);
    } finally {
      root.remove();
    }
  });

  it.each(["no bar", "bar outside the measured root"] as const)(
    "falls back to the selected lane when there is %s",
    (barPlacement) => {
      vi.stubGlobal("IntersectionObserver", undefined);
      const root = document.createElement("div");
      root.getBoundingClientRect = () => new DOMRect(20, 50, 360, 400);
      const lane = document.createElement("div");
      lane.className = "lane-row";
      lane.dataset.trackId = "host";
      lane.getBoundingClientRect = () => new DOMRect(200, 100, 40, 60);
      root.append(lane);
      if (barPlacement === "bar outside the measured root") {
        const bar = document.createElement("div");
        bar.className = "sys-actions--floating";
        bar.getBoundingClientRect = () => new DOMRect(100, 177, 200, 40);
        document.body.append(bar);
      }
      document.body.append(root);

      try {
        render(
          <InspectorHost
            shell="desktop"
            root={root}
            regionRef={() => undefined}
            sheet={{
              open: true,
              rangeActionsInSheet: false,
              close: vi.fn(),
              dismiss: vi.fn(),
            }}
          />,
        );

        const card = screen.getByRole("dialog", { name: "Inspector" });
        expect(card.style.insetBlockStart).toBe("118px");
        expect(card.style.maxBlockSize).toBe("240px");
      } finally {
        root.remove();
        document.querySelector("body > .sys-actions--floating")?.remove();
      }
    },
  );

  it("takes the whole screen with Done where the frame is too short for a card", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const root = document.createElement("div");
    root.getBoundingClientRect = () => new DOMRect(20, 50, 360, 167);
    const lane = document.createElement("div");
    lane.className = "lane-row";
    lane.dataset.trackId = "host";
    lane.getBoundingClientRect = () => new DOMRect(200, 100, 40, 60);
    root.append(lane);
    document.body.append(root);
    const close = vi.fn();

    try {
      render(
        <InspectorHost
          shell="desktop"
          root={root}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close,
            dismiss: vi.fn(),
          }}
        />,
      );

      const dialog = screen.getByRole("dialog", { name: "Inspector" });
      expect(dialog.className).not.toContain("sys-inspector--card");
      expect(dialog.querySelector(".sys-inspector--takeover")).not.toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      root.remove();
    }
  });

  it("moves focus into the card on open and back to the opener on Escape", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const from = opener();
    await inspect();
    const card = screen.getByRole("dialog", { name: "Inspector" });
    expect(card).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });

  it("moves focus into the card on first entry when there is no opener", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    expect(document.activeElement).toBe(document.body);

    await inspect();

    const card = screen.getByRole("dialog", { name: "Inspector" });
    expect(card).toContainElement(document.activeElement as HTMLElement);
  });

  it("returns phone focus to the clicked header when focus was on body", () => {
    stubViewportShell("phone");
    useDawStore.getState().setSelection(null);
    render(
      <>
        <PressedControls />
        <EditWorkspace />
      </>,
    );
    const header = screen.getByRole("button", { name: "host" });
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(header, { detail: 1 });

    const sheet = screen.getByRole("dialog", { name: "Inspector" });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    act(() => {
      const state = useDawStore.getState();
      state.setSelection(null);
      state.setInspectorOpen(false);
    });

    expect(header).toHaveFocus();
  });

  it("returns phone focus to the header after the stage takes focus", () => {
    stubViewportShell("phone");
    useDawStore.getState().setSelection(null);
    render(
      <main className="stage-frame-body" aria-label="Edit" tabIndex={-1}>
        <PressedControls />
        <EditWorkspace />
      </main>,
    );
    const header = screen.getByRole("button", { name: "host" });
    const stage = screen.getByRole("main", { name: "Edit" });
    fireEvent.click(header, { detail: 1 });
    const sheet = screen.getByRole("dialog", { name: "Inspector" });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    stage.focus();
    act(() => {
      const state = useDawStore.getState();
      state.setSelection(null);
      state.setInspectorOpen(false);
    });
    expect(header).toHaveFocus();
  });

  it("returns phone focus to the header after focus leaves and re-enters", () => {
    stubViewportShell("phone");
    useDawStore.getState().setSelection(null);
    render(
      <>
        <PressedControls />
        <EditWorkspace />
      </>,
    );
    const header = screen.getByRole("button", { name: "host" });
    fireEvent.click(header, { detail: 1 });
    const sheet = screen.getByRole("dialog", { name: "Inspector" });
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    outside.focus();
    expect(outside).toHaveFocus();
    const anchor = sheet.querySelector<HTMLElement>("[data-inspector-anchor]");
    if (!anchor) throw new Error("Inspector keyboard anchor missing");
    anchor.focus();

    act(() => {
      const state = useDawStore.getState();
      state.setSelection(null);
      state.setInspectorOpen(false);
    });

    expect(header).toHaveFocus();
    outside.remove();
  });

  it("returns focus to the opener on Close and on a new selection", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const from = opener();
    await inspect();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(from).toHaveFocus();
    from.focus();
    await inspect();
    expect(from).not.toHaveFocus();
    act(() =>
      useDawStore
        .getState()
        .setSelection({ kind: "clip", id: "c1", trackId: "host" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });

  it("returns focus to the opener when the sheet of a split seam closes", async () => {
    stubViewportShell("desktop");
    const lane = [
      clipRow({
        id: "a",
        track_id: "host",
        source_start: 0,
        source_end: 2,
        timeline_start: 0,
        timeline_end: 2,
      }),
      clipRow({
        id: "b",
        track_id: "host",
        source_start: 2,
        source_end: 4,
        timeline_start: 2,
        timeline_end: 4,
        join_left_clip_id: "a",
      }),
    ];
    useDawStore.getState().hydrate(
      "/tmp/inspector-host/split.sharecut",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        clips: { tracks: { host: lane }, clip_count: 2 },
        edit_boundaries: editBoundaries(lane),
      }),
    );
    useDawStore.setState({
      selection: { kind: "seam", id: "eb:a:b", trackId: "host" },
    });
    render(<EditWorkspace />);
    const from = opener();
    await inspect();
    const card = screen.getByRole("dialog", { name: "Inspector" });
    expect(card).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(from).toHaveFocus();
    from.remove();
  });

  it("keeps the stage focused when it owns focus at Close", () => {
    stubViewportShell("phone");
    useDawStore.getState().setSelection(null);
    render(
      <main className="stage-frame-body" aria-label="Edit" tabIndex={-1}>
        <PressedControls />
        <EditWorkspace />
      </main>,
    );
    const header = screen.getByRole("button", { name: "host" });
    const stage = screen.getByRole("main", { name: "Edit" });
    fireEvent.click(header, { detail: 1 });
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();

    stage.focus();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(stage).toHaveFocus();
  });

  it.each(["desktop", "phone"] as const)(
    "returns focus to the opener after pointer Close moves focus to the stage on the %s shell",
    async (shell) => {
      stubViewportShell(shell);
      render(
        <main className="stage-frame-body" aria-label="Edit" tabIndex={-1}>
          <EditWorkspace />
        </main>,
      );
      const from = opener();
      await inspect();
      const close = screen.getByRole("button", { name: "Close" });
      const stage = screen.getByRole("main", { name: "Edit" });

      fireEvent.pointerDown(close, { button: 0, pointerId: 1 });
      fireEvent.mouseDown(close, { button: 0 });
      stage.focus();
      expect(stage).toHaveFocus();
      fireEvent.click(close, { detail: 1 });

      expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
      expect(from).toHaveFocus();
      from.remove();
    },
  );

  it.each(["desktop", "phone"] as const)(
    "keeps the Close receipt when another pointer is canceled on the %s shell",
    async (shell) => {
      stubViewportShell(shell);
      render(
        <main className="stage-frame-body" aria-label="Edit" tabIndex={-1}>
          <EditWorkspace />
        </main>,
      );
      const from = opener();
      await inspect();
      const close = screen.getByRole("button", { name: "Close" });
      const stage = screen.getByRole("main", { name: "Edit" });
      const closePress = pointerEvent("pointerdown", 1);
      const unrelatedCancel = pointerEvent("pointercancel", 2);

      fireEvent(close, closePress);
      fireEvent.mouseDown(close, { button: 0 });
      stage.focus();
      fireEvent(close, unrelatedCancel);
      fireEvent.click(close, { detail: 1 });

      expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
      expect(from).toHaveFocus();
      from.remove();
    },
  );

  it("keeps intentional outside focus from before a pointer close", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const from = opener();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    await inspect();
    outside.focus();

    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerDown(close, { button: 0, pointerId: 1 });
    fireEvent.mouseDown(close, { button: 0 });
    fireEvent.click(close, { detail: 1 });

    expect(outside).toHaveFocus();
    expect(from).not.toHaveFocus();
    outside.remove();
    from.remove();
  });

  it("keeps a different outside control focused after the close gesture starts", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const from = opener();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    await inspect();
    const close = screen.getByRole("button", { name: "Close" });

    fireEvent.pointerDown(close, { button: 0, pointerId: 1 });
    fireEvent.mouseDown(close, { button: 0 });
    outside.focus();
    fireEvent.click(close, { detail: 1 });

    expect(outside).toHaveFocus();
    expect(from).not.toHaveFocus();
    outside.remove();
    from.remove();
  });

  it("keeps the containing stage focused when it owned focus before pointerdown", async () => {
    stubViewportShell("desktop");
    render(
      <main className="stage-frame-body" aria-label="Edit" tabIndex={-1}>
        <EditWorkspace />
      </main>,
    );
    const from = opener();
    await inspect();
    const close = screen.getByRole("button", { name: "Close" });
    const stage = screen.getByRole("main", { name: "Edit" });
    stage.focus();

    fireEvent.pointerDown(close, { button: 0, pointerId: 1 });
    fireEvent.mouseDown(close, { button: 0 });
    fireEvent.click(close, { detail: 1 });

    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(stage).toHaveFocus();
    from.remove();
  });

  it("discards a canceled pointer close before the next keyboard closure", async () => {
    stubViewportShell("desktop");
    render(
      <main className="stage-frame-body" aria-label="Edit" tabIndex={-1}>
        <EditWorkspace />
      </main>,
    );
    const from = opener();
    await inspect();
    const close = screen.getByRole("button", { name: "Close" });
    const stage = screen.getByRole("main", { name: "Edit" });

    fireEvent.pointerDown(close, { button: 0, pointerId: 1 });
    fireEvent.mouseDown(close, { button: 0 });
    stage.focus();
    fireEvent.pointerCancel(close, { pointerId: 1 });
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    const anchor = screen
      .getByRole("dialog", { name: "Inspector" })
      .querySelector<HTMLElement>("[data-inspector-anchor]")!;
    anchor.focus();
    fireEvent.keyDown(anchor, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });

  it("does not use a canceled pointer receipt for a later Escape", async () => {
    stubViewportShell("desktop");
    render(
      <main className="stage-frame-body" aria-label="Edit" tabIndex={-1}>
        <EditWorkspace />
      </main>,
    );
    const from = opener();
    await inspect();
    const close = screen.getByRole("button", { name: "Close" });
    const stage = screen.getByRole("main", { name: "Edit" });

    fireEvent.pointerDown(close, { button: 0, pointerId: 1 });
    fireEvent.mouseDown(close, { button: 0 });
    stage.focus();
    fireEvent.pointerCancel(close, { pointerId: 1 });
    fireEvent.keyDown(
      screen.getByRole("dialog").querySelector(".sys-inspector-keys")!,
      { key: "Escape" },
    );

    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(stage).toHaveFocus();
    expect(from).not.toHaveFocus();
    from.remove();
  });

  it("does not restore focus to a removed opener after pointer Close", async () => {
    stubViewportShell("desktop");
    render(
      <main className="stage-frame-body" aria-label="Edit" tabIndex={-1}>
        <EditWorkspace />
      </main>,
    );
    const from = opener();
    await inspect();
    from.remove();
    const close = screen.getByRole("button", { name: "Close" });
    const stage = screen.getByRole("main", { name: "Edit" });

    fireEvent.pointerDown(close, { button: 0, pointerId: 1 });
    fireEvent.mouseDown(close, { button: 0 });
    stage.focus();
    fireEvent.click(close, { detail: 1 });

    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(stage).toHaveFocus();
  });

  it("keeps outside focus when selection replacement closes the Inspector", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const from = opener();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    await inspect();
    outside.focus();

    act(() =>
      useDawStore
        .getState()
        .setSelection({ kind: "clip", id: "c1", trackId: "host" }),
    );

    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(outside).toHaveFocus();
    expect(from).not.toHaveFocus();
    outside.remove();
    from.remove();
  });

  it("hides the card while its anchor is out of view and keeps the Inspector open", async () => {
    let notify = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const bounds = stubAnchorBounds();
    const report = (visible: boolean) => {
      bounds.state.away = !visible;
      notify();
    };
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    await inspect();
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    act(() => report(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().inspectorKey).not.toBeNull();
    act(() => report(true));
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    bounds.spy.mockRestore();
  });

  it("reveals an offscreen selected clip when Inspect opens", async () => {
    let refresh = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly observed = new Set<Element>();
        private readonly callback: IntersectionObserverCallback;

        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          refresh = () => {
            const scroller =
              document.querySelector<HTMLElement>(".timeline-scroll");
            if (!scroller) return;
            const viewport = scroller.getBoundingClientRect();
            for (const target of this.observed) {
              const rect = target.getBoundingClientRect();
              this.callback(
                [
                  {
                    isIntersecting:
                      rect.bottom > viewport.top && rect.top < viewport.bottom,
                  } as IntersectionObserverEntry,
                ],
                this as unknown as IntersectionObserver,
              );
            }
          };
        }

        observe(target: Element) {
          this.observed.add(target);
          refresh();
        }

        disconnect() {
          this.observed.clear();
        }
      },
    );
    stubViewportShell("desktop");
    const box = (top: number, bottom: number) =>
      ({
        x: 0,
        y: top,
        top,
        bottom,
        left: 0,
        right: 1200,
        width: 1200,
        height: bottom - top,
      }) as DOMRect;
    const rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const scrolled =
          this.closest<HTMLElement>(".timeline-scroll")?.scrollTop ?? 0;
        if (this.classList.contains("timeline-scroll")) return box(49, 844);
        if (this.classList.contains("edit-workspace")) return box(0, 900);
        if (this.classList.contains("timeline-ruler")) return box(49, 73);
        if (this.classList.contains("marker-lane")) return box(73, 97);
        if (this.classList.contains("lane-row"))
          return box(100 - scrolled, 196 - scrolled);
        if (this.getAttribute("data-clip-id") === "c1")
          return box(110 - scrolled, 160 - scrolled);
        return box(0, 0);
      });

    try {
      useDawStore.setState({
        selection: { kind: "clip", id: "c1", trackId: "host" },
      });
      render(<EditWorkspace />);
      const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
      const target = document.querySelector<HTMLElement>(
        '[data-clip-id="c1"]',
      )!;
      scroller.scrollTop = 159;
      expect(target.getBoundingClientRect().bottom).toBeLessThan(49);

      await inspect();
      act(() => refresh());

      const card = screen.getByRole("dialog", { name: "Inspector" });
      expect(card).toBeVisible();
      expect(card).toContainElement(document.activeElement as HTMLElement);
      expect(useDawStore.getState().selection).toEqual({
        kind: "clip",
        id: "c1",
        trackId: "host",
      });
      const viewport = scroller.getBoundingClientRect();
      const selectedClip = target.getBoundingClientRect();
      expect(selectedClip.bottom).toBeGreaterThan(viewport.top);
      expect(selectedClip.top).toBeLessThan(viewport.bottom);

      const visibleScrollTop = scroller.scrollTop;
      scroller.scrollTop = 500;
      act(() => refresh());
      expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
      scroller.scrollTop = visibleScrollTop;
      act(() => refresh());
      expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      scroller.scrollTop = 159;
      await inspect();
      act(() => refresh());
      expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
      expect(target.getBoundingClientRect().bottom).toBeGreaterThan(
        viewport.top,
      );
    } finally {
      rects.mockRestore();
    }
  });

  it("does not move deliberate outside focus when a delayed anchor becomes visible", async () => {
    let report = (_visible: boolean) => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          report = (isIntersecting) =>
            callback(
              [{ isIntersecting } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
        }
        observe() {}
        disconnect() {}
      },
    );
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const from = opener();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    await inspect();
    outside.focus();

    act(() => report(true));

    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    expect(outside).toHaveFocus();
    outside.remove();
    from.remove();
  });

  it("reveals the mounted selected clip anchor when it differs from the primary track", async () => {
    useDawStore.getState().hydrate(
      "/tmp/inspector-host/episode.sharecut",
      minimalProject({
        tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
        clips: {
          tracks: {
            host: [clipRow({ id: "c1", track_id: "host" })],
            guest: [clipRow({ id: "c2", track_id: "guest" })],
          },
          clip_count: 2,
        },
      }),
    );
    useDawStore.setState({
      selection: {
        kind: "clip",
        id: "c2",
        trackId: "guest",
        ids: ["c1", "c2"],
      },
    });
    let refresh = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly observed = new Set<Element>();
        private readonly callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          refresh = () => {
            const scroller =
              document.querySelector<HTMLElement>(".timeline-scroll");
            if (!scroller) return;
            const viewport = scroller.getBoundingClientRect();
            for (const target of this.observed) {
              const rect = target.getBoundingClientRect();
              this.callback(
                [
                  {
                    isIntersecting:
                      rect.bottom > viewport.top && rect.top < viewport.bottom,
                  } as IntersectionObserverEntry,
                ],
                this as unknown as IntersectionObserver,
              );
            }
          };
        }
        observe(target: Element) {
          this.observed.add(target);
          refresh();
        }
        disconnect() {
          this.observed.clear();
        }
      },
    );
    stubViewportShell("desktop");
    const box = (top: number, bottom: number) =>
      ({
        x: 0,
        y: top,
        top,
        bottom,
        left: 0,
        right: 1200,
        width: 1200,
        height: bottom - top,
      }) as DOMRect;
    const rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const scrolled =
          this.closest<HTMLElement>(".timeline-scroll")?.scrollTop ?? 0;
        if (this.classList.contains("timeline-scroll")) return box(49, 844);
        if (this.classList.contains("edit-workspace")) return box(0, 900);
        if (this.classList.contains("timeline-ruler")) return box(49, 73);
        if (this.classList.contains("marker-lane")) return box(73, 97);
        if (this.classList.contains("lane-row")) {
          const top = this.dataset.trackId === "guest" ? 500 : 100;
          return box(top - scrolled, top + 96 - scrolled);
        }
        if (this.getAttribute("data-clip-id")) {
          const top = this.getAttribute("data-clip-id") === "c2" ? 510 : 110;
          return box(top - scrolled, top + 50 - scrolled);
        }
        return box(0, 0);
      });
    try {
      render(<EditWorkspace />);
      const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
      const target = document.querySelector<HTMLElement>(
        '[data-clip-id="c1"]',
      )!;
      scroller.scrollTop = 459;
      expect(target.getBoundingClientRect().bottom).toBeLessThan(49);

      await inspect();
      act(() => refresh());

      const card = screen.getByRole("dialog", { name: "Inspector" });
      expect(card).toBeVisible();
      expect(useDawStore.getState().selection).toEqual({
        kind: "clip",
        id: "c2",
        trackId: "guest",
        ids: ["c1", "c2"],
      });
      expect(target.getBoundingClientRect().bottom).toBeGreaterThan(49);
      expect(target.getBoundingClientRect().top).toBeLessThan(844);
    } finally {
      rects.mockRestore();
    }
  });

  it("measures the card again when its anchor comes back into view", async () => {
    let notify = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const bounds = stubAnchorBounds();
    const report = (visible: boolean) => {
      bounds.state.away = !visible;
      notify();
    };
    stubViewportShell("desktop");
    const { container } = render(<EditWorkspace />);
    await inspect();
    const root = container.querySelector(".edit-workspace");
    const rootCalls = () =>
      bounds.spy.mock.contexts.filter((el) => el === root).length;
    act(() => report(false));
    const hidden = rootCalls();
    act(() => report(true));
    expect(rootCalls()).toBeGreaterThan(hidden);
    bounds.spy.mockRestore();
  });

  it("returns focus to the first opener under StrictMode", async () => {
    stubViewportShell("desktop");
    render(
      <StrictMode>
        <EditWorkspace />
      </StrictMode>,
    );
    const from = opener();
    await inspect();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(from).toHaveFocus();
    from.remove();
  });

  it("leaves focus on a toast action instead of pulling it into the card", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const region = document.createElement("div");
    region.className = "ui-toast-region--app";
    const action = document.createElement("button");
    action.textContent = "Undo";
    region.append(action);
    document.body.append(region);
    action.focus();
    await inspect();
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    expect(action).toHaveFocus();
    region.remove();
  });
});

describe("shortcuts after the card opens", () => {
  it("reach the keymap with the anchor holding focus", async () => {
    stubViewportShell("desktop");
    render(
      <>
        <Keys />
        <EditWorkspace />
      </>,
    );
    await inspect();
    const card = screen.getByRole("dialog", { name: "Inspector" });
    const anchor = card.querySelector<HTMLElement>("[data-inspector-anchor]")!;
    anchor.focus();
    const event = new KeyboardEvent("keydown", {
      key: "i",
      code: "KeyI",
      bubbles: true,
      cancelable: true,
    });
    anchor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens onto the focus anchor when the first control of the body is a field", async () => {
    useDawStore.getState().hydrate(
      "/tmp/inspector-host/episode.sharecut",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        pending_edits: [
          pendingEditView({ id: "p1", track_id: "host", track_ids: ["host"] }),
        ],
      }),
    );
    useDawStore.setState({
      selection: { kind: "pending", id: "p1", trackId: "host" },
    });
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    await inspect();
    const card = screen.getByRole("dialog", { name: "Inspector" });
    expect(card.querySelector("[data-inspector-anchor]")).toHaveFocus();
  });

  it.each(["range", "transcriptRange"] as const)(
    "holds one Range fields region for a %s selection on the desktop",
    async (kind) => {
      useDawStore.setState({
        selection:
          kind === "range"
            ? {
                kind: "range",
                target: {
                  kind: "exact_range",
                  intervals: [{ start: 1, end: 2 }],
                  track_ids: ["host"],
                  clips: [],
                  media_seals: {},
                },
              }
            : {
                kind: "transcriptRange",
                trackId: "host",
                startWordIndex: 0,
                endWordIndex: 1,
              },
      });
      stubViewportShell("desktop");
      render(<EditWorkspace />);
      await inspect();
      expect(
        screen.getAllByRole("region", { name: "Range fields" }),
      ).toHaveLength(1);
    },
  );

  it("Escape on the focused anchor closes the card", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const from = opener();
    await inspect();
    const card = screen.getByRole("dialog", { name: "Inspector" });
    const anchor = card.querySelector<HTMLElement>("[data-inspector-anchor]")!;
    anchor.focus();
    fireEvent.keyDown(anchor, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });
});

describe("the I key", () => {
  it("opens the Inspector for the selection and Esc closes it, returning focus", async () => {
    stubViewportShell("desktop");
    render(
      <>
        <Keys />
        <EditWorkspace />
      </>,
    );
    const from = opener();
    fireEvent.keyDown(window, { key: "i", code: "KeyI" });
    const card = await screen.findByRole("dialog", { name: "Inspector" });
    expect(card).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });
});

describe("the Inspector sheet on the phone", () => {
  it("takes the whole screen with Done where the slot is too short for a full sheet", () => {
    stubViewportShell("phone");
    stubResizeObserver();
    const lanes = document.createElement("div");
    Object.defineProperty(lanes, "clientHeight", { get: () => 150 });
    const offsetParent = vi
      .spyOn(HTMLElement.prototype, "offsetParent", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("sys-inspector") ? lanes : null;
      });
    const close = vi.fn();

    try {
      const { unmount } = render(
        <InspectorHost
          shell="phone"
          root={null}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close,
            dismiss: vi.fn(),
          }}
        />,
      );
      const dialog = screen.getByRole("dialog", { name: "Inspector" });
      expect(dialog.querySelector(".sys-inspector--takeover")).not.toBeNull();
      expect(screen.queryByRole("slider", { name: "Sheet height" })).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
      expect(close).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      offsetParent.mockRestore();
    }
  });

  it("returns an automatic Full height to Half as measured room returns", () => {
    stubViewportShell("phone");
    stubResizeObserver();
    const lanes = document.createElement("div");
    let room = 700;
    Object.defineProperty(lanes, "clientHeight", { get: () => room });
    const offsetParent = vi
      .spyOn(HTMLElement.prototype, "offsetParent", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("sys-inspector") ? lanes : null;
      });

    try {
      const { unmount } = render(
        <InspectorHost
          shell="phone"
          root={null}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close: vi.fn(),
            dismiss: vi.fn(),
          }}
        />,
      );
      const sheet = screen.getByRole("dialog", { name: "Inspector" });
      expect(sheet).toHaveAttribute("data-detent", "half");
      const grip = screen.getByRole("slider", { name: "Sheet height" });
      grip.focus();
      const resize = () => act(() => FakeResizeObserver.of(lanes).fire(lanes));

      room = 400;
      resize();
      expect(sheet).toHaveAttribute("data-detent", "full");
      room = 700;
      resize();
      expect(sheet).toHaveAttribute("data-detent", "half");
      room = 400;
      resize();
      expect(sheet).toHaveAttribute("data-detent", "full");
      room = 700;
      resize();
      expect(sheet).toHaveAttribute("data-detent", "half");
      expect(useDawStore.getState().selection).toMatchObject(TRACK);
      expect(grip).toHaveFocus();
      unmount();
    } finally {
      offsetParent.mockRestore();
    }
  });

  it("measures field room after removing the dock when a full sheet shrinks", () => {
    stubViewportShell("phone");
    stubResizeObserver();
    const lanes = document.createElement("div");
    let room = 700;
    Object.defineProperty(lanes, "clientHeight", { get: () => room });
    const offsetParent = vi
      .spyOn(HTMLElement.prototype, "offsetParent", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("sys-inspector") ? lanes : null;
      });

    try {
      const { unmount } = render(
        <InspectorHost
          shell="phone"
          root={null}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close: vi.fn(),
            dismiss: vi.fn(),
          }}
        />,
      );
      const sheet = screen.getByRole("dialog", { name: "Inspector" });
      fireEvent.keyDown(screen.getByRole("slider", { name: "Sheet height" }), {
        key: "End",
      });
      expect(sheet).toHaveAttribute("data-detent", "full");
      const dock = sheet.querySelector(".sys-inspector-dock")!;
      const body = sheet.querySelector(".sys-inspector-scroll")!;
      expect(dock).not.toBeEmptyDOMElement();
      Object.defineProperty(body, "clientHeight", {
        get: () => (dock.childElementCount ? 32 : 96),
      });
      vi.spyOn(sheet, "getBoundingClientRect").mockImplementation(() =>
        DOMRect.fromRect({ height: room * 0.92 }),
      );

      room = 400;
      act(() => FakeResizeObserver.of(lanes).fire(lanes));
      expect(dock).toBeEmptyDOMElement();
      expect(screen.getByRole("dialog", { name: "Inspector" })).toBe(sheet);
      expect(sheet).toHaveAttribute("data-detent", "full");
      unmount();
    } finally {
      offsetParent.mockRestore();
    }
  });

  it.each(["dock", "half", "full"] as const)(
    "keeps a manually chosen %s height while room changes",
    (detent) => {
      stubViewportShell("phone");
      stubResizeObserver();
      const lanes = document.createElement("div");
      let room = 700;
      Object.defineProperty(lanes, "clientHeight", { get: () => room });
      const offsetParent = vi
        .spyOn(HTMLElement.prototype, "offsetParent", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains("sys-inspector") ? lanes : null;
        });

      try {
        const { unmount } = render(
          <InspectorHost
            shell="phone"
            root={null}
            regionRef={() => undefined}
            sheet={{
              open: true,
              rangeActionsInSheet: false,
              close: vi.fn(),
              dismiss: vi.fn(),
            }}
          />,
        );
        const sheet = screen.getByRole("dialog", { name: "Inspector" });
        const grip = screen.getByRole("slider", { name: "Sheet height" });
        if (detent === "dock") fireEvent.keyDown(grip, { key: "Home" });
        if (detent === "full") fireEvent.keyDown(grip, { key: "End" });
        if (detent === "half") {
          fireEvent.keyDown(grip, { key: "End" });
          fireEvent.keyDown(grip, { key: "ArrowDown" });
        }
        expect(sheet).toHaveAttribute("data-detent", detent);

        const resize = () =>
          act(() => FakeResizeObserver.of(lanes).fire(lanes));
        room = 400;
        resize();
        room = 700;
        resize();

        expect(sheet).toHaveAttribute("data-detent", detent);
        unmount();
      } finally {
        offsetParent.mockRestore();
      }
    },
  );

  it("keeps its current height when measured room is zero or unavailable", () => {
    stubViewportShell("phone");
    stubResizeObserver();
    const lanes = document.createElement("div");
    Object.defineProperty(lanes, "clientHeight", { value: 0 });
    const offsetParent = vi
      .spyOn(HTMLElement.prototype, "offsetParent", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("sys-inspector") ? lanes : null;
      });

    try {
      const { unmount } = render(
        <InspectorHost
          shell="phone"
          root={null}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close: vi.fn(),
            dismiss: vi.fn(),
          }}
        />,
      );
      const sheet = screen.getByRole("dialog", { name: "Inspector" });
      expect(sheet).toHaveAttribute("data-detent", "half");
      act(() => FakeResizeObserver.of(lanes).fire(lanes));
      expect(sheet).toHaveAttribute("data-detent", "half");
      unmount();
      offsetParent.mockRestore();

      vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
        null,
      );
      render(
        <InspectorHost
          shell="phone"
          root={null}
          regionRef={() => undefined}
          sheet={{
            open: true,
            rangeActionsInSheet: false,
            close: vi.fn(),
            dismiss: vi.fn(),
          }}
        />,
      );
      expect(screen.getByRole("dialog", { name: "Inspector" })).toHaveAttribute(
        "data-detent",
        "half",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("returns focus to the opener when a new selection replaces the one it opened for", async () => {
    stubViewportShell("phone");
    render(<EditWorkspace />);
    const from = opener();
    await inspect();
    expect(screen.getByRole("dialog")).toBeVisible();
    act(() =>
      useDawStore.getState().setSelection({ kind: "track", trackId: "other" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });

  it("carries the Action bar as its dock without Inspect, and opens at half", async () => {
    stubViewportShell("phone");
    render(<EditWorkspace />);
    expect(screen.getByRole("button", { name: "Inspect" })).toBeVisible();
    await inspect();
    const sheet = screen.getByRole("dialog", { name: "Inspector" });
    const dock = within(sheet).getByRole("group", { name: "Edit actions" });
    expect(within(dock).queryByRole("button", { name: "Inspect" })).toBeNull();
    expect(
      within(sheet).getByRole("slider", { name: "Sheet height" }),
    ).toHaveAttribute("aria-valuetext", "Half height");
  });

  it("steps through its detents from the grip and closes from Close", async () => {
    stubViewportShell("phone");
    render(<EditWorkspace />);
    await inspect();
    const grip = screen.getByRole("slider", { name: "Sheet height" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(grip).toHaveAttribute("aria-valuetext", "Full height");
    fireEvent.keyDown(grip, { key: "Home" });
    expect(grip).toHaveAttribute("aria-valuetext", "Dock");
    const dock = document.querySelector<HTMLElement>(".sys-inspector-dock");
    fireEvent.click(
      within(dock as HTMLElement).getByRole("button", { name: "Close" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().selection).toMatchObject(TRACK);
  });

  it("returns focus to the opener when the sheet closes", async () => {
    stubViewportShell("phone");
    render(<EditWorkspace />);
    const from = opener();
    await inspect();
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(from).toHaveFocus();
    from.remove();
  });
});

describe("a timeline target on the phone opens the Inspector sheet with its dock", () => {
  const CLIP = { kind: "clip", id: "c1", trackId: "host" } as const;

  it.each([
    ["a clip", CLIP],
    ["a chapter", { kind: "chapter", id: "Intro", time: 3 } as const],
  ])(
    "opens %s at half with the dock, the object name and the grip toggle",
    async (_name, selection) => {
      stubViewportShell("phone");
      useDawStore.setState({ selection });
      render(<EditWorkspace />);
      await inspect();
      const sheet = screen.getByRole("dialog", { name: "Inspector" });
      expect(sheet).toHaveAttribute("data-detent", "half");
      expect(sheet.className).not.toContain("bottom-sheet");
      const dock = within(sheet).getByRole("group", { name: "Edit actions" });
      expect(dock.querySelector(".sys-actions-object")).not.toBeNull();
      expect(within(dock).getByRole("button", { name: /^Hear/ })).toBeVisible();
      const grip = within(sheet).getByRole("slider", { name: "Sheet height" });
      fireEvent.click(grip);
      expect(sheet).toHaveAttribute("data-detent", "dock");
      fireEvent.click(grip);
      expect(sheet).toHaveAttribute("data-detent", "half");
    },
  );

  it("has no Expand or Collapse buttons", async () => {
    stubViewportShell("phone");
    useDawStore.setState({ selection: CLIP });
    render(<EditWorkspace />);
    await inspect();
    expect(
      screen.queryByRole("button", { name: /^(Expand|Collapse)/ }),
    ).toBeNull();
  });

  it("scrolls a selected clip above the sheet it opens over it", async () => {
    stubViewportShell("phone");
    useDawStore.setState({ selection: CLIP });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="timeline-scroll"><div class="marker-lane" style="position: sticky"></div>
        <div data-clip-id="c1"></div></div>`,
    );
    const box = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 360, height: bottom - top }) as DOMRect;
    const rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("timeline-scroll")) return box(52, 700);
        if (this.classList.contains("marker-lane")) return box(52, 96);
        if (this.getAttribute("data-clip-id") === "c1") {
          const scrolled = this.closest(".timeline-scroll")?.scrollTop ?? 0;
          return box(500 - scrolled, 560 - scrolled);
        }
        if (this.classList.contains("sys-inspector--phone"))
          return box(388, 748);
        return box(0, 0);
      });
    render(<EditWorkspace />);
    await inspect();
    expect(document.querySelector(".timeline-scroll")).toHaveProperty(
      "scrollTop",
      180,
    );
    rects.mockRestore();
    document.querySelector(".timeline-scroll")?.remove();
  });
});

describe("the phone sheet keeps a picked band clear of itself", () => {
  it("scrolls the band above the sheet it opens over it", () => {
    document.body.innerHTML = `
      <div class="timeline-scroll"><div class="marker-lane" style="position: sticky"></div>
        <div data-hit-kind="bleed-attenuation" data-hit-id="late_gate:0"></div></div>`;
    const box = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 360, height: bottom - top }) as DOMRect;
    const rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("timeline-scroll")) return box(52, 700);
        if (this.classList.contains("marker-lane")) return box(52, 96);
        if (this.hasAttribute("data-hit-kind")) {
          const scrolled = this.closest(".timeline-scroll")?.scrollTop ?? 0;
          return box(500 - scrolled, 530 - scrolled);
        }
        if (this.classList.contains("sys-inspector--phone"))
          return box(388, 748);
        return box(0, 0);
      });
    useDawStore.setState({
      selection: {
        kind: "bleedAttenuation",
        id: "c1",
        trackId: "host",
        regionKey: "late_gate:0",
      },
      inspectorKey: null,
    });
    render(
      <InspectorHost
        shell="phone"
        sheet={{
          open: true,
          rangeActionsInSheet: false,
          close: vi.fn(),
          dismiss: vi.fn(),
        }}
        root={null}
        regionRef={() => undefined}
      />,
    );
    expect(document.querySelector(".timeline-scroll")).toHaveProperty(
      "scrollTop",
      150,
    );
    rects.mockRestore();
    document.body.replaceChildren();
  });
});

describe("the phone Inspector's Close at the dock detent", () => {
  const CLIP = { kind: "clip", id: "c1", trackId: "host" } as const;
  const sheetEl = () => screen.getByRole("dialog", { name: "Inspector" });
  const grip = () => screen.getByRole("slider", { name: "Sheet height" });
  const toDock = () => fireEvent.keyDown(grip(), { key: "Home" });
  const closes = () =>
    screen
      .queryAllByRole("button", { name: "Close" })
      .filter((button) => !button.closest("[inert]"));

  async function openPhone() {
    stubViewportShell("phone");
    useDawStore.setState({ selection: CLIP });
    const from = opener();
    render(<EditWorkspace />);
    await inspect();
    return from;
  }

  it("shows exactly one Close, in the dock, and one in the header at half", async () => {
    const from = await openPhone();
    expect(sheetEl()).toHaveAttribute("data-detent", "half");
    expect(closes()).toHaveLength(1);
    expect(closes()[0]?.closest(".sys-inspector-header")).not.toBeNull();
    toDock();
    expect(sheetEl()).toHaveAttribute("data-detent", "dock");
    expect(closes()).toHaveLength(1);
    expect(closes()[0]?.closest(".sys-inspector-dock")).not.toBeNull();
    from.remove();
  });

  it("closes the panel, keeps the selection and returns focus to the opener", async () => {
    const from = await openPhone();
    toDock();
    fireEvent.click(closes()[0] as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(useDawStore.getState().selection).toMatchObject(CLIP);
    expect(useDawStore.getState().inspectorKey).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });

  it("returns focus to the opener after a pointer press on the dock Close", async () => {
    const from = await openPhone();
    toDock();
    const close = closes()[0] as HTMLElement;
    close.focus();
    fireEvent.pointerDown(close, { button: 0, pointerId: 3 });
    fireEvent.click(close, { detail: 1 });
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });
});

describe("the Inspector card keeps clear of the join band picks", () => {
  type Rel = { x: number; y: number; width: number; height: number };
  const FRAME = { x: 0, y: 49, width: 844, height: 330 };
  const CARD_WIDTH = 320;
  const BLEED = {
    kind: "bleedAttenuation",
    id: "c1",
    trackId: "host",
    regionKey: "late_gate:0",
  } as const;
  /** The lanes viewport inside the frame, and a pick across the card's usual place. */
  const LANES: Rel = { x: 0, y: 60, width: 844, height: 220 };
  const ACROSS_CARD: Rel = { x: 150, y: 140, width: 70, height: 8 };

  function frame() {
    const rects = new Map<Element, Rel>();
    const place = (el: HTMLElement, rel: Rel) => {
      rects.set(el, rel);
      el.getBoundingClientRect = () => {
        const r = rects.get(el) as Rel;
        return new DOMRect(FRAME.x + r.x, FRAME.y + r.y, r.width, r.height);
      };
    };
    const root = document.createElement("div");
    root.getBoundingClientRect = () =>
      new DOMRect(FRAME.x, FRAME.y, FRAME.width, FRAME.height);
    const lane = document.createElement("div");
    lane.className = "lane-row";
    lane.dataset.trackId = "host";
    place(lane, { x: 0, y: 100, width: 40, height: 60 });
    const bar = document.createElement("div");
    bar.className = "sys-actions--floating";
    place(bar, { x: 100, y: 20, width: 200, height: 30 });
    const lanes = document.createElement("div");
    lanes.className = "timeline-scroll";
    place(lanes, LANES);
    root.append(lane, bar, lanes);
    document.body.append(root);
    const addPick = (rel: Rel, id = `late_gate:${lanes.children.length}`) => {
      const pick = document.createElement("div");
      pick.dataset.hitKind = "bleed-attenuation";
      pick.dataset.hitId = id;
      place(pick, rel);
      lanes.append(pick);
      return pick;
    };
    const addCorner = (rel: Rel) => {
      const column = document.createElement("div");
      column.className = "edit-timeline-col";
      const corner = document.createElement("div");
      corner.className = "edit-corner";
      place(corner, rel);
      column.append(corner);
      root.append(column);
      return corner;
    };
    return { root, place, addPick, addCorner };
  }

  const mount = (
    root: HTMLElement,
    shell: "desktop" | "tablet" = "desktop",
  ) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    return render(
      <InspectorHost
        shell={shell}
        root={root}
        regionRef={() => undefined}
        sheet={{
          open: true,
          rangeActionsInSheet: false,
          close: vi.fn(),
          dismiss: vi.fn(),
        }}
      />,
    );
  };

  const cardBox = (): Rel => {
    const card = screen.getByRole("dialog", { name: "Inspector" })
      .firstElementChild as HTMLElement | null;
    const el = (
      card?.matches(".sys-inspector--card")
        ? card
        : document.querySelector(".sys-inspector--card")
    ) as HTMLElement;
    const height = Number.parseFloat(el.style.maxBlockSize);
    const top = el.style.insetBlockStart
      ? Number.parseFloat(el.style.insetBlockStart)
      : FRAME.height - Number.parseFloat(el.style.insetBlockEnd) - height;
    return {
      x: Number.parseFloat(el.style.insetInlineStart),
      y: top,
      width: CARD_WIDTH,
      height,
    };
  };
  const overlap = (a: Rel, b: Rel) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0;

  /** A stand-in for the session publishing a read: the bands render, then listeners hear it. */
  function publishingSession() {
    const listeners = new Set<() => void>();
    let snapshot: ClipBleedSnapshot = null;
    vi.spyOn(clipBleedSession, "getSnapshot").mockImplementation(
      () => snapshot,
    );
    vi.spyOn(clipBleedSession, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    return (next: NonNullable<ClipBleedSnapshot>) => {
      snapshot = next;
      for (const listener of listeners) listener();
    };
  }

  beforeEach(() => {
    useDawStore.setState({ selection: BLEED });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("opens beside or around a pick its usual place would cover", () => {
    const { root, addPick } = frame();
    addPick(ACROSS_CARD);
    mount(root);
    expect(overlap(cardBox(), ACROSS_CARD)).toBe(false);
    expect(document.querySelector(".sys-inspector--takeover")).toBeNull();
  });

  it("moves off a pick that arrives after the card is open", async () => {
    const publish = publishingSession();
    const { root, addPick } = frame();
    mount(root);
    const before = cardBox();
    expect(overlap(before, ACROSS_CARD)).toBe(true);

    addPick(ACROSS_CARD);
    await act(async () => {
      publish({
        occurrence: { trackId: "host", clipId: "c1", clipLabel: "Host" },
        generation: 1,
        read: { state: "loading" },
        selectedKey: null,
        action: { state: "idle" },
        undo: null,
      });
    });

    await waitFor(() => expect(overlap(cardBox(), ACROSS_CARD)).toBe(false));
  });

  it("moves off a pick again after a window resize moves it", async () => {
    const { root, addPick, place } = frame();
    const pick = addPick({ x: 600, y: 140, width: 70, height: 8 });
    mount(root);
    expect(overlap(cardBox(), ACROSS_CARD)).toBe(true);

    place(pick, ACROSS_CARD);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => expect(overlap(cardBox(), ACROSS_CARD)).toBe(false));
  });

  it("moves off a pick again after a zoom moves it", async () => {
    const { root, addPick, place } = frame();
    const pick = addPick({ x: 600, y: 140, width: 70, height: 8 });
    mount(root);
    expect(overlap(cardBox(), ACROSS_CARD)).toBe(true);

    place(pick, ACROSS_CARD);
    act(() => {
      useDawStore.setState({ zoomPxPerSec: 80 });
    });

    await waitFor(() => expect(overlap(cardBox(), ACROSS_CARD)).toBe(false));
  });

  it("clears the picks when the selection becomes an automatic reduction, and stops caring when it leaves", async () => {
    useDawStore.setState({ selection: TRACK });
    const { root, addPick } = frame();
    addPick(ACROSS_CARD);
    mount(root);
    const usual = cardBox();
    expect(overlap(usual, ACROSS_CARD)).toBe(true);

    act(() => {
      useDawStore.setState({ selection: BLEED });
    });
    await waitFor(() => expect(overlap(cardBox(), ACROSS_CARD)).toBe(false));

    act(() => {
      useDawStore.setState({ selection: TRACK });
    });
    await waitFor(() => expect(cardBox()).toEqual(usual));
  });

  it("ignores picks scrolled out of the lanes viewport", () => {
    const { root, addPick } = frame();
    mount(root);
    const usual = cardBox();
    addPick({ x: 150, y: 20, width: 70, height: 8 });
    addPick({ x: 150, y: 285, width: 70, height: 8 });
    addPick({ x: 900, y: 140, width: 70, height: 8 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(cardBox()).toEqual(usual);
  });

  it("ignores the picks while the Timeline range is armed", () => {
    const { root, addPick } = frame();
    mount(root);
    const usual = cardBox();
    const pick = addPick(ACROSS_CARD);
    pick.setAttribute("data-range-armed", "");
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(cardBox()).toEqual(usual);
  });

  it("takes the whole screen with Done, keeping the picks reachable, when no place clears them", () => {
    const { root, addPick } = frame();
    addPick({ x: 8, y: 60, width: 828, height: 200 });
    mount(root);
    const dialog = screen.getByRole("dialog", { name: "Inspector" });
    expect(dialog.querySelector(".sys-inspector--takeover")).not.toBeNull();
    expect(document.querySelector(".sys-inspector--card")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeVisible();
  });

  it.each([
    ["track", TRACK],
    ["pending", { kind: "pending", id: "p1", trackId: "host" } as const],
  ])(
    "keeps the card beside a %s selection whatever the picks",
    (_, selection) => {
      useDawStore.setState({ selection });
      const { root, addPick } = frame();
      mount(root);
      const usual = cardBox();
      addPick({ x: 8, y: 60, width: 828, height: 200 });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(cardBox()).toEqual(usual);
      expect(document.querySelector(".sys-inspector--takeover")).toBeNull();
    },
  );

  it("keeps the corner clear too on the tablet", () => {
    const { root, addPick, addCorner } = frame();
    addPick(ACROSS_CARD);
    const corner = { x: 480, y: 250, width: 350, height: 54 };
    addCorner(corner);
    mount(root, "tablet");
    expect(overlap(cardBox(), ACROSS_CARD)).toBe(false);
    expect(overlap(cardBox(), corner)).toBe(false);
  });
});
