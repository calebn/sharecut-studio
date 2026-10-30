import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
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

function Keys() {
  useDawKeymapListener();
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

  it("hides the card while its anchor is out of view and keeps the Inspector open", async () => {
    let report = (_visible: boolean) => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: (entries: { isIntersecting: boolean }[]) => void;
        constructor(
          callback: (entries: { isIntersecting: boolean }[]) => void,
        ) {
          this.callback = callback;
          report = (isIntersecting) => this.callback([{ isIntersecting }]);
        }
        observe() {
          report(true);
        }
        disconnect() {}
      },
    );
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    await inspect();
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    act(() => report(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().inspectorKey).not.toBeNull();
    act(() => report(true));
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
  });

  it("measures the card again when its anchor comes back into view", async () => {
    let report = (_visible: boolean) => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: (entries: { isIntersecting: boolean }[]) => void;
        constructor(
          callback: (entries: { isIntersecting: boolean }[]) => void,
        ) {
          this.callback = callback;
          report = (isIntersecting) => this.callback([{ isIntersecting }]);
        }
        observe() {
          report(true);
        }
        disconnect() {}
      },
    );
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    stubViewportShell("desktop");
    const { container } = render(<EditWorkspace />);
    await inspect();
    const root = container.querySelector(".edit-workspace");
    const rootCalls = () =>
      spy.mock.contexts.filter((el) => el === root).length;
    act(() => report(false));
    const hidden = rootCalls();
    act(() => report(true));
    expect(rootCalls()).toBeGreaterThan(hidden);
    spy.mockRestore();
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
  it("reach the keymap with the card holding focus", async () => {
    stubViewportShell("desktop");
    render(
      <>
        <Keys />
        <EditWorkspace />
      </>,
    );
    await inspect();
    const card = screen.getByRole("dialog", { name: "Inspector" });
    card.focus();
    const event = new KeyboardEvent("keydown", {
      key: "i",
      code: "KeyI",
      bubbles: true,
      cancelable: true,
    });
    card.dispatchEvent(event);
    expect(card).toHaveAttribute("tabindex", "-1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("Escape on the focused card closes it", async () => {
    stubViewportShell("desktop");
    render(<EditWorkspace />);
    const from = opener();
    await inspect();
    const card = screen.getByRole("dialog", { name: "Inspector" });
    card.focus();
    fireEvent.keyDown(card, { key: "Escape" });
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
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
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
          strip: null,
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
