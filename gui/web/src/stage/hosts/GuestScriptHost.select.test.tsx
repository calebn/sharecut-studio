import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../../api/documentEdits";
import {
  rangeActionDescriptors,
  runRangeAction,
} from "../../commands/rangeActions";
import { getClipboard, setClipboard } from "../../edit/clipboard";
import { resolveSelectionRange } from "../../edit/rangeSelection";
import { SHORT_VIEWPORT_MQ } from "../../hooks/useShortViewport";
import { useDawStore } from "../../state/dawStore";
import {
  COMMENTER_CAPABILITIES,
  clipRow,
  EDITOR_CAPABILITIES,
  VIEWER_CAPABILITIES,
} from "../../test/fixtures";
import { drag, layout, stop } from "../../test/scriptDrag";
import { seedScript } from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";
import { BottomSheet } from "../../ui/BottomSheet";
import { GuestScriptHost } from "./GuestScriptHost";

vi.mock("../../api/documentEdits", async (orig) => ({
  ...(await orig<typeof import("../../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));
const seekTransport = vi.hoisted(() => vi.fn());
vi.mock("../../commands/seek", () => ({ seekTransport }));

const CLIPS = {
  tracks: {
    host: [
      clipRow({
        id: "ch",
        track_id: "host",
        timeline_start: 0,
        timeline_end: 30,
        source_start: 0,
        source_end: 30,
      }),
    ],
    guest: [
      clipRow({
        id: "cg",
        track_id: "guest",
        timeline_start: 0,
        timeline_end: 30,
        source_start: 0,
        source_end: 30,
      }),
    ],
  },
  clip_count: 2,
};

const as = (
  guestMode: "view" | "comment" | "edit",
  shareCapabilities: string[],
) =>
  seedScript({
    projectPath: "share:abc",
    guestMode,
    shareCapabilities,
    project: { clips: CLIPS },
  });

beforeEach(() => {
  vi.mocked(submitDocumentCommand).mockReset();
  setClipboard(null);
  stubViewportShell("desktop");
  seekTransport.mockReset();
  layout();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("GuestScriptHost range selection", () => {
  it("a suggesting commenter's drag within one lane sets a transcriptRange that can cut and mute", () => {
    as("comment", COMMENTER_CAPABILITIES);
    render(<GuestScriptHost />);
    drag(0, 3);
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 3,
    });
    const state = useDawStore.getState();
    expect(state.selection).not.toBeNull();
    const [target] = resolveSelectionRange(
      state.project!,
      state.selection,
    ).targets;
    const reasons = Object.fromEntries(
      rangeActionDescriptors(state, target ?? null).map((d) => [
        d.action,
        d.reason,
      ]),
    );
    expect(reasons.cut).toBeNull();
    expect(reasons.mute).toBeNull();
  });

  it("a drag across two lanes sets a range over both tracks", () => {
    as("comment", COMMENTER_CAPABILITIES);
    render(<GuestScriptHost />);
    drag(0, 7);
    const selection = useDawStore.getState().selection;
    expect(selection?.kind).toBe("range");
    if (selection?.kind === "range")
      expect(selection.target.track_ids.sort()).toEqual(["guest", "host"]);
  });

  it("a viewer's drag leaves the selection empty", () => {
    as("view", VIEWER_CAPABILITIES);
    render(<GuestScriptHost />);
    drag(0, 3);
    expect(useDawStore.getState().selection).toBeNull();
    expect(document.querySelector("[data-selected]")).toBeNull();
  });

  it("a click seeks and selects the one word", async () => {
    as("comment", COMMENTER_CAPABILITIES);
    render(<GuestScriptHost />);
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    expect(seekTransport).toHaveBeenCalledExactlyOnceWith(10.5);
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 1,
      endWordIndex: 1,
    });
  });

  it("Shift+Arrow extends the selection", async () => {
    as("comment", COMMENTER_CAPABILITIES);
    render(<GuestScriptHost />);
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 1,
      endWordIndex: 2,
    });
  });

  it("a click on another word re-selects it, and Shift-click extends from the first", async () => {
    as("comment", COMMENTER_CAPABILITIES);
    render(<GuestScriptHost />);
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    await userEvent.click(screen.getByRole("button", { name: "show" }));
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 4,
      endWordIndex: 4,
    });
    fireEvent.click(screen.getByRole("button", { name: "friends" }), {
      shiftKey: true,
      detail: 1,
    });
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 4,
      endWordIndex: 5,
    });
  });

  it("Escape clears the selection and a click on a word selects again", async () => {
    as("comment", COMMENTER_CAPABILITIES);
    render(<GuestScriptHost />);
    drag(0, 3);
    fireEvent.keyDown(stop(1), {
      key: "Escape",
    });
    expect(useDawStore.getState().selection).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "show" }));
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 4,
      endWordIndex: 4,
    });
  });

  it("Escape inside an open sheet clears the selection first and keeps the sheet open", () => {
    as("comment", COMMENTER_CAPABILITIES);
    const onClose = vi.fn();
    function Sheeted() {
      const [open] = useState(true);
      return (
        <BottomSheet
          open={open}
          onClose={onClose}
          title="Script"
          backgroundPolicy="interactive"
        >
          <GuestScriptHost />
        </BottomSheet>
      );
    }
    render(<Sheeted />);
    act(() => drag(0, 3));
    fireEvent.keyDown(stop(1), {
      key: "Escape",
    });
    expect(useDawStore.getState().selection).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(stop(1), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a commenter's drag then Cut sends a suggestion and clears the selection", async () => {
    as("comment", COMMENTER_CAPABILITIES);
    vi.mocked(submitDocumentCommand).mockResolvedValue({} as never);
    render(<GuestScriptHost />);
    drag(0, 3);
    const target = resolveSelectionRange(
      useDawStore.getState().project!,
      useDawStore.getState().selection,
    ).targets[0];
    expect(await runRangeAction("cut")).toEqual({ status: "ok" });
    expect(submitDocumentCommand).toHaveBeenCalledExactlyOnceWith(
      "share:abc",
      "EditSelectedRange",
      { action: "cut", targets: [target] },
    );
    expect(getClipboard()).toBeNull();
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("an editor's drag selects and Cut applies directly, as rangeActions defines", async () => {
    as("edit", EDITOR_CAPABILITIES);
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      type: "Applied",
    } as never);
    render(<GuestScriptHost />);
    drag(0, 3);
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "transcriptRange",
      startWordIndex: 0,
      endWordIndex: 3,
    });
    const state = useDawStore.getState();
    const [target] = resolveSelectionRange(
      state.project!,
      state.selection,
    ).targets;
    const cut = rangeActionDescriptors(state, target ?? null).find(
      (d) => d.action === "cut",
    );
    expect(cut).toMatchObject({ label: "Cut", reason: null });
    expect(await runRangeAction("cut")).toEqual({ status: "ok" });
    expect(getClipboard()?.mode).toBe("cut");
  });

  it("drops a stored word selection when the Script hides on a short window", () => {
    as("comment", COMMENTER_CAPABILITIES);
    const listeners = new Set<() => void>();
    let short = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return short && query === SHORT_VIEWPORT_MQ;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
    render(<GuestScriptHost />);
    drag(0, 3);
    expect(useDawStore.getState().selection).not.toBeNull();
    act(() => {
      short = true;
      listeners.forEach((fn) => fn());
    });
    expect(useDawStore.getState().selection).toBeNull();
    vi.unstubAllGlobals();
  });

  it("drops a stored selection when the link stops being able to suggest", () => {
    as("comment", COMMENTER_CAPABILITIES);
    render(<GuestScriptHost />);
    drag(0, 3);
    expect(useDawStore.getState().selection).not.toBeNull();
    act(() => useDawStore.setState({ shareCapabilities: VIEWER_CAPABILITIES }));
    expect(useDawStore.getState().selection).toBeNull();
  });
});
