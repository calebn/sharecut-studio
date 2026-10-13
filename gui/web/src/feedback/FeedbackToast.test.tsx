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
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import type { SessionState } from "../types/session";
import { closeOverlay, openOverlay } from "../ui/modalGate";
import { TOAST_MS } from "../ui/Toast";
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
      vi.advanceTimersByTime(8000);
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
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText("Saved Time")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved Time")).not.toBeInTheDocument();
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
});
