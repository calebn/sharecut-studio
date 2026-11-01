import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrepareView, type PrepareViewProps } from "./PrepareView";
import { prepareAnnouncement } from "./prepareAnnouncement";
import {
  FAILURE,
  IMPORTING_TAKES,
  NAMED_TAKES,
  ROWS,
  SECOND_SESSION,
  session,
  TAKES_WITH_NEW,
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
    readySummary: "Getting ready: 2 of 3 done",
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

/** The stage is this wide, in CSS px (jsdom has no layout, so it reads 0 and the wide layout stands). */
function atWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height: 800,
    top: 0,
    left: 0,
    right: width,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}
const PHONE_WIDTH = 360;
const SUMMARY = /Getting ready: 2 of 3 done/;

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("PrepareView selected-run summary state", () => {
  const omitted = [
    { id: "add", state: "done", title: "Add audio" },
    {
      id: "transcribe",
      state: "queued",
      title: "Transcribe",
      detail: "Not run this time",
      runDisposition: "omitted",
    },
    {
      id: "align",
      state: "queued",
      title: "Line up tracks",
      detail: "Not run this time",
      runDisposition: "omitted",
    },
  ] as const;

  it("announces selected completion globally while omitted rows remain neutral", () => {
    atWidth(PHONE_WIDTH);
    const { container } = render(
      <PrepareView
        {...props({
          phase: "done",
          rows: omitted,
          readySummary: "Getting ready: selected work finished",
        })}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: /^Done.*Getting ready: selected work finished$/,
      }),
    ).toBeInTheDocument();
    const transcribe = within(
      container.querySelector(".sys-prepare-ready")! as HTMLElement,
    )
      .getByText("Transcribe")
      .closest(".sys-status")!;
    expect(transcribe.querySelector(".sr-only")).toHaveTextContent("Not yet");
  });

  it("announces stopped processing globally without inventing a failed operation", () => {
    atWidth(PHONE_WIDTH);
    render(
      <PrepareView
        {...props({
          phase: "failed",
          rows: omitted.map((row) => ({ ...row, runDisposition: undefined })),
          readySummary: "Getting ready: processing stopped",
          failure: { step: "Processing", cause: "The run was stopped." },
        })}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: /^Failed.*Getting ready: processing stopped$/,
      }),
    ).toBeInTheDocument();
  });

  it.each(["new-audio", "checking", "transcribing"] as const)(
    "does not borrow old omitted completion during %s",
    (phase) => {
      atWidth(PHONE_WIDTH);
      render(
        <PrepareView
          {...props({
            phase,
            rows: omitted,
            readySummary: "Getting ready: current work",
          })}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: /^Not yet.*Getting ready: current work$/,
        }),
      ).toBeInTheDocument();
    },
  );

  it.each(["needs-you", "running", "failed"] as const)(
    "preserves %s row feedback ahead of selected completion",
    (state) => {
      atWidth(PHONE_WIDTH);
      const label =
        state === "needs-you"
          ? "Needs you"
          : state === "running"
            ? "Running"
            : "Failed";
      render(
        <PrepareView
          {...props({
            phase: "done",
            rows: [
              ...omitted,
              { id: "clean", state, title: "Clean and level" },
            ],
            readySummary: "Getting ready: current work",
          })}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: new RegExp(`^${label}.*Getting ready: current work$`),
        }),
      ).toBeInTheDocument();
    },
  );
});

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

  it("keeps one DOM order: Sources, Getting ready, Help, Cleanup, then the hand-off", () => {
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

  it("tabs through the stage in DOM order", async () => {
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
    atWidth(PHONE_WIDTH);
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
    atWidth(PHONE_WIDTH);
    const user = userEvent.setup();
    render(<PrepareView {...props()} />);
    const summary = screen.getByRole("button", { name: SUMMARY });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(summary).toHaveAttribute("aria-expanded", "false");
  });

  it("has no summary line at the three-column width, and the card stays in the middle", () => {
    atWidth(1200);
    render(<PrepareView {...props()} />);
    expect(screen.queryByRole("button", { name: SUMMARY })).toBeNull();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Sources", "Getting ready", "Help the transcriber"]);
  });

  it("puts the summary first on a phone, and the card opens in place under it", async () => {
    atWidth(PHONE_WIDTH);
    const user = userEvent.setup();
    const { container } = render(<PrepareView {...props()} />);
    const heading = screen.getByRole("heading", {
      level: 2,
      name: SUMMARY,
    });
    const summary = within(heading).getByRole("button");
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "RunningGetting ready: 2 of 3 done",
      "Sources",
      "Help the transcriber",
    ]);
    expect(
      container.querySelector(".sys-prepare-layout")?.firstElementChild,
    ).toBe(heading.closest("section"));
    expect(summary).toHaveAttribute("aria-expanded", "false");
    const body = () =>
      screen
        .getByRole("list", { name: "Getting ready" })
        .closest("[data-open]");
    expect(body()).toHaveAttribute("data-open", "false");
    await user.click(summary);
    expect(body()).toHaveAttribute("data-open", "true");
    expect(heading.closest("section")).toContainElement(body() as HTMLElement);
  });

  it("tabs from the phone summary to Sources, then on in DOM order", async () => {
    atWidth(PHONE_WIDTH);
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
    expect(at(SUMMARY)).toBe(0);
    expect(at(SUMMARY)).toBeLessThan(at(/Add audio|Import audio/));
    expect(at(/Add audio|Import audio/)).toBeLessThan(at(/Light/));
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

  it("shows no key hint, as no key takes it", () => {
    render(<PrepareView {...props()} />);
    expect(
      screen.getByRole("button", { name: /Review/ }).querySelector(".sys-keys"),
    ).toBeNull();
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
  it.each([
    ["transcribing", "Processing started."],
    ["waiting", "Processing starts when the other job finishes."],
    ["not-started", "Processing has not started. Run it when you are ready."],
  ] as const)(
    "does not claim ASR for the generic %s processing phase",
    (phase, text) => {
      expect(prepareAnnouncement({ phase, handoffLabel: "Review" })).toBe(text);
    },
  );

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
    expect(live(container)).toBe("Processing started.");
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
            readySummary: `Getting ready: ${Math.round(progress * 3)} of 3 done`,
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
      <PrepareView {...props({ phase: "empty", sessions: [], rows: [] })} />,
    );
    rerender(
      <PrepareView
        {...props({ phase: "empty", sessions: [], rows: [], dropActive: true })}
      />,
    );
    expect(live(container)).toBe("Drop to add audio.");
  });

  it("keeps the words of a phase while its counts change", () => {
    const { container, rerender } = render(
      <PrepareView
        {...props({ phase: "adding", addCount: 3, rows: ROWS.queued })}
      />,
    );
    expect(live(container)).toBe("Adding 3 files.");
    rerender(
      <PrepareView
        {...props({ phase: "adding", addCount: 4, rows: ROWS.queued })}
      />,
    );
    expect(live(container)).toBe("Adding 3 files.");
    rerender(
      <PrepareView
        {...props({ phase: "checking", addCount: 4, rows: ROWS.queued })}
      />,
    );
    expect(live(container)).toBe("4 files added. Checking audio.");
  });

  it("does not speak a changed suggestion count or drop count again", () => {
    const { container, rerender } = render(<PrepareView {...props(DONE)} />);
    rerender(
      <PrepareView
        {...props({ ...DONE, handoff: { label: "Review 15 suggestions" } })}
      />,
    );
    expect(live(container)).toBe("Done. Review 14 suggestions.");
    const drop = { phase: "empty", sessions: [], rows: [] } as const;
    rerender(
      <PrepareView {...props({ ...drop, dropActive: true, dropCount: 3 })} />,
    );
    expect(live(container)).toBe("Drop to add 3 files.");
    rerender(
      <PrepareView {...props({ ...drop, dropActive: true, dropCount: 4 })} />,
    );
    expect(live(container)).toBe("Drop to add 3 files.");
  });

  it("goes quiet instead of repeating the phase when a drag is cancelled", () => {
    const { container, rerender } = render(<PrepareView {...props(DONE)} />);
    expect(live(container)).toBe("Done. Review 14 suggestions.");
    rerender(
      <PrepareView {...props({ ...DONE, dropActive: true, dropCount: 1 })} />,
    );
    expect(live(container)).toBe("Drop to add 1 file.");
    rerender(<PrepareView {...props(DONE)} />);
    expect(live(container)).toBe("");
    rerender(
      <PrepareView
        {...props({ ...DONE, phase: "transcribing", rows: ROWS.running })}
      />,
    );
    expect(live(container)).toBe("Processing started.");
  });

  it("has one polite status, and its text is a pure function of the phase", () => {
    expect(
      prepareAnnouncement({ phase: "needs-model", handoffLabel: "x" }),
    ).toBe("Transcribing needs a download first.");
    expect(prepareAnnouncement({ phase: "empty", handoffLabel: "x" })).toBe("");
    expect(
      prepareAnnouncement({ phase: "keep-fixes", handoffLabel: "x" }),
    ).toBe("You fixed words by hand. Keep my fixes or replace them.");
    expect(
      prepareAnnouncement({ phase: "model-failed", handoffLabel: "x" }),
    ).toBe("The download did not finish. Try again.");
    expect(prepareAnnouncement({ phase: "waiting", handoffLabel: "x" })).toBe(
      "Processing starts when the other job finishes.",
    );
  });
});

