import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PrepareView, type PrepareViewProps } from "./PrepareView";
import { prepareAnnouncement } from "./prepareAnnouncement";
import {
  FAILURE,
  IMPORTING_TAKES,
  NAMED_TAKES,
  ROWS,
  SECOND_SESSION,
  session,
} from "./prepareFixture";
import type { SourceActions } from "./prepareTypes";

const actions: SourceActions = {
  onName: vi.fn(),
  onRemove: vi.fn(),
  onHear: vi.fn(),
  onVoices: vi.fn(),
  onSplit: vi.fn(),
  onCancelSplit: vi.fn(),
  onRetry: vi.fn(),
  onDetails: vi.fn(),
  onReplace: vi.fn(),
  onMerge: vi.fn(),
  onMove: vi.fn(),
};

function props(over: Partial<PrepareViewProps> = {}): PrepareViewProps {
  return {
    phase: "transcribing",
    sessions: [session({ status: "running", progress: 0.4 })],
    rows: ROWS.running,
    readySummary: "Transcribing 2 of 3",
    cleanup: { tight: "medium", loudness: "podcast" },
    handoff: {
      label: "Review suggestions",
      disabledReason: "Still getting ready.",
    },
    sourceActions: actions,
    onCleanup: vi.fn(),
    onImport: vi.fn(),
    onRecord: vi.fn(),
    onAdvanced: vi.fn(),
    onRowAction: vi.fn(),
    onHandoff: vi.fn(),
    ...over,
  };
}

function live(container: HTMLElement): string {
  return (
    container.querySelector(".sys-prepare > p[role='status']")?.textContent ??
    ""
  );
}

const DONE: Partial<PrepareViewProps> = {
  phase: "done",
  rows: ROWS.done,
  sessions: [session({ status: "done" })],
  handoff: { label: "Review 14 suggestions" },
};

