import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CUT_ANYWAY_REASON } from "../inspector/TranscriptRefineRecovery";
import { reviewContent } from "../storybook/reviewContent";
import { QUEUE_WITHOUT_CHECKS } from "../storybook/reviewFixtures";
import { offlineConflict } from "../test/fixtures";
import { DocumentCommand } from "../types/documentCommands.generated";
import { TRANSCRIPT_REFINE_REFUSAL } from "../utils/apiError";
import { ReviewQueue, type ReviewQueueProps } from "./ReviewQueue";
import {
  attentionRowsOf,
  type ReviewAttention,
  type ReviewFilter,
} from "./reviewQueueModel";

const waive = vi.hoisted(() => vi.fn());
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  waiveTranscriptRefine: waive,
}));

describe("ReviewQueue", () => {
  it("gives a blocked row no swipe verb", () => {
    const onVerb = vi.fn();
    const items = QUEUE_WITHOUT_CHECKS.map((i) =>
      i.id === "f1" ? { ...i, blocked: true } : i,
    );
    const { container } = render(
      <ReviewQueue
        items={items}
        content={reviewContent}
        selectedId={null}
        filter="all"
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={onVerb}
      />,
    );
    for (const row of container.querySelectorAll(".sys-queue-row")) {
      const at = (clientX: number) => ({ clientX, clientY: 0, pointerId: 1 });
      fireEvent.pointerDown(row, { ...at(100), isPrimary: true });
      fireEvent.pointerMove(row, at(190));
      fireEvent.pointerUp(row, at(190));
    }
    expect(onVerb).toHaveBeenCalled();
    expect(onVerb).not.toHaveBeenCalledWith("f1");
  });

  it("gives an Editor guest no swipe on a comment row and no Checks chip", () => {
    const onVerb = vi.fn();
    const onKeep = vi.fn();
    const { container } = render(
      <ReviewQueue
        items={[{ id: "m", kind: "comment", at: 5, savedSeconds: 0 }]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        canDecide
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={onVerb}
        onKeep={onKeep}
      />,
    );
    const row = container.querySelector(".sys-queue-row") as Element;
    const at = (clientX: number) => ({ clientX, clientY: 0, pointerId: 1 });
    fireEvent.pointerDown(row, { ...at(100), isPrimary: true });
    fireEvent.pointerMove(row, at(190));
    fireEvent.pointerUp(row, at(190));
    expect(onVerb).not.toHaveBeenCalled();
    expect(onKeep).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Checks/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Suggestions/ })).toBeVisible();
  });

  const renderItems = (items: typeof QUEUE_WITHOUT_CHECKS) =>
    render(
      <ReviewQueue
        items={items}
        content={reviewContent}
        selectedId={null}
        filter="all"
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={vi.fn()}
      />,
    );
  const fillers = QUEUE_WITHOUT_CHECKS.filter(
    (i) => i.kind === "filler" && !i.result,
  );

  it("names a one-item group button apart from the item Cut", () => {
    const { container } = renderItems(fillers.slice(0, 1));
    const bulk = container.querySelector(".rv-bulk");
    expect(bulk?.textContent?.trim()).toBe("Cut");
    expect(bulk?.getAttribute("aria-label")).toBe("Cut this one");
  });

  it("says how many stay for one-by-one when nothing can be cut together", () => {
    const { container, getByText } = renderItems(
      fillers.map((i) => ({ ...i, unsure: true })),
    );
    expect(container.querySelector(".rv-bulk")).toBeNull();
    expect(
      getByText(`${fillers.length} to decide one by one`),
    ).toBeInTheDocument();
  });

  it("keeps the one-by-one line from a guest, who decides nothing", () => {
    const { queryByText } = render(
      <ReviewQueue
        items={fillers.map((i) => ({ ...i, unsure: true }))}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={vi.fn()}
      />,
    );
    expect(queryByText(/to decide one by one/)).toBeNull();
  });

  it("keeps Cut all and Find more apart for an Editor guest", () => {
    const { getAllByRole, queryByRole } = render(
      <ReviewQueue
        items={fillers}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        canDecide
        onFilter={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getAllByRole("button", { name: /Cut all/ }).length).toBeGreaterThan(
      0,
    );
    expect(queryByRole("button", { name: /Find more/ })).toBeNull();
  });

  it("words a comments-only queue for comments", () => {
    const { getByText, queryByRole } = render(
      <ReviewQueue
        items={fillers}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        onFilter={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText(/resolved$/)).toBeInTheDocument();
    expect(queryByRole("button", { name: /^Checks/ })).toBeNull();
  });

  it("shows the bulk row for a group that has left the queue, without a fake bar", () => {
    const { getByText, queryByRole, queryByText } = render(
      <ReviewQueue
        items={[]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        bulkRunning={{
          kind: "filler",
          total: 11,
          startedAtSec: Date.now() / 1000 - 5,
        }}
        onFilter={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText("Cutting 11…")).toBeInTheDocument();
    expect(getByText("0:05 so far")).toBeInTheDocument();
    expect(queryByRole("progressbar")).toBeNull();
    expect(queryByText("Nothing to decide")).toBeNull();
  });

  it("keeps the count and bar in the group header when the host reports done", () => {
    const { getByText, getByRole, queryByRole } = render(
      <ReviewQueue
        items={fillers}
        content={reviewContent}
        selectedId={null}
        filter="all"
        bulkRunning={{ kind: "filler", total: 4, done: 1 }}
        onFilter={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText("1 done")).toBeInTheDocument();
    expect(getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(queryByRole("button", { name: /^Cut all/ })).toBeNull();
  });

  it("shows a job error with Try again, and a job without a percent", () => {
    const onFindMore = vi.fn();
    const props = {
      items: [],
      content: reviewContent,
      selectedId: null,
      filter: "all" as const,
      onFilter: vi.fn(),
      onSelect: vi.fn(),
      onFindMore,
    };
    const { getByRole, getByText, rerender, queryByText } = render(
      <ReviewQueue {...props} job={{ title: "Finding suggestions" }} />,
    );
    expect(getByText("Finding suggestions")).toBeInTheDocument();
    expect(queryByText(/%/)).toBeNull();
    rerender(<ReviewQueue {...props} job={{ title: "", error: "Crashed." }} />);
    fireEvent.click(getByRole("button", { name: "Try again" }));
    expect(onFindMore).toHaveBeenCalledOnce();
  });

  it("keeps the standalone Cutting row out of a filter that does not hold its kind", () => {
    const props = {
      items: [],
      content: reviewContent,
      selectedId: null,
      onFilter: vi.fn(),
      onSelect: vi.fn(),
      bulkRunning: { kind: "filler" as const, total: 4 },
    };
    const { queryByText, rerender } = render(
      <ReviewQueue {...props} filter="comments" />,
    );
    expect(queryByText("Cutting 4…")).toBeNull();
    rerender(<ReviewQueue {...props} filter="suggestions" />);
    expect(queryByText("Cutting 4…")).not.toBeNull();
  });

  it("puts one Approve row on top for the clean cuts when some cuts need a listen", () => {
    const onBulkIds = vi.fn();
    const items = [
      { id: "a", kind: "filler" as const, at: 1, savedSeconds: 0.4 },
      { id: "b", kind: "pause" as const, at: 2, savedSeconds: 0.6 },
      {
        id: "c",
        kind: "pause" as const,
        at: 3,
        savedSeconds: 0.5,
        risk: { rank: 3 as const, reason: "Join may be audible" },
      },
    ];
    const { getByRole } = render(
      <ReviewQueue
        items={items}
        content={reviewContent}
        selectedId={null}
        filter="all"
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onBulkIds={onBulkIds}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Approve 2 low-risk edits" }));
    expect(onBulkIds).toHaveBeenCalledWith(["a", "b"]);
    expect(getByRole("button", { name: /all 2$/ })).toBeInTheDocument();
  });

  it("filters by speaker only when two people have edits", () => {
    const onSpeaker = vi.fn();
    const edits = [
      {
        id: "a",
        kind: "filler" as const,
        at: 1,
        savedSeconds: 0.4,
        speaker: { id: "host", label: "Host" },
      },
      {
        id: "b",
        kind: "filler" as const,
        at: 2,
        savedSeconds: 0.4,
        speaker: { id: "guest", label: "Guest" },
      },
    ];
    const view = (items: typeof edits, speaker: string | null = null) => (
      <ReviewQueue
        items={items}
        content={reviewContent}
        selectedId={null}
        filter="all"
        speaker={speaker}
        onFilter={vi.fn()}
        onSpeaker={onSpeaker}
        onSelect={vi.fn()}
      />
    );
    const { rerender } = render(view(edits));
    fireEvent.click(screen.getByRole("button", { name: "Guest, 1" }));
    expect(onSpeaker).toHaveBeenCalledWith("guest");
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    expect(onSpeaker).toHaveBeenLastCalledWith(null);
    rerender(view(edits, "guest"));
    expect(screen.getByRole("button", { name: "All, 1" })).toBeInTheDocument();
    rerender(view([edits[0]!]));
    expect(screen.queryByRole("button", { name: "Everyone" })).toBeNull();
  });

  it("describes the disabled Find more by a visible note", () => {
    const { getByRole, getByText } = render(
      <ReviewQueue
        items={[]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        findMoreDisabled="Wait for the settings to load."
        onFilter={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByRole("button", { name: "Find more" })).toHaveAttribute(
      "aria-describedby",
      getByText("Wait for the settings to load.").id,
    );
  });

  it("lets a resolved comment be selected from Decided but not a decided cut", async () => {
    const onSelect = vi.fn();
    const items: typeof QUEUE_WITHOUT_CHECKS = [
      { id: "m", kind: "comment", at: 5, savedSeconds: 0, result: "applied" },
      { id: "f", kind: "filler", at: 9, savedSeconds: 1, result: "applied" },
    ];
    render(
      <ReviewQueue
        items={items}
        content={reviewContent}
        selectedId="m"
        filter="all"
        onFilter={vi.fn()}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Decided/ }));
    const comment = screen.getByRole("button", { name: /Resolved/ });
    expect(comment).toHaveAttribute("aria-current", "true");
    await userEvent.click(comment);
    expect(onSelect).toHaveBeenCalledWith("m");
    expect(
      screen.getAllByRole("button", { name: /Cut|Resolved/ }),
    ).toHaveLength(1);
  });

  describe("guest attention", () => {
    const attention = (
      over: Partial<ReviewAttention> = {},
    ): ReviewAttention => ({
      pending: 0,
      rows: attentionRowsOf(
        [
          offlineConflict({ command: { command_id: "c1", type: "TrimClip" } }),
          offlineConflict({ command: { command_id: "c2" }, reason: "Moved" }),
        ],
        true,
      ),
      unreadable: false,
      dismissFailed: false,
      checking: false,
      canDismiss: true,
      onDismissAll: vi.fn(),
      onRetry: vi.fn(),
      ...over,
    });
    const renderQueue = (
      attn: ReviewAttention | undefined,
      props: Partial<ReviewQueueProps> = {},
      filter: ReviewFilter = "all",
    ) =>
      render(
        <ReviewQueue
          items={[{ id: "m", kind: "comment", at: 5, savedSeconds: 0 }]}
          content={reviewContent}
          selectedId={null}
          filter={filter}
          guest
          attention={attn}
          onFilter={vi.fn()}
          onSelect={vi.fn()}
          {...props}
        />,
      );

    it("lists one Check row per conflict with the banner wording", () => {
      renderQueue(attention());
      const group = screen.getByRole("group", {
        name: "Needs attention. 2 conflicts",
      });
      expect(group).toHaveTextContent(
        "Your change: Envelope changed since this edit was queued",
      );
      expect(group).toHaveTextContent("Your change: Moved");
      expect(group).toHaveTextContent("Edit the change and submit it again.");
    });

    it("lists every conflict row with no more-than cap", () => {
      const conflicts = Array.from({ length: 7 }, (_, i) =>
        offlineConflict({
          command: { command_id: `many-${i}`, type: "TrimClip" },
          reason: `Conflict number ${i}`,
        }),
      );
      renderQueue(attention({ rows: attentionRowsOf(conflicts, true) }));
      const group = screen.getByRole("group", {
        name: "Needs attention. 7 conflicts",
      });
      for (let i = 0; i < 7; i++)
        expect(group).toHaveTextContent(`Your change: Conflict number ${i}`);
      expect(screen.queryByText(/\+\s*\d+ more/)).toBeNull();
    });

    it("explains the held Dismiss all while saved edits cannot be read", () => {
      renderQueue(attention({ unreadable: true }));
      const held = screen.getByRole("button", { name: "Dismiss all" });
      expect(held).toHaveAttribute("aria-disabled", "true");
      expect(held).toHaveAccessibleDescription(
        "Saved edits could not be read. Dismissal is unavailable.",
      );
    });

    it("dismisses all conflicts and is held while reading", async () => {
      const onDismissAll = vi.fn();
      const { rerender } = renderQueue(attention({ onDismissAll }));
      await userEvent.click(
        screen.getByRole("button", { name: "Dismiss all" }),
      );
      expect(onDismissAll).toHaveBeenCalledOnce();
      rerender(
        <ReviewQueue
          items={[]}
          content={reviewContent}
          selectedId={null}
          filter="all"
          guest
          attention={attention({ onDismissAll, checking: true })}
          onFilter={vi.fn()}
          onSelect={vi.fn()}
        />,
      );
      const held = screen.getByRole("button", { name: "Dismiss all" });
      expect(held).not.toBeDisabled();
      expect(held).toHaveAttribute("aria-disabled", "true");
      expect(held).toHaveAccessibleDescription(
        "Checking saved edits. Dismissal is unavailable.",
      );
      await userEvent.click(held);
      expect(onDismissAll).toHaveBeenCalledOnce();
    });

    it("keeps focus on Dismiss all when a read starts and ends", () => {
      const { rerender } = renderQueue(attention());
      const button = screen.getByRole("button", { name: "Dismiss all" });
      button.focus();
      for (const checking of [true, false]) {
        rerender(
          <ReviewQueue
            items={[]}
            content={reviewContent}
            selectedId={null}
            filter="all"
            guest
            attention={attention({ checking })}
            onFilter={vi.fn()}
            onSelect={vi.fn()}
          />,
        );
        expect(button).toHaveFocus();
      }
      expect(button).not.toHaveAttribute("aria-disabled");
    });

    it("moves focus to the progress line when a dismissal clears the group", () => {
      const { rerender } = renderQueue(attention());
      screen.getByRole("button", { name: "Dismiss all" }).focus();
      rerender(
        <ReviewQueue
          items={[{ id: "m", kind: "comment", at: 5, savedSeconds: 0 }]}
          content={reviewContent}
          selectedId={null}
          filter="all"
          guest
          attention={attention({ rows: [], canDismiss: false })}
          onFilter={vi.fn()}
          onSelect={vi.fn()}
        />,
      );
      expect(screen.getByText(/of 1 resolved/)).toHaveFocus();
    });

    it("does not take focus when the group clears while focus is elsewhere", () => {
      const { rerender } = renderQueue(attention());
      rerender(
        <ReviewQueue
          items={[{ id: "m", kind: "comment", at: 5, savedSeconds: 0 }]}
          content={reviewContent}
          selectedId={null}
          filter="all"
          guest
          attention={attention({ rows: [], canDismiss: false })}
          onFilter={vi.fn()}
          onSelect={vi.fn()}
        />,
      );
      expect(screen.getByText(/of 1 resolved/)).not.toHaveFocus();
    });

    it("counts a failure with no rows as ! and holds nothing", () => {
      renderQueue(attention({ rows: [], unreadable: true }));
      expect(
        screen.getByRole("group", {
          name: "Needs attention. Saved edits could not be read",
        }),
      ).toHaveTextContent("!");
      expect(screen.queryByRole("button", { name: "Dismiss all" })).toBeNull();
    });

    it("offers no Dismiss all when only a recovered outcome is listed", () => {
      renderQueue(attention({ canDismiss: false }));
      expect(screen.queryByRole("button", { name: "Dismiss all" })).toBeNull();
    });

    it("shows an unreadable state with Retry", async () => {
      const onRetry = vi.fn();
      renderQueue(attention({ rows: [], unreadable: true, onRetry }));
      expect(screen.getByText(/Could not read saved edits/)).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it("shows a failed dismissal with Retry", () => {
      renderQueue(attention({ dismissFailed: true }));
      expect(
        screen.getByText(
          "Dismissal failed. Your saved outcomes have been kept.",
        ),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    });

    it("hides under Comments and replaces the empty line when shown", () => {
      renderQueue(attention(), {}, "comments");
      expect(
        screen.queryByRole("group", { name: /Needs attention/ }),
      ).toBeNull();
      renderQueue(attention(), { items: [] });
      expect(screen.queryByText("No comments yet")).toBeNull();
    });
  });

  describe("host attention", () => {
    const gated = (id: string, type: string = DocumentCommand.ApproveEdits) =>
      offlineConflict({
        reason: TRANSCRIPT_REFINE_REFUSAL,
        command: { command_id: id, type },
      });
    const hostAttention = (
      conflicts = [offlineConflict()],
      over: Partial<ReviewAttention> = {},
    ): ReviewAttention => ({
      pending: 0,
      rows: attentionRowsOf(conflicts, false),
      unreadable: false,
      dismissFailed: false,
      checking: false,
      canDismiss: true,
      refineWaiverProject: "/p",
      onDismissAll: vi.fn(),
      onRetry: vi.fn(),
      onSendNow: vi.fn(),
      onInspectHistory: vi.fn(),
      ...over,
    });
    const renderHost = (attn: ReviewAttention, filter: ReviewFilter = "all") =>
      render(
        <ReviewQueue
          items={[]}
          content={reviewContent}
          selectedId={null}
          filter={filter}
          attention={attn}
          onFilter={vi.fn()}
          onSelect={vi.fn()}
        />,
      );

    it("lists waiting edits with Send now, counted in the group", async () => {
      const onSendNow = vi.fn();
      renderHost(hostAttention([], { pending: 2, onSendNow }));
      expect(
        screen.getByRole("group", { name: "Needs attention. 2 pending" }),
      ).toHaveTextContent("2 edits waiting to send");
      await userEvent.click(screen.getByRole("button", { name: "Send now" }));
      expect(onSendNow).toHaveBeenCalledOnce();
      expect(screen.queryByText("No comments yet")).toBeNull();
    });

    it("counts one waiting edit in the singular and offers no Dismiss all for it", () => {
      renderHost(hostAttention([], { pending: 1, canDismiss: false }));
      expect(screen.getByText("1 edit waiting to send")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Dismiss all" })).toBeNull();
    });

    it("offers Inspect History on an outcome that may have applied", async () => {
      const onInspectHistory = vi.fn();
      renderHost(
        hostAttention(
          [
            offlineConflict({
              kind: "unknown",
              recovery: "inspect-history",
              command: { command_id: "u", type: "UndoHistory" },
            }),
          ],
          { onInspectHistory },
        ),
      );
      expect(
        screen.getByText("Inspect History before trying this action again."),
      ).toBeVisible();
      await userEvent.click(
        screen.getByRole("button", { name: "Inspect History" }),
      );
      expect(onInspectHistory).toHaveBeenCalledOnce();
    });

    it("offers no Inspect History on an ordinary refusal", () => {
      renderHost(hostAttention());
      expect(
        screen.queryByRole("button", { name: "Inspect History" }),
      ).toBeNull();
      expect(
        screen.getByText("Edit the change and submit it again."),
      ).toBeVisible();
    });

    it("says to fix the project file for a refusal that blocks saving", () => {
      renderHost(
        hostAttention([
          { ...offlineConflict(), blocksSave: true } as ReturnType<
            typeof offlineConflict
          >,
        ]),
      );
      expect(
        screen.getByText(
          "Fix the project file first; this change was not saved.",
        ),
      ).toBeVisible();
    });

    it("lets the host waive a refine-gate refusal, says to approve again and takes focus", async () => {
      waive.mockResolvedValue({});
      renderHost(hostAttention([gated("a")]));
      expect(screen.getByText(/^Your approval:/)).toBeVisible();
      expect(
        screen.queryByText("Edit the change and submit it again."),
      ).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
      expect(waive).toHaveBeenCalledWith("/p", CUT_ANYWAY_REASON);
      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(
        "Waiver recorded. Retry approval to apply pending edits.",
      );
      expect(status).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
    });

    it("names the command in plain words, never by its wire name", () => {
      renderHost(hostAttention([gated("t", DocumentCommand.RemoveTrack)]));
      expect(
        screen.getByText(`Your change: ${TRANSCRIPT_REFINE_REFUSAL}`),
      ).toBeVisible();
    });

    it("clears every gated entry with one waiver", async () => {
      waive.mockResolvedValue({});
      renderHost(hostAttention([gated("a-1"), gated("a-2")]));
      await userEvent.click(
        screen.getAllByRole("button", { name: "Cut anyway" })[0]!,
      );
      expect(await screen.findAllByRole("status")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
    });

    it("offers the form for a refusal that arrives after a waiver, and forgets one that left", async () => {
      waive.mockResolvedValue({});
      const view = (ids: string[]) => (
        <ReviewQueue
          items={[]}
          content={reviewContent}
          selectedId={null}
          filter="all"
          attention={hostAttention(ids.map((id) => gated(id)))}
          onFilter={vi.fn()}
          onSelect={vi.fn()}
        />
      );
      const { rerender } = render(view(["first"]));
      await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
      await screen.findByRole("status");
      rerender(view(["first", "second"]));
      expect(
        screen.getAllByRole("button", { name: "Cut anyway" }),
      ).toHaveLength(1);
      expect(screen.getAllByRole("status")).toHaveLength(1);
      rerender(view([]));
      rerender(view(["first"]));
      expect(screen.getByRole("button", { name: "Cut anyway" })).toBeVisible();
    });

    it("keeps a waived status while the filter hides the group", async () => {
      waive.mockResolvedValue({});
      const attn = hostAttention([gated("a")]);
      const view = (filter: ReviewFilter) => (
        <ReviewQueue
          items={[]}
          content={reviewContent}
          selectedId={null}
          filter={filter}
          attention={attn}
          onFilter={vi.fn()}
          onSelect={vi.fn()}
        />
      );
      const { rerender } = render(view("all"));
      await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
      await screen.findByRole("status");
      rerender(view("comments"));
      rerender(view("all"));
      expect(screen.getByRole("status")).toHaveTextContent("Waiver recorded");
    });

    it("offers no waiver without a host project, nor on a refusal that was not refused", () => {
      renderHost(
        hostAttention(
          [
            gated("a"),
            offlineConflict({
              kind: "unknown",
              recovery: "inspect-history",
              reason: TRANSCRIPT_REFINE_REFUSAL,
              command: { command_id: "b" },
            }),
          ],
          { refineWaiverProject: undefined },
        ),
      );
      expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
    });

    it("shows Retry for unreadable saved edits", async () => {
      const onRetry = vi.fn();
      renderHost(hostAttention([], { unreadable: true, onRetry }));
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetry).toHaveBeenCalledOnce();
    });
  });
});