describe("PrepareView focus", () => {
  it("puts focus on Keep my fixes when the question appears", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PrepareView {...props()} />);
    const advanced = screen.getByRole("button", { name: "Advanced" });
    await user.click(advanced);
    expect(advanced).toHaveFocus();
    rerender(<PrepareView {...props({ rows: ROWS.keepFixes })} />);
    expect(screen.getByRole("button", { name: "Keep my fixes" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Replace" })).not.toHaveFocus();
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

  const named = (...ids: string[]) =>
    NAMED_TAKES.filter((take) => ids.includes(take.id));

  it("moves focus to the next card when the focused card is removed", () => {
    const { rerender } = render(
      <PrepareView
        {...props({
          sessions: [session({ sources: named("maya", "anneke", "joss") })],
        })}
      />,
    );
    screen.getByRole("button", { name: "Remove Anneke" }).focus();
    rerender(
      <PrepareView
        {...props({ sessions: [session({ sources: named("maya", "joss") })] })}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Voice 2, Joss" }),
    );
  });

  it("moves focus to the previous card when the last card is removed", () => {
    const { rerender } = render(
      <PrepareView
        {...props({
          sessions: [session({ sources: named("maya", "anneke") })],
        })}
      />,
    );
    screen.getByRole("button", { name: "Remove Anneke" }).focus();
    rerender(
      <PrepareView
        {...props({ sessions: [session({ sources: named("maya") })] })}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Voice 1, Maya" }),
    );
  });

  it("moves focus to the Import tile when the only card is removed", () => {
    const { rerender } = render(
      <PrepareView
        {...props({ sessions: [session({ sources: named("maya") })] })}
      />,
    );
    screen.getByRole("button", { name: "Remove Maya" }).focus();
    rerender(
      <PrepareView {...props({ sessions: [session({ sources: [] })] })} />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Import audio/ }),
    );
  });

  it("reaches the Import tile when removing the last card empties the stage", () => {
    const { rerender } = render(
      <PrepareView
        {...props({ sessions: [session({ sources: named("maya") })] })}
      />,
    );
    screen.getByRole("button", { name: "Remove Maya" }).focus();
    rerender(
      <PrepareView {...props({ phase: "empty", sessions: [], rows: [] })} />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Import audio/ }),
    );
  });

  it("opens the Getting ready summary when a row needs you after mount, and keeps a manual close", async () => {
    atWidth(PHONE_WIDTH);
    const user = userEvent.setup();
    const { rerender } = render(<PrepareView {...props()} />);
    const summary = screen.getByRole("button", { name: SUMMARY });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    rerender(<PrepareView {...props({ rows: ROWS.failed })} />);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    await user.click(summary);
    rerender(
      <PrepareView {...props({ rows: ROWS.failed, readySummary: "x" })} />,
    );
    expect(summary).toHaveAttribute("aria-expanded", "false");
  });

  it("gives a name two sessions share a control name of its own", () => {
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
    const names = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((name) => name && /Maya|Anneke/.test(name));
    expect(names.length).toBeGreaterThan(4);
    expect(new Set(names).size).toBe(names.length);
    expect(
      screen.getByRole("button", { name: "Remove Maya, voice 1" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Remove Maya, voice 3" }),
    ).toBeVisible();
    expect(screen.queryByText(/Another voice is also called/)).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Where this session goes: At the end, Session 2 · 2 Nov",
      }),
    ).toBeVisible();
  });

  it("says a name is shared only when one session has it twice", () => {
    render(
      <PrepareView
        {...props({
          sessions: [
            session({
              sources: [
                ...NAMED_TAKES.slice(0, 1),
                { ...NAMED_TAKES[0], id: "maya-b" },
              ],
            }),
            SECOND_SESSION,
          ],
        })}
      />,
    );
    expect(
      screen.getAllByText("Another voice is also called Maya."),
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Remove Maya, voice 3" }),
    ).toBeVisible();
  });

  it("leaves a name that only one voice has as it was", () => {
    render(
      <PrepareView
        {...props({
          sessions: [session({ sources: NAMED_TAKES.slice(0, 2) })],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Remove Maya" })).toBeVisible();
    expect(screen.queryByText(/Another voice is also called/)).toBeNull();
  });

  it("returns focus to the session target control after Escape and a choice", async () => {
    const onTarget = vi.fn();
    render(
      <PrepareView
        {...props({ sessions: [session({ sources: [] })], onTarget })}
      />,
    );
    const chip = screen.getByRole("button", {
      name: /Where this session goes/,
    });
    await userEvent.click(chip);
    act(() => screen.getByRole("menuitem", { name: /Starts/ }).focus());
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(chip);
    await userEvent.click(chip);
    act(() => screen.getByRole("menuitem", { name: /Starts/ }).focus());
    await userEvent.keyboard("{Enter}");
    expect(onTarget).toHaveBeenCalled();
    expect(document.activeElement).toBe(chip);
  });

  it("moves focus to the next session when the session of the focused chip is removed", () => {
    const two = [session({ sources: NAMED_TAKES.slice(0, 2) }), SECOND_SESSION];
    const { rerender } = render(<PrepareView {...props({ sessions: two })} />);
    screen
      .getAllByRole("button", { name: /Where this session goes/ })[0]
      .focus();
    rerender(<PrepareView {...props({ sessions: [two[1]] })} />);
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Session 2 · 2 Nov" }),
    );
  });
});

describe("PrepareView: audio added after a run", () => {
  const NEW: Partial<PrepareViewProps> = {
    phase: "new-audio",
    sessions: [session({ status: "new", sources: TAKES_WITH_NEW })],
    rows: ROWS.plan,
    readySummary: "Getting ready: new audio waiting",
    readyNote:
      "Priya’s audio is new. The other 3 tracks keep their transcripts.",
    handoff: { label: "Process new audio" },
  };

  it("shows the plan on the rows, with the line that explains it", () => {
    render(<PrepareView {...props(NEW)} />);
    expect(
      screen.getByText(
        "Priya’s audio is new. The other 3 tracks keep their transcripts.",
      ),
    ).toBeVisible();
    const list = screen.getByRole("list", { name: "Getting ready" });
    expect(within(list).getAllByText("Priya only · 3 kept")).toHaveLength(1);
    expect(within(list).getByText("All 4 tracks, Priya joins")).toBeVisible();
    expect(within(list).getByText("Whole episode")).toBeVisible();
  });

  it("marks the new Source card and the session", () => {
    render(<PrepareView {...props(NEW)} />);
    expect(screen.getByText("New audio waiting")).toBeVisible();
    expect(screen.getByText("New")).toBeVisible();
    expect(
      screen.getByText("14:11 of audio · not processed yet"),
    ).toBeVisible();
  });

  it("makes Process new audio the one primary hand-off, and runs it", async () => {
    const onHandoff = vi.fn();
    const { container } = render(
      <PrepareView {...props({ ...NEW, onHandoff })} />,
    );
    const button = screen.getByRole("button", { name: /Process new audio/ });
    expect(button).toHaveClass("primary");
    expect(button).not.toHaveAttribute("aria-disabled");
    await userEvent.click(button);
    expect(onHandoff).toHaveBeenCalledOnce();
    expect(live(container)).toBe(
      "New audio is waiting. Process new audio when you are ready.",
    );
  });

  it("skips and includes a row, named by the row", async () => {
    const onRowAction = vi.fn();
    const { rerender } = render(
      <PrepareView {...props({ ...NEW, onRowAction })} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Skip, Line up tracks" }),
    );
    expect(onRowAction).toHaveBeenCalledWith("align", "skip");
    rerender(
      <PrepareView
        {...props({ ...NEW, rows: ROWS.planSkipped, onRowAction })}
      />,
    );
    expect(screen.getByText(/^Skipped this time/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Include, Line up tracks" }),
    );
    expect(onRowAction).toHaveBeenCalledWith("align", "include");
  });

  it("announces a skip and an include, and keeps focus on the button", async () => {
    const { container } = render(<PrepareView {...props(NEW)} />);
    const note = () =>
      container.querySelector("[data-row-note]")?.textContent ?? "";
    expect(note()).toBe("");
    const skip = screen.getByRole("button", { name: "Skip, Transcribe" });
    await userEvent.click(skip);
    expect(note()).toBe("Transcribe skipped for this run");
    expect(skip).toHaveFocus();
    await userEvent.click(
      screen.getByRole("button", { name: "Skip, Clean and level" }),
    );
    expect(note()).toBe("Clean and level skipped for this run");
  });

  it("announces an include", async () => {
    const { container } = render(
      <PrepareView {...props({ ...NEW, rows: ROWS.planSkipped })} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Include, Line up tracks" }),
    );
    expect(container.querySelector("[data-row-note]")).toHaveTextContent(
      "Line up tracks included in this run",
    );
  });

  it("offers Run everything again behind the more button next to Advanced", async () => {
    const onRunAll = vi.fn();
    render(<PrepareView {...props({ ...NEW, onRunAll })} />);
    await userEvent.click(
      screen.getByRole("button", { name: "More ways to run" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Run everything again" }),
    );
    expect(onRunAll).toHaveBeenCalledOnce();
  });

  it("opens a menu that holds Run everything again", async () => {
    render(<PrepareView {...props({ ...NEW, onRunAll: vi.fn() })} />);
    await userEvent.click(
      screen.getByRole("button", { name: "More ways to run" }),
    );
    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Run everything again" }),
    ).toBeVisible();
  });

  it("leaves the more button out where Run everything again is not offered", () => {
    render(<PrepareView {...props(NEW)} />);
    expect(
      screen.queryByRole("button", { name: "More ways to run" }),
    ).toBeNull();
  });

  it("holds Run everything again while the work runs", async () => {
    const onRunAll = vi.fn();
    render(<PrepareView {...props({ onRunAll })} />);
    await userEvent.click(
      screen.getByRole("button", { name: "More ways to run" }),
    );
    const item = screen.getByRole("menuitem", { name: /Run everything again/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(item);
    expect(onRunAll).not.toHaveBeenCalled();
  });

  it("says what the last run reused, in one line, and returns to Review", () => {
    const note =
      "Done in 1 min 12 s. 9 of 13 results were reused, so this run did less.";
    render(
      <PrepareView
        {...props({
          ...DONE,
          rows: ROWS.reused,
          readyNote: note,
          handoff: { label: "Review 16 suggestions" },
        })}
      />,
    );
    expect(screen.getByText(note)).toBeVisible();
    expect(screen.getAllByText("1 new · 3 reused")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: /Review 16 suggestions/ }),
    ).toHaveClass("primary");
  });
});
