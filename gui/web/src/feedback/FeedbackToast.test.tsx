import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { undoHistory } from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
} from "../commands/history";
import { activateDocumentScope } from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import {
  noteSaveLanded,
  trackDocumentDrain,
  trackEditSave,
} from "../state/documentSendOrder";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import type { SessionState } from "../types/session";
import { closeOverlay, openOverlay } from "../ui/modalGate";
import { TOAST_CLIPPED_MAX_MS, TOAST_MS, TOAST_UNDO_MS } from "../ui/Toast";
import { ApiError } from "../utils/apiError";
import { FeedbackToast } from "./FeedbackToast";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
}));

const entry = (id: string) => id as HistoryEntryId;

/** History as the tab sees it: `cursor` alone cannot tell two entries apart at the cap. */
function atHead(headId: string, cursor = 399) {
  const project = useDawStore.getState().project ?? minimalProject();
  useDawStore.setState({
    project: {
      ...project,
      history: {
        ...project.history,
        cursor,
        head_id: entry(headId),
        can_undo: true,
      },
    },
  });
}

function peerSession(partial: Partial<SessionState>): SessionState {
  return {
    version: 1,
    server_seq: 1,
    origin: "viewer",
    last_role: "viewer",
    updated_at_ns: 0,
    last_command_id: null,
    playhead_sec: 0,
    is_playing: false,
    audition_mode: "mix",
    region: null,
    source: null,
    track_id: null,
    query: null,
    match_index: null,
    selection: null,
    viewer_mute: {},
    solo_tracks: {},
    tier: null,
    dry_run: false,
    ...partial,
  };
}

let reportVisibility = (_visible: boolean) => {};
const disconnect = vi.fn();

function stubObserverRatio(intersectionRatio: number) {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: (
        entries: { isIntersecting: boolean; intersectionRatio: number }[],
      ) => void;
      constructor(
        callback: (
          entries: { isIntersecting: boolean; intersectionRatio: number }[],
        ) => void,
      ) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ isIntersecting: true, intersectionRatio }]);
      }
      disconnect() {}
    },
  );
}

