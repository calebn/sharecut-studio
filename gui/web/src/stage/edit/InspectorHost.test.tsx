import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { EditWorkspace } from "./EditWorkspace";

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
});

describe("the Inspector sheet on the phone", () => {
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

  it("steps through its detents from the grip and clears the selection when dismissed", async () => {
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