describe("PrepareView structure", () => {
  it("is a stage: h2 sections in one order, no h1 and no main", () => {
    const { container } = render(<PrepareView {...props()} />);
    expect(container.querySelector("h1, main")).toBeNull();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Sources", "Getting ready", "Help the transcriber"]);
    expect(
      screen.getByRole("heading", { level: 3, name: "Cleanup" }),
    ).toBeVisible();
  });

  it("keeps the DOM order: Sources, Getting ready, Help, Cleanup, then the hand-off", () => {
    render(<PrepareView {...props()} />);
    const order = [
      screen.getByRole("heading", { name: "Sources" }),
      screen.getByRole("heading", { name: "Getting ready" }),
      screen.getByRole("heading", { name: "Help the transcriber" }),
      screen.getByRole("heading", { name: "Cleanup" }),
      screen.getByRole("button", { name: /Review suggestions/ }),
    ];
    for (let at = 1; at < order.length; at += 1) {
      expect(
        order[at - 1].compareDocumentPosition(order[at]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("tabs through the stage in that order", async () => {
    const user = userEvent.setup();
    render(<PrepareView {...props({ rows: ROWS.queued })} />);
    const seen: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      await user.tab();
      const name = document.activeElement?.textContent ?? "";
      seen.push(name);
      if (/Review suggestions/.test(name)) break;
    }
    const at = (pattern: RegExp) =>
      seen.findIndex((name) => pattern.test(name));
    expect(at(/Add audio|Import audio/)).toBeLessThan(at(/Advanced/));
    expect(at(/Advanced/)).toBeLessThan(at(/Light/));
    expect(at(/Light/)).toBeLessThan(at(/Podcast/));
    expect(at(/Podcast/)).toBeLessThan(at(/Review suggestions/));
  });

  it("shows only the two large tiles when empty", () => {
    render(
      <PrepareView {...props({ phase: "empty", sessions: [], rows: [] })} />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
  });

  it("numbers voices across sessions so cards are told apart", () => {
    render(
      <PrepareView
        {...props({
          sessions: [
            session({ sources: NAMED_TAKES.slice(0, 2) }),
            SECOND_SESSION,
          ],
        })}
      />,
    );
    expect(screen.getByRole("region", { name: "Voice 1, Maya" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Voice 3, Maya" })).toBeVisible();
  });

  it("starts the phone summary open when a row needs you or failed", () => {
    render(
      <PrepareView
        {...props({
          rows: ROWS.needsModel,
          readySummary: "Transcribe needs a download",
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Transcribe needs a download/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("opens and closes the phone summary", async () => {
    const user = userEvent.setup();
    render(<PrepareView {...props()} />);
    const summary = screen.getByRole("button", { name: /Transcribing 2 of 3/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
  });

  it("passes Cleanup and row choices on", async () => {
    const user = userEvent.setup();
    const onCleanup = vi.fn();
    render(<PrepareView {...props({ onCleanup })} />);
    await user.click(screen.getByRole("button", { name: "Tight" }));
    expect(onCleanup).toHaveBeenCalledWith({
      tight: "tight",
      loudness: "podcast",
    });
  });
});

describe("PrepareView hand-off", () => {
  it("is the only hand-off, secondary and giving its reason until done", () => {
    render(
      <PrepareView {...props({ sessions: [session(), SECOND_SESSION] })} />,
    );
    const handoffs = screen.getAllByRole("button", { name: /Review/ });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Still getting ready.")).toBeVisible();
  });

  it("becomes the one primary when done and takes a click", async () => {
    const user = userEvent.setup();
    const onHandoff = vi.fn();
    render(<PrepareView {...props({ ...DONE, onHandoff })} />);
    const button = screen.getByRole("button", {
      name: /Review 14 suggestions/,
    });
    expect(button).toHaveClass("primary");
    expect(document.querySelectorAll(".primary")).toHaveLength(1);
    await user.click(button);
    expect(onHandoff).toHaveBeenCalledOnce();
  });
});

describe("PrepareView live region", () => {
  it("speaks each phase's words once, changing only when the phase does", () => {
    const { container, rerender } = render(
      <PrepareView
        {...props({
          phase: "adding",
          addCount: 3,
          sessions: [session({ sources: IMPORTING_TAKES })],
          rows: ROWS.importing,
        })}
      />,
    );
    expect(live(container)).toBe("Adding 3 files.");
    rerender(
      <PrepareView
        {...props({ phase: "checking", addCount: 3, rows: ROWS.importing })}
      />,
    );
    expect(live(container)).toBe("3 files added. Checking audio.");
    rerender(<PrepareView {...props()} />);
    expect(live(container)).toBe("Transcribing started.");
  });

  it("does not change on progress, row or card changes within a phase", () => {
    const { container, rerender } = render(<PrepareView {...props()} />);
    const before = live(container);
    const node = container.querySelector(".sys-prepare > p[role='status']");
    const observe = vi.fn();
    const watcher = new MutationObserver(observe);
    if (node)
      watcher.observe(node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    for (const progress of [0.5, 0.7, 0.9]) {
      rerender(
        <PrepareView
          {...props({
            sessions: [session({ status: "running", progress })],
            rows: ROWS.running.map((row) =>
              row.state === "running" ? { ...row, progress } : row,
            ),
            readySummary: `Transcribing ${Math.round(progress * 3)} of 3`,
          })}
        />,
      );
    }
    watcher.takeRecords();
    expect(live(container)).toBe(before);
    expect(observe).not.toHaveBeenCalled();
    watcher.disconnect();
  });

  it("says done with the hand-off words, and a failure with its cause", () => {
    const { container, rerender } = render(<PrepareView {...props(DONE)} />);
    expect(live(container)).toBe("Done. Review 14 suggestions.");
    rerender(
      <PrepareView
        {...props({
          phase: "failed",
          failure: FAILURE,
          rows: ROWS.failed,
        })}
      />,
    );
    expect(live(container)).toBe(
      "Transcribing failed. Try again. The computer ran out of memory.",
    );
    expect(within(container).queryByRole("alert")).toBeNull();
  });

  it("speaks the drop count with a fallback when the browser will not say", () => {
    const { container, rerender } = render(
      <PrepareView
        {...props({
          phase: "empty",
          sessions: [],
          rows: [],
          dropActive: true,
          dropCount: 3,
        })}
      />,
    );
    expect(live(container)).toBe("Drop to add 3 files.");
    rerender(
      <PrepareView
        {...props({ phase: "empty", sessions: [], rows: [], dropActive: true })}
      />,
    );
    expect(live(container)).toBe("Drop to add audio.");
  });

  it("has one polite status, and its text is a pure function of the phase", () => {
    expect(
      prepareAnnouncement({ phase: "needs-model", handoffLabel: "x" }),
    ).toBe("Transcribing needs a download first. Other steps keep going.");
    expect(prepareAnnouncement({ phase: "empty", handoffLabel: "x" })).toBe("");
  });
});

describe("PrepareView focus", () => {
  it("does not move focus when a row starts needing you", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PrepareView {...props()} />);
    const advanced = screen.getByRole("button", { name: "Advanced" });
    await user.click(advanced);
    expect(advanced).toHaveFocus();
    rerender(<PrepareView {...props({ rows: ROWS.keepFixes })} />);
    expect(screen.getByRole("button", { name: "Keep my fixes" })).toBeVisible();
    expect(advanced).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Keep my fixes" }),
    ).not.toHaveFocus();
  });

  it("renders the Vocabulary field under Help the transcriber with the named speakers first", () => {
    render(
      <PrepareView
        {...props({
          terms: ["Quetzalcoatlus"],
          onTermsChange: vi.fn(),
          needsRetranscribe: true,
        })}
      />,
    );
    const help = screen.getByRole("region", { name: "Help the transcriber" });
    expect(
      within(help).getByRole("textbox", { name: "Names and terms" }),
    ).toBeInTheDocument();
    expect(
      within(help).getByRole("listitem", { name: "Maya, speaker" }),
    ).toBeInTheDocument();
    expect(
      within(help).getByRole("button", { name: "Re-transcribe" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { name: "Help the transcriber" }),
    ).toHaveLength(1);
  });
});