describe("FeedbackToast", () => {
  const layers: ReturnType<typeof openOverlay>[] = [];
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const layer of layers.splice(0)) closeOverlay(layer);
    document.body.replaceChildren();
  });

  function compactHost() {
    const panel = document.createElement("div");
    panel.className = "bottom-sheet";
    panel.setAttribute("role", "dialog");
    const close = document.createElement("button");
    close.className = "dialog-close";
    close.textContent = "Close current inspector";
    const host = document.createElement("div");
    panel.append(close, host);
    document.body.append(panel);
    return { panel, close, host };
  }

  it("hands refused native action restoration to the usable current Close", () => {
    const old = compactHost();
    const current = compactHost();
    const { rerender } = render(<FeedbackToast host={old.host} />);
    act(() => useDawStore.getState().announceStatus("Saved"));
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    act(() => dismiss.focus());
    vi.spyOn(dismiss, "focus").mockImplementation(() => {});
    old.panel.remove();
    rerender(<FeedbackToast host={current.host} />);
    expect(current.close).toHaveFocus();
    expect(dismiss).not.toHaveAttribute("data-feedback-focus");
  });

  it.each(["modal-covered", "stowed"])(
    "resumes the timer when a %s host refuses the focused action it moved",
    (host) => {
      vi.useFakeTimers();
      const old = compactHost();
      const current = compactHost();
      const { rerender } = render(<FeedbackToast host={old.host} />);
      act(() => useDawStore.getState().announceStatus("Saved"));
      act(() => screen.getByRole("button", { name: "Dismiss" }).focus());
      if (host === "modal-covered") layers.push(openOverlay(true));
      else current.panel.setAttribute("inert", "");
      old.panel.remove();
      rerender(<FeedbackToast host={current.host} />);
      expect(document.body).toHaveFocus();
      act(() => {
        vi.advanceTimersByTime(TOAST_MS);
      });
      expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    },
  );

  it("returns focused Dismiss to the current host Close after a remount", () => {
    const old = compactHost();
    const current = compactHost();
    const { rerender } = render(<FeedbackToast host={old.host} />);
    act(() => useDawStore.getState().announceStatus("Saved"));
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    act(() => dismiss.focus());
    old.panel.remove();
    rerender(<FeedbackToast host={current.host} />);
    expect(dismiss).toHaveFocus();
    act(() =>
      useDawStore
        .getState()
        .dismissFeedbackToast(useDawStore.getState().feedbackToast!.id),
    );
    expect(current.close).toHaveFocus();
  });

  it("hands a removed focused Undo to Close without disturbing an innermost modal", () => {
    const { host, close } = compactHost();
    render(<FeedbackToast host={host} />);
    act(() =>
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: entry("host-reorder") }),
    );
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    act(() => atHead("agent-cut"));
    expect(close).toHaveFocus();
    act(() =>
      useDawStore
        .getState()
        .announceStatus("Applied hit", { undo: entry("agent-cut") }),
    );
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    const modal = document.createElement("button");
    document.body.append(modal);
    layers.push(openOverlay(true));
    act(() => modal.focus());
    act(() => atHead("next-cut"));
    expect(modal).toHaveFocus();
  });

  it("keeps a focused action across a render while its torn-down host awaits the next one", () => {
    const old = compactHost();
    const current = compactHost();
    const { rerender } = render(<FeedbackToast host={old.host} />);
    act(() => useDawStore.getState().announceStatus("Saved"));
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    act(() => dismiss.focus());
    old.panel.remove();
    rerender(<FeedbackToast host={old.host} />);
    rerender(<FeedbackToast host={current.host} />);
    expect(dismiss).toHaveFocus();
    act(() =>
      useDawStore
        .getState()
        .dismissFeedbackToast(useDawStore.getState().feedbackToast!.id),
    );
    expect(current.close).toHaveFocus();
  });

  it("hands a floating toast's removed Undo to the Close of the sheet it floats above", () => {
    const { close } = compactHost();
    render(<FeedbackToast />);
    act(() =>
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: entry("host-reorder") }),
    );
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    act(() => atHead("peer-mute"));
    expect(close).toHaveFocus();
  });

  it("hands a focused Undo to Close when an agent's selection and a peer's edit land together", () => {
    const { host, close } = compactHost();
    render(<FeedbackToast host={host} />);
    act(() =>
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: entry("host-reorder") }),
    );
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    act(() =>
      useDawStore.getState().applyAgentSession(
        peerSession({
          origin: "agent",
          last_role: "agent",
          selection: { kind: "chapter", id: "Intro", time: 3 },
          agent_selection_seq: 1,
        }),
      ),
    );
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "chapter",
    });
    act(() => atHead("peer-mute"));
    expect(close).toHaveFocus();
  });

  it.each(["selection", "project", "pointer"])(
    "cancels remembered feedback on %s navigation even if native focus has not moved",
    (navigation) => {
      const old = compactHost();
      const current = compactHost();
      const { rerender } = render(<FeedbackToast host={old.host} />);
      act(() => useDawStore.getState().announceStatus("Saved"));
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      act(() => dismiss.focus());
      act(() => {
        if (navigation === "selection") {
          useDawStore
            .getState()
            .setSelection({ kind: "envelope", trackId: "new-track" });
          useDawStore.getState().setSelection(null);
        }
        if (navigation === "project")
          useDawStore.setState({
            projectEpoch: useDawStore.getState().projectEpoch + 1,
          });
        if (navigation === "pointer") fireEvent.pointerDown(current.close);
      });
      expect(dismiss).not.toHaveAttribute("data-feedback-focus");
      old.panel.remove();
      rerender(<FeedbackToast host={current.host} />);
      expect(dismiss).not.toHaveFocus();
    },
  );

  it.each(["Time +0.01", "Level +0.01"])(
    "keeps another visible compact control clear after %s by using the flow host",
    async (action) => {
      const host = document.createElement("div");
      document.body.append(host);
      render(<FeedbackToast host={host} />);
      act(() => useDawStore.getState().announceStatus(`${action} saved`));
      const message = screen.getByText(`${action} saved`);
      expect(host).toContainElement(message);
      expect(message.closest(".ui-toast-region")).toHaveClass(
        "ui-toast-region--inspector-flow",
      );
      expect(message.closest(".ui-toast-region")).not.toHaveAttribute("style");
      await expectNoA11yViolations(host);
    },
  );

  it("keeps the card, focus pause and timer across flow, stow and floating transitions", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const { rerender } = render(<FeedbackToast />);
    act(() =>
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: entry("host-reorder") }),
    );
    const card = screen.getByText("Removed Host").closest(".ui-toast");
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    rerender(<FeedbackToast host={host} />);
    expect(screen.getByText("Removed Host").closest(".ui-toast")).toBe(card);
    act(() => undo.focus());
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(undo).toHaveFocus();
    expect(undo).toBeEnabled();
    host.remove();
    rerender(<FeedbackToast />);
    expect(screen.getByText("Removed Host").closest(".ui-toast")).toBe(card);
    expect(undo).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("Removed Host")).toBeVisible();
    act(() => screen.getByRole("button", { name: "Dismiss" }).blur());
    act(() => undo.blur());
    act(() => {
      vi.advanceTimersByTime(TOAST_UNDO_MS - 3000);
    });
    expect(screen.queryByText("Removed Host")).not.toBeInTheDocument();
  });

  it("pauses clipped feedback and retains remaining time across host teardown", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const { rerender } = render(<FeedbackToast host={host} />);
    act(() =>
      useDawStore
        .getState()
        .announceStatus("Saved Time", { undo: entry("host-reorder") }),
    );
    const card = screen.getByText("Saved Time").closest(".ui-toast");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => reportVisibility(false));
    act(() => {
      vi.advanceTimersByTime(12000);
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    host.remove();
    rerender(<FeedbackToast />);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(screen.getByText("Saved Time").closest(".ui-toast")).toBe(card);
    const undoRemaining = TOAST_UNDO_MS - 3000;
    act(() => {
      vi.advanceTimersByTime(undoRemaining - 1);
    });
    expect(screen.getByText("Saved Time")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved Time")).not.toBeInTheDocument();
  });

  it("dismisses a status card the observer keeps reporting as clipped", () => {
    vi.useFakeTimers();
    stubObserverRatio(0.5);
    render(<FeedbackToast />);
    act(() =>
      useDawStore.getState().announceStatus("Refresh failed: bad request"),
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_CLIPPED_MAX_MS);
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.getByText("Refresh failed: bad request")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      screen.queryByText("Refresh failed: bad request"),
    ).not.toBeInTheDocument();
  });

  it("treats a sub-pixel intersection ratio as fully visible", () => {
    vi.useFakeTimers();
    stubObserverRatio(0.97);
    render(<FeedbackToast />);
    act(() => useDawStore.getState().announceStatus("Saved"));
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.getByText("Saved")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("keeps a card paused when compact and floating presentations both clip it", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: (
          entries: { isIntersecting: boolean; intersectionRatio: number }[],
        ) => void;
        constructor(
          callback: (
            entries: { isIntersecting: boolean; intersectionRatio: number }[],
          ) => void,
        ) {
          this.callback = callback;
        }
        observe() {
          this.callback([{ isIntersecting: true, intersectionRatio: 0.5 }]);
        }
        disconnect() {}
      },
    );
    const host = document.createElement("div");
    document.body.append(host);
    const { rerender } = render(<FeedbackToast host={host} />);
    act(() =>
      useDawStore.getState().announceStatus("Removed long workshop recording", {
        undo: entry("host-reorder"),
      }),
    );
    const card = screen
      .getByText("Removed long workshop recording")
      .closest(".ui-toast");
    act(() => {
      vi.advanceTimersByTime(12000);
    });
    host.remove();
    rerender(<FeedbackToast />);
    act(() => {
      vi.advanceTimersByTime(12000);
    });
    expect(
      screen.getByText("Removed long workshop recording").closest(".ui-toast"),
    ).toBe(card);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(undoHistory).not.toHaveBeenCalled();
  });

  it("does not restart an unpaused timer when the presentation changes", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const { rerender } = render(<FeedbackToast />);
    act(() => useDawStore.getState().announceStatus("Saved"));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    rerender(<FeedbackToast host={host} />);
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText("Saved")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: (
            entries: { isIntersecting: boolean; intersectionRatio: number }[],
          ) => void,
        ) {
          reportVisibility = (visible) =>
            callback([
              { isIntersecting: visible, intersectionRatio: visible ? 1 : 0.5 },
            ]);
        }
        observe() {
          reportVisibility(true);
        }
        disconnect = disconnect;
      },
    );
    disconnect.mockClear();
    clearRegisteredCommands();
    registerHistoryCommands();
    _resetHistoryMovesForTests();
    vi.mocked(undoHistory).mockReset();
    vi.mocked(undoHistory).mockResolvedValue(null);
    useDawStore.setState({
      projectPath: "/tmp/ep",
      project: minimalProject(),
      guestMode: null,
      shareCapabilities: [],
      feedbackToast: null,
    });
    atHead("host-reorder");
  });

  it("shows each announcement, and Undo undoes exactly the entry the change recorded", async () => {
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: entry("host-reorder") });
    });
    expect(screen.getByText("Removed Host")).toBeVisible();
    await expectNoA11yViolations(document.body);
    const scopeAtPress = activateDocumentScope("/tmp/ep");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undoHistory).toHaveBeenCalledWith("/tmp/ep", {
      scope: scopeAtPress,
      expectedHeadId: "host-reorder",
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Undone: Removed Host",
    );
    expect(screen.getByText("Undone: Removed Host")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
  });

  describe("while this tab's own edit is still saving", () => {
    const STALE = "Can't undo: the project changed since. Nothing was undone.";
    const refuseAsStale = () =>
      vi
        .mocked(undoHistory)
        .mockRejectedValueOnce(
          new ApiError("Did not undo", "history_stale", 409),
        );
    let finish: () => void = () => {};
    let send: Promise<void> = Promise.resolve();
    let endDrain: () => void = () => {};
    let drain: Promise<void> = Promise.resolve();
    afterEach(async () => {
      finish();
      endDrain();
      await Promise.all([send, drain]);
    });
    const startSave = () => {
      send = new Promise<void>((resolve) => {
        finish = resolve;
      });
      act(() => {
        void trackEditSave("/tmp/ep", send);
      });
    };
    const settleSave = async () => {
      await act(async () => {
        finish();
        await send;
      });
    };
    const announce = () =>
      act(() => {
        useDawStore
          .getState()
          .announceStatus("Applied 6, held 4", { undo: entry("host-reorder") });
      });

    it("says why Undo waits and keeps it pressable", async () => {
      render(<FeedbackToast />);
      announce();
      expect(screen.queryByText("Undo ready after save")).toBeNull();
      startSave();
      const undo = screen.getByRole("button", { name: "Undo" });
      expect(undo).toBeEnabled();
      expect(screen.getByText("Undo ready after save")).toBeVisible();
      await expectNoA11yViolations(document.body);
      await settleSave();
      expect(screen.queryByText("Undo ready after save")).toBeNull();
    });

    it("queues a press and runs it once the save settles on the toast's entry", async () => {
      const user = userEvent.setup();
      render(<FeedbackToast />);
      announce();
      startSave();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(undoHistory).not.toHaveBeenCalled();
      expect(screen.getByText("Undo runs after save")).toBeVisible();
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Undo runs after save",
      );
      await settleSave();
      await vi.waitFor(() =>
        expect(undoHistory).toHaveBeenCalledWith(
          "/tmp/ep",
          expect.objectContaining({ expectedHeadId: "host-reorder" }),
        ),
      );
      await vi.waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Undone: Applied 6, held 4",
        ),
      );
    });

    it("waits for an offline drain the same way, and an unrelated send that leaves history alone does not strand it", async () => {
      const user = userEvent.setup();
      render(<FeedbackToast />);
      announce();
      drain = new Promise<void>((resolve) => {
        endDrain = resolve;
      });
      act(() => trackDocumentDrain("/tmp/ep", drain));
      expect(screen.getByText("Undo ready after save")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(undoHistory).not.toHaveBeenCalled();
      await act(async () => {
        endDrain();
        await drain;
      });
      await vi.waitFor(() => expect(undoHistory).toHaveBeenCalledTimes(1));
    });

    it("drops a queued press with the reason when a save lands after the toast's edit", async () => {
      const user = userEvent.setup();
      refuseAsStale();
      render(<FeedbackToast />);
      announce();
      startSave();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      act(() => {
        noteSaveLanded(
          "/tmp/ep",
          entry("later-save"),
          activateDocumentScope("/tmp/ep"),
        );
        atHead("later-save", 400);
      });
      await settleSave();
      await vi.waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(STALE),
      );
      expect(undoHistory).toHaveBeenCalledTimes(1);
      expect(screen.getByText(STALE)).toBeVisible();
    });

    it("says why on screen when the server refuses a queued press before this tab has seen the peer's edit", async () => {
      const user = userEvent.setup();
      refuseAsStale();
      render(<FeedbackToast />);
      announce();
      startSave();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      await settleSave();
      await vi.waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(STALE),
      );
      expect(undoHistory).toHaveBeenCalledTimes(1);
      expect(useDawStore.getState().feedbackToast?.message).toBe(STALE);
      expect(screen.getByText(STALE)).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Undo" }),
      ).not.toBeInTheDocument();
    });

    it("keeps one Undo for a whole Approve all: the first part's queued press is dropped, the pass toast's Undo takes both parts", async () => {
      const user = userEvent.setup();
      refuseAsStale();
      render(<FeedbackToast />);
      announce();
      startSave();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      act(() => {
        noteSaveLanded(
          "/tmp/ep",
          entry("cut-anyway"),
          activateDocumentScope("/tmp/ep"),
        );
        atHead("cut-anyway", 400);
        useDawStore.getState().announceStatus("Approved 10 pending edits", {
          undo: entry("cut-anyway"),
        });
      });
      await settleSave();
      await vi.waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(STALE),
      );
      expect(undoHistory).toHaveBeenCalledTimes(1);
      expect(undoHistory).toHaveBeenLastCalledWith(
        "/tmp/ep",
        expect.objectContaining({ expectedHeadId: "host-reorder" }),
      );
      expect(screen.getByText("Approved 10 pending edits")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(undoHistory).toHaveBeenCalledTimes(2);
      expect(undoHistory).toHaveBeenLastCalledWith(
        "/tmp/ep",
        expect.objectContaining({ expectedHeadId: "cut-anyway" }),
      );
    });
  });

  it("keeps Undo through the moment the change is announced before the project shows its head, and drops it once another edit lands", () => {
    render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Restored selection", { undo: entry("restore-entry") });
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    act(() => atHead("restore-entry", 400));
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    act(() => atHead("agent-cut", 401));
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
  });

  it("drops Undo when an agent edit replaces the head at the 400-entry cap, though the cursor stays put", () => {
    render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Reordered track", { undo: entry("host-reorder") });
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    act(() => atHead("agent-cut", 399));
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Reordered track")).toBeVisible();
    expect(undoHistory).not.toHaveBeenCalled();
  });

  it("says plainly that nothing was undone when an agent edit lands before the click", async () => {
    vi.mocked(undoHistory).mockRejectedValueOnce(
      new ApiError("Did not undo", "history_stale", 409),
    );
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Applied tighten hit", { undo: entry("host-reorder") });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    const refused =
      "Can't undo: the project changed since. Nothing was undone.";
    expect(useDawStore.getState().statusAnnouncement).toBe(refused);
    expect(screen.getByText(refused)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });

  it("runs onUndone only after Undo moved the head", async () => {
    const onUndone = vi.fn();
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Cut 2", {
        undo: entry("host-reorder"),
        onUndone,
      });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undoHistory).toHaveBeenCalled();
    expect(onUndone).toHaveBeenCalledTimes(1);
  });

  it("does not run onUndone when the head moved past the entry", async () => {
    vi.mocked(undoHistory).mockRejectedValueOnce(
      new ApiError("Did not undo", "history_stale", 409),
    );
    const onUndone = vi.fn();
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Cut 2", {
        undo: entry("host-reorder"),
        onUndone,
      });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndone).not.toHaveBeenCalled();
  });

  it("speaks a quiet status without replacing the toast", () => {
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Guest link copied");
      useDawStore
        .getState()
        .announceStatus("Pipeline: running", { toast: false });
    });
    expect(useDawStore.getState().statusAnnouncement).toBe("Pipeline: running");
    expect(screen.getByText("Guest link copied")).toBeVisible();
    expect(screen.queryByText("Pipeline: running")).not.toBeInTheDocument();
  });

  it.each(["floating", "flow"])(
    "keeps stale-head Undo guarded in %s",
    async (presentation) => {
      const host = document.createElement("div");
      document.body.append(host);
      const user = userEvent.setup();
      render(<FeedbackToast host={presentation === "flow" ? host : null} />);
      act(() =>
        useDawStore
          .getState()
          .announceStatus("Removed Host", { undo: entry("host-reorder") }),
      );
      act(() => atHead("agent-cut"));
      expect(
        screen.queryByRole("button", { name: "Undo" }),
      ).not.toBeInTheDocument();
      expect(undoHistory).not.toHaveBeenCalled();
      act(() =>
        useDawStore
          .getState()
          .announceStatus("Applied hit", { undo: entry("agent-cut") }),
      );
      vi.mocked(undoHistory).mockRejectedValueOnce(
        new ApiError("Did not undo", "history_stale", 409),
      );
      const scopeAtPress = activateDocumentScope("/tmp/ep");
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(undoHistory).toHaveBeenCalledWith("/tmp/ep", {
        scope: scopeAtPress,
        expectedHeadId: "agent-cut",
      });
      expect(
        screen.getByText(
          "Can't undo: the project changed since. Nothing was undone.",
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Undo" }),
      ).not.toBeInTheDocument();
    },
  );

  it("closes on Dismiss", async () => {
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Mix preview refreshed");
    });
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useDawStore.getState().feedbackToast).toBeNull();
    expect(screen.queryByText("Mix preview refreshed")).not.toBeInTheDocument();
  });

  it("gives an error its own look, holds no internals, and passes axe", async () => {
    const { container } = render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus(
          "Refresh failed: set PODCAST_MCP_FFMPEG and PODCAST_MCP_FFPROBE to its bin executables.",
          { tone: "error" },
        );
    });
    const card = container.ownerDocument.querySelector(".ui-toast");
    expect(card).toHaveClass("ui-toast--error");
    expect(
      screen.getByText(
        "Refresh failed. Export diagnostics from the command palette and try again.",
      ),
    ).toBeVisible();
    expect(useDawStore.getState().statusAnnouncement).not.toMatch(/PODCAST/);
    await expectNoA11yViolations(document.body);
    act(() => {
      useDawStore.getState().announceStatus("Mix preview refreshed");
    });
    expect(container.ownerDocument.querySelector(".ui-toast")).not.toHaveClass(
      "ui-toast--error",
    );
  });

  it("runs a reverse Undo for a change History does not record, then says it is done", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async () => true);
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Resolved comment at 0:12", {
        reverse: { run, done: "Comment reopened" },
      });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(run).toHaveBeenCalledOnce();
    expect(useDawStore.getState().statusAnnouncement).toBe("Comment reopened");
  });

  it("says nothing was undone when a reverse Undo declines", async () => {
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Resolved comment at 0:12", {
        reverse: { run: async () => false, done: "Comment reopened" },
      });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Can't undo: the project changed since. Nothing was undone.",
      tone: "error",
    });
  });

  it("names a failed reverse Undo as an error", async () => {
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Resolved comment at 0:12", {
        reverse: {
          run: async () => {
            throw new Error("Unknown comment");
          },
          done: "Comment reopened",
        },
      });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Undo failed: Unknown comment",
      tone: "error",
    });
  });

  it.each([
    [
      "endGestureFeedback",
      (s: ReturnType<typeof useDawStore.getState>) => s.endGestureFeedback(),
    ],
  ])(
    "a gesture message clears on %s, and a result does not",
    (_name, leave) => {
      const store = useDawStore.getState();
      store.announceStatus("Clip armed: drag sideways to move it", {
        gesture: true,
      });
      expect(useDawStore.getState().feedbackToast?.gesture).toBe(true);
      leave(useDawStore.getState());
      expect(useDawStore.getState().feedbackToast).toBeNull();
      useDawStore.getState().announceStatus("Trim saved");
      leave(useDawStore.getState());
      expect(useDawStore.getState().feedbackToast?.message).toBe("Trim saved");
    },
  );

  describe("returnFocus", () => {
    function panelAndElsewhere() {
      const panel = document.createElement("div");
      panel.tabIndex = -1;
      const elsewhere = document.createElement("button");
      elsewhere.textContent = "Elsewhere";
      document.body.append(panel, elsewhere);
      return { panel, elsewhere };
    }
    const resolved = (
      panel: HTMLElement | null,
      run: () => Promise<boolean> = async () => true,
    ) =>
      useDawStore.getState().announceStatus("Resolved comment", {
        reverse: { run, done: "Comment reopened" },
        returnFocus: () => panel,
      });

    it("focuses the panel after Undo", async () => {
      const { panel } = panelAndElsewhere();
      render(<FeedbackToast />);
      act(() => resolved(panel));
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Undo" }));
      expect(panel).toHaveFocus();
    });

    it("does not steal focus after Undo when the person moved on", async () => {
      const { panel, elsewhere } = panelAndElsewhere();
      let finish: (value: boolean) => void = () => {};
      render(<FeedbackToast />);
      act(() =>
        resolved(
          panel,
          () =>
            new Promise<boolean>((resolve) => {
              finish = resolve;
            }),
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      act(() => elsewhere.focus());
      await act(async () => finish(true));
      expect(elsewhere).toHaveFocus();
    });

    it("focuses the panel when Dismiss closes the toast with focus inside", async () => {
      const { panel } = panelAndElsewhere();
      render(<FeedbackToast />);
      act(() => resolved(panel));
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      act(() => dismiss.focus());
      await userEvent.setup().keyboard("{Enter}");
      expect(panel).toHaveFocus();
    });

    it("leaves focus alone when Dismiss is pressed from elsewhere", () => {
      const { panel, elsewhere } = panelAndElsewhere();
      render(<FeedbackToast />);
      act(() => resolved(panel));
      act(() => elsewhere.focus());
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(elsewhere).toHaveFocus();
    });

    it("leaves focus alone when the toast expires", () => {
      vi.useFakeTimers();
      const { panel, elsewhere } = panelAndElsewhere();
      render(<FeedbackToast />);
      act(() => resolved(panel));
      act(() => elsewhere.focus());
      act(() => {
        vi.advanceTimersByTime(TOAST_UNDO_MS);
      });
      expect(useDawStore.getState().feedbackToast).toBeNull();
      expect(elsewhere).toHaveFocus();
    });

    it("does not fail when the panel is gone", async () => {
      const detached = document.createElement("div");
      render(<FeedbackToast />);
      act(() => resolved(detached));
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      act(() => resolved(null));
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      act(() => dismiss.focus());
      await user.keyboard("{Enter}");
      expect(useDawStore.getState().feedbackToast).toBeNull();
    });

    it("forgets the panel once a toast without one replaces it", async () => {
      const { panel } = panelAndElsewhere();
      render(<FeedbackToast />);
      act(() => resolved(panel));
      act(() => useDawStore.getState().announceStatus("Saved"));
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      act(() => dismiss.focus());
      await userEvent.setup().keyboard("{Enter}");
      expect(panel).not.toHaveFocus();
    });
  });
});
