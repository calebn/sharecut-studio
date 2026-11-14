import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CUT_ANYWAY_REASON } from "../inspector/TranscriptRefineRecovery";
import { reviewContent } from "../storybook/reviewContent";
import { QUEUE_WITHOUT_CHECKS } from "../storybook/reviewFixtures";
import { expectNoA11yViolations } from "../test/a11y";
import { offlineConflict } from "../test/fixtures";
import { DocumentCommand } from "../types/documentCommands.generated";
import { TRANSCRIPT_REFINE_REFUSAL } from "../utils/apiError";
import { ReviewQueue, type ReviewQueueProps } from "./ReviewQueue";
import {
  attentionRowsOf,
  type ReviewAttention,
  type ReviewFilter,
  type ReviewItem,
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

  it("keeps selection but removes the phone decision gesture for an unavailable word", async () => {
    const onSelect = vi.fn();
    const onVerb = vi.fn();
    const onKeep = vi.fn();
    const content = (item: ReviewItem) => {
      const shown = reviewContent(item);
      return item.kind === "unsure-word" && shown.card.unsure
        ? {
            ...shown,
            card: {
              ...shown.card,
              unsure: {
                ...shown.card.unsure,
                disabledReason: "Transcript words are still loading.",
              },
            },
          }
        : shown;
    };
    const item: ReviewItem = {
      id: "u1",
      kind: "unsure-word",
      at: 614,
      savedSeconds: 0,
    };
    const available: ReviewItem = {
      id: "f1",
      kind: "filler",
      at: 700,
      savedSeconds: 0.4,
    };
    const { container } = render(
      <ReviewQueue
        items={[item, available]}
        content={content}
        selectedId={null}
        filter="all"
        onFilter={vi.fn()}
        onSelect={onSelect}
        onVerb={onVerb}
        onKeep={onKeep}
      />,
    );

    const row = container.querySelector(".sys-queue-row") as HTMLElement;
    const at = (clientX: number) => ({ clientX, clientY: 0, pointerId: 1 });
    fireEvent.pointerDown(row, { ...at(100), isPrimary: true });
    fireEvent.pointerMove(row, at(190));
    expect(row).not.toHaveAttribute("data-swipe", "verb");
    fireEvent.pointerUp(row, at(190));
    expect(onVerb).not.toHaveBeenCalled();

    fireEvent.pointerDown(row, { ...at(190), isPrimary: true });
    fireEvent.pointerMove(row, at(100));
    expect(row).not.toHaveAttribute("data-swipe", "keep");
    fireEvent.pointerUp(row, at(100));
    expect(onKeep).not.toHaveBeenCalled();

    await userEvent.click(row.querySelector("button") as HTMLButtonElement);
    expect(onSelect).toHaveBeenCalledWith("u1");

    const availableRow = container.querySelector(
      '.sys-queue-row[data-kind="filler"]',
    ) as HTMLElement;
    fireEvent.pointerDown(availableRow, { ...at(100), isPrimary: true });
    fireEvent.pointerMove(availableRow, at(190));
    expect(availableRow).toHaveAttribute("data-swipe", "verb");
    fireEvent.pointerUp(availableRow, at(190));
    expect(onVerb).toHaveBeenCalledWith("f1");
  });

  it("lists every edit in episode order under one heading when sorted by time", async () => {
    const onSort = vi.fn();
    const items = [
      { id: "f1", kind: "filler" as const, at: 30, savedSeconds: 0.4 },
      { id: "p1", kind: "pause" as const, at: 10, savedSeconds: 0.6 },
      { id: "f2", kind: "filler" as const, at: 5, savedSeconds: 0.3 },
    ];
    const props = {
      items,
      content: reviewContent,
      selectedId: null,
      filter: "all" as const,
      onFilter: vi.fn(),
      onSelect: vi.fn(),
      onSort,
    };
    const { container, rerender } = render(<ReviewQueue {...props} />);
    expect(screen.getByRole("button", { name: "By kind" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByLabelText("In time order")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "By time" }));
    expect(onSort).toHaveBeenCalledWith("time");
    rerender(<ReviewQueue {...props} sort="time" />);
    const section = screen.getByLabelText("In time order");
    expect(section.querySelectorAll(".sys-queue-row")).toHaveLength(3);
    expect(container.querySelectorAll(".rv-group")).toHaveLength(1);
    for (const row of section.querySelectorAll(".sys-queue-row")) {
      const select = row.querySelector("button");
      if (select) await userEvent.click(select);
    }
    expect(props.onSelect.mock.calls.map(([id]) => id)).toEqual([
      "f2",
      "p1",
      "f1",
    ]);
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
    expect(getByText(/comments?$/)).toBeInTheDocument();
    expect(queryByRole("button", { name: /^Checks/ })).toBeNull();
  });

  it("offers a guest no filter or sort with one kind of item, and lists by time", () => {
    render(
      <ReviewQueue
        items={[
          { id: "a", kind: "comment", at: 9, savedSeconds: 0 },
          { id: "b", kind: "comment", at: 2, savedSeconds: 0 },
        ]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        onFilter={vi.fn()}
        onSort={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole("group", { name: "Filter" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Sort" })).toBeNull();
    expect(screen.queryByText(/resolved$/)).toBeNull();
    expect(screen.getByLabelText("In time order")).toBeInTheDocument();
  });

  it("keeps a host's Filter and Sort with one kind of item", () => {
    render(
      <ReviewQueue
        items={[
          { id: "a", kind: "comment", at: 9, savedSeconds: 0 },
          { id: "b", kind: "comment", at: 2, savedSeconds: 0 },
        ]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        canDecide
        onFilter={vi.fn()}
        onSort={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("group", { name: "Filter" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Sort" })).toBeInTheDocument();
    expect(document.querySelector(".rv-progress.sr-only")).toBeNull();
  });

  it("counts a guest queue of only suggestions as suggestions for a screen reader", () => {
    render(
      <ReviewQueue
        items={[
          { id: "a", kind: "suggestion", at: 9, savedSeconds: 0 },
          { id: "b", kind: "suggestion", at: 2, savedSeconds: 0 },
        ]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        onFilter={vi.fn()}
        onSort={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(document.querySelector(".rv-progress.sr-only")).toHaveTextContent(
      /^2 suggestions$/,
    );
  });

  it("keeps the filter, the sort, the visible count and the group heading for a guest queue with more than one kind", () => {
    render(
      <ReviewQueue
        items={[
          { id: "a", kind: "comment", at: 9, savedSeconds: 0 },
          ...fillers.slice(0, 1),
        ]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        onFilter={vi.fn()}
        onSort={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("group", { name: "Filter" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Sort" })).toBeInTheDocument();
    expect(document.querySelector(".rv-progress.sr-only")).toBeNull();
    expect(document.querySelector(".rv-group-name")).not.toBeNull();
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
    fireEvent.click(getByRole("button", { name: "Cut 2 clean edits" }));
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

    describe("cut suggestion conflict", () => {
      const suggestionRows = () =>
        attentionRowsOf(
          [
            offlineConflict({
              code: "range_changed",
              reason: "Selected audio changed. Select the range again.",
              command: {
                command_id: "cut-1",
                type: DocumentCommand.EditSelectedRange,
                payload: {
                  action: "cut",
                  targets: [
                    { intervals: [{ start: 724, end: 727 }], track_ids: ["t"] },
                  ],
                },
              },
            }),
          ],
          true,
        );
      const actions = () => ({
        onHear: vi.fn(),
        onSuggestAgain: vi.fn(),
        onDrop: vi.fn(),
      });

      it("keeps today's row when nothing is wired to the buttons", () => {
        renderQueue(attention({ rows: suggestionRows() }));
        expect(
          screen.getByText(
            "Your change: Selected audio changed. Select the range again.",
          ),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Hear/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /^Drop it/ })).toBeNull();
      });

      it("shows Hear, Suggest again here and Drop it in that Tab order", async () => {
        const user = userEvent.setup();
        const wired = actions();
        const rows = suggestionRows();
        const { container } = renderQueue(
          attention({ rows, suggestionActions: wired }),
        );
        expect(
          screen.getByText("Your cut at 12:04 overlaps a newer edit"),
        ).toBeInTheDocument();
        expect(screen.queryByText(/Edit the change/)).toBeNull();
        const group = screen.getByRole("group", {
          name: "Needs attention. 1 conflict",
        });
        const names = [
          "Hear your cut at 12:04",
          "Suggest again here, your cut at 12:04",
          "Drop it, your cut at 12:04",
        ];
        await user.click(group);
        await user.tab();
        for (const name of names) {
          // Dismiss all comes first in the group head.
          if (document.activeElement?.textContent === "Dismiss all") {
            await user.tab();
          }
          expect(document.activeElement).toBe(
            screen.getByRole("button", { name }),
          );
          await user.tab();
        }
        await user.click(screen.getByRole("button", { name: names[2]! }));
        expect(wired.onDrop).toHaveBeenCalledWith(rows[0]);
        expect(wired.onHear).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: names[0]! }));
        expect(wired.onHear).toHaveBeenCalledWith(rows[0]);
        await user.click(screen.getByRole("button", { name: names[1]! }));
        expect(wired.onSuggestAgain).toHaveBeenCalledWith(rows[0]);
        await expectNoA11yViolations(container);
      });

      describe("focus after a row leaves", () => {
        const cutAt = (id: string, start: number) =>
          attentionRowsOf(
            [
              offlineConflict({
                code: "range_changed",
                reason: "Selected audio changed. Select the range again.",
                command: {
                  command_id: id,
                  type: DocumentCommand.EditSelectedRange,
                  payload: {
                    action: "cut",
                    targets: [
                      {
                        intervals: [{ start, end: start + 2 }],
                        track_ids: ["t"],
                      },
                    ],
                  },
                },
              }),
            ],
            true,
          )[0]!;

        function Host({
          ids,
          keep = false,
          pending = 0,
          expose,
        }: {
          ids: string[];
          keep?: boolean;
          pending?: number;
          expose?: (remove: (id: string) => void) => void;
        }) {
          const [rows, setRows] = useState(() =>
            ids.map((id, i) => cutAt(id, 60 * (i + 1))),
          );
          expose?.((id) => setRows((now) => now.filter((r) => r.id !== id)));
          const leave = async (row: { id: string }) => {
            if (!keep) setRows((now) => now.filter((r) => r.id !== row.id));
          };
          return (
            <ReviewQueue
              items={[{ id: "m", kind: "comment", at: 5, savedSeconds: 0 }]}
              content={reviewContent}
              selectedId={null}
              filter="all"
              guest
              attention={attention({
                rows,
                pending,
                suggestionActions: {
                  onHear: vi.fn(),
                  onSuggestAgain: leave,
                  onDrop: leave,
                },
              })}
              onFilter={vi.fn()}
              onSelect={vi.fn()}
            />
          );
        }

        const drops = () => screen.getAllByRole("button", { name: /^Drop it/ });

        it("moves to the next row's first button", async () => {
          const user = userEvent.setup();
          render(<Host ids={["a", "b", "c"]} />);
          await user.click(drops()[0]!);
          expect(document.activeElement).toBe(
            screen.getAllByRole("button", { name: /^Hear your cut/ })[0],
          );
          expect(
            screen.getByRole("button", { name: /^Hear your cut at 2:00/ }),
          ).toBe(document.activeElement);
        });

        it("moves to the previous row when the last one leaves", async () => {
          const user = userEvent.setup();
          render(<Host ids={["a", "b"]} />);
          await user.click(
            screen.getByRole("button", {
              name: /^Suggest again here, your cut at 2:00/,
            }),
          );
          expect(document.activeElement).toBe(
            screen.getByRole("button", { name: /^Hear your cut at 1:00/ }),
          );
        });

        it("moves to the group when other lines remain", async () => {
          const user = userEvent.setup();
          render(<Host ids={["a"]} pending={2} />);
          await user.click(drops()[0]!);
          expect(document.activeElement).toBe(
            screen.getByRole("group", { name: /^Needs attention/ }),
          );
        });

        it("moves to the queue progress line when the group goes", async () => {
          const user = userEvent.setup();
          render(<Host ids={["a"]} />);
          await user.click(drops()[0]!);
          expect(
            screen.queryByRole("group", { name: /^Needs attention/ }),
          ).toBeNull();
          expect(document.activeElement).toHaveClass("rv-progress");
        });

        it("leaves focus on the button when the row is kept", async () => {
          const user = userEvent.setup();
          render(<Host ids={["a", "b"]} keep />);
          const first = drops()[0]!;
          await user.click(first);
          expect(document.activeElement).toBe(first);
        });

        it("does not take focus later when the guest clicked away after the row was kept", async () => {
          const user = userEvent.setup();
          let remove = (_id: string) => {};
          render(
            <Host
              ids={["a", "b"]}
              keep
              expose={(fn) => {
                remove = fn;
              }}
            />,
          );
          await user.click(drops()[0]!);
          await user.click(document.body);
          expect(document.activeElement).toBe(document.body);
          act(() => remove("a"));
          expect(document.activeElement).toBe(document.body);
        });
      });

      it("keeps the generic row for a conflict with no suggestion", () => {
        renderQueue(attention({ suggestionActions: actions() }));
        expect(screen.queryByRole("button", { name: /^Hear/ })).toBeNull();
        expect(
          screen.getByRole("group", { name: /^Needs attention/ }),
        ).toHaveTextContent(
          "Your change: Envelope changed since this edit was queued",
        );
      });
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
      const reason = screen.getByText(
        "Saved edits could not be read. Dismissal is unavailable.",
        { selector: "p" },
      );
      expect(reason).toBeVisible();
      expect(reason.closest(".sr-only")).toBeNull();
      expect(held).toHaveAttribute("aria-describedby", reason.id);
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
      expect(screen.getByText(/^1 comment$/)).toHaveFocus();
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
      expect(screen.getByText(/^1 comment$/)).not.toHaveFocus();
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

  it("keys groups by label: two groups of one kind render without a key warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <ReviewQueue
        items={[
          { id: "s1", kind: "suggestion", at: 1, savedSeconds: 1 },
          { id: "s2", kind: "suggestion", at: 2, savedSeconds: 1, mine: true },
        ]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        canDecide
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={vi.fn()}
      />,
    );
    const names = [...container.querySelectorAll(".rv-group-name")].map(
      (n) => n.textContent,
    );
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(
      error.mock.calls.filter((call) => String(call[0]).includes("key")),
    ).toEqual([]);
    error.mockRestore();
  });
});
