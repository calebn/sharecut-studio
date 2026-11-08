import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { reviewContent } from "../storybook/reviewContent";
import { QUEUE_ITEMS } from "../storybook/reviewFixtures";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { Sheet } from "../system/Sheet";
import { offlineConflict } from "../test/fixtures";
import { openDialogByLauncher } from "../test/storyDialog";
import { episodeBeforeEach } from "../test/withEpisode";
import { DocumentCommand } from "../types/documentCommands.generated";
import { Button } from "../ui";
import { TRANSCRIPT_REFINE_REFUSAL } from "../utils/apiError";
import { formatTimeShort } from "../utils/time";
import { ReviewQueue, type ReviewQueueProps } from "./ReviewQueue";
import {
  attentionRowsOf,
  type ReviewAttention,
  type ReviewFilter,
  type ReviewItem,
} from "./reviewQueueModel";

function StatefulQueue(props: ReviewQueueProps) {
  const [filter, setFilter] = useState<ReviewFilter>(props.filter);
  const [selectedId, setSelectedId] = useState(props.selectedId);
  return (
    <ReviewQueue
      {...props}
      filter={filter}
      selectedId={selectedId}
      onFilter={setFilter}
      onSelect={setSelectedId}
    />
  );
}

const meta: Meta<typeof ReviewQueue> = {
  title: "Stages/Review/Queue",
  component: ReviewQueue,
  args: {
    items: QUEUE_ITEMS,
    content: reviewContent,
    selectedId: "f1",
    filter: "all",
    onFilter: fn(),
    onSelect: fn(),
    onVerb: fn(),
    onKeep: fn(),
    onBulk: fn(),
    onFindMore: fn(),
    onRetry: fn(),
  },
  render: (args) => <StatefulQueue {...args} />,
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxWidth: "24rem" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Review queue: one progress sentence, a filter with counts, groups in a fixed order (Check, Unsure words, Comments, Fillers, Pauses, Sounds), a bulk verb on the groups that allow one, and a collapsed Decided group. Seconds saved is one number. Unsure words, blocked items and decided items are never part of a bulk.\n\n**Motion.** Animations come later: a decided row collapses to one line with `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ReviewQueue>;

const LONG_LIST_ITEMS: readonly ReviewItem[] = [
  ...Array.from({ length: 159 }, (_, index) => ({
    id: `unsure-${String(index + 1).padStart(3, "0")}`,
    kind: "unsure-word" as const,
    at: index * 4,
    savedSeconds: 0,
  })),
  { id: "comment-boat", kind: "comment", at: 700, savedSeconds: 0 },
];

function longListContent(item: ReviewItem) {
  if (item.kind === "comment") {
    return {
      row: { snippet: "Keep the laugh by the boat?", time: "11:40" },
      card: {
        title: "Rosa asks about the laugh",
        time: "11:40",
        comment: {
          author: { name: "Rosa" },
          time: "11:40",
          body: "Keep the laugh by the boat?",
        },
      },
    };
  }

  const ordinal = item.id.slice("unsure-".length);
  const word = `unclear-word-${ordinal}`;
  const time = formatTimeShort(item.at);
  return {
    row: { snippet: word, time },
    card: {
      title: `Check “${word}”`,
      time,
      unsure: { word, guess: word, id: item.id },
    },
  };
}

export const Groups: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText(/2 of 12 decided/)).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Cut all 3" }));
    const ids = (args.onBulk as ReturnType<typeof fn>).mock.calls[0]?.[0].bulk
      .ids;
    await expect(ids).toEqual(["f1", "f2", "f4"]);
    await expect(ids).not.toContain("f3");
  },
};

export const LongList: Story = {
  args: {
    items: LONG_LIST_ITEMS,
    content: longListContent,
    selectedId: "unsure-001",
  },
};

export const FilteredComments: Story = {
  name: "Filtered",
  args: { filter: "comments" },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByRole("button", { name: /Cut all/ })).toBeNull();
    await userEvent.click(view.getByRole("button", { name: /^Suggestions/ }));
    await expect(
      view.getByRole("button", { name: "Cut all 3" }),
    ).toBeInTheDocument();
  },
};

export const Empty: Story = {
  args: { items: [], selectedId: null },
};

export const Loading: Story = {
  args: { state: "loading", selectedId: null },
};

export const LoadError: Story = {
  name: "Error",
  args: { state: "error", selectedId: null },
};

export const Phone: Story = {
  parameters: isolatedStoryParameters,
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

function QueueSheet(props: ReviewQueueProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open queue</Button>
      <Sheet
        form="bottom"
        title="Review queue"
        open={open}
        detent="half"
        onClose={() => setOpen(false)}
      >
        <StatefulQueue {...props} />
      </Sheet>
    </>
  );
}

export const PhoneQueueSheet: Story = {
  parameters: isolatedStoryParameters,
  decorators: [],
  render: (args) => <QueueSheet {...args} />,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await openDialogByLauncher(canvasElement, {
      launcherName: "Open queue",
      dialogName: "Review queue",
    });
  },
};

export const EditorGuest: Story = {
  args: {
    guest: true,
    canDecide: true,
    filter: "suggestions",
    selectedId: "f1",
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getAllByRole("button", { name: /Cut all/ }).length,
    ).toBeGreaterThan(0);
    await expect(view.queryByRole("button", { name: /Find more/ })).toBeNull();
  },
};

export const GuestFiltered: Story = {
  args: { guest: true, filter: "suggestions", selectedId: "f1" },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByRole("button", { name: /Cut all/ })).toBeNull();
    await expect(view.queryByRole("button", { name: /Find more/ })).toBeNull();
  },
};

const guestAttention = (
  over: Partial<ReviewAttention> = {},
): ReviewAttention => ({
  pending: 0,
  rows: attentionRowsOf(
    [
      offlineConflict({
        command: { command_id: "conflict-1", type: "TrimClip" },
        reason: "Clip was already trimmed",
      }),
      offlineConflict({
        command: { command_id: "conflict-2" },
        kind: "unknown",
        reason: "The host may have applied it",
        recovery: "inspect-history",
      }),
    ],
    true,
  ),
  unreadable: false,
  dismissFailed: false,
  checking: false,
  canDismiss: true,
  onDismissAll: fn(),
  onRetry: fn(),
  ...over,
});

/** The rows sit outside the filter counts: "All N" and the chip counts do not include them. */
export const GuestConflicts: Story = {
  args: {
    guest: true,
    items: QUEUE_ITEMS.filter((i) => i.kind === "comment"),
    attention: guestAttention(),
    selectedId: null,
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("group", { name: "Needs attention. 2 conflicts" }),
    ).toBeInTheDocument();
    await expect(
      view.getByText("Your change: Clip was already trimmed"),
    ).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Dismiss all" }));
    await expect(args.attention?.onDismissAll).toHaveBeenCalled();
  },
};

export const GuestSavedEditsUnreadable: Story = {
  args: {
    guest: true,
    items: [],
    attention: guestAttention({ rows: [], unreadable: true }),
    selectedId: null,
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Retry" }));
    await expect(args.attention?.onRetry).toHaveBeenCalled();
  },
};

const hostAttention = (
  over: Partial<ReviewAttention> = {},
): ReviewAttention => ({
  ...guestAttention({
    rows: attentionRowsOf(
      [
        offlineConflict({
          command: { command_id: "undo-1", type: "UndoHistory" },
          kind: "unknown",
          reason: "The host did not confirm this edit",
          recovery: "inspect-history",
        }),
      ],
      false,
    ),
  }),
  pending: 2,
  onSendNow: fn(),
  onInspectHistory: fn(),
  ...over,
});

export const HostWaitingEdits: Story = {
  args: {
    items: QUEUE_ITEMS.filter((i) => i.kind === "comment"),
    attention: hostAttention(),
    selectedId: null,
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("group", {
        name: "Needs attention. 2 pending, 1 conflict",
      }),
    ).toBeInTheDocument();
    await expect(view.getByText("2 edits waiting to send")).toBeVisible();
    await userEvent.click(view.getByRole("button", { name: "Send now" }));
    await expect(args.attention?.onSendNow).toHaveBeenCalledTimes(1);
    await userEvent.click(
      view.getByRole("button", { name: "Inspect History" }),
    );
    await expect(args.attention?.onInspectHistory).toHaveBeenCalledTimes(1);
  },
};

export const HostRefineWaiver: Story = {
  beforeEach: episodeBeforeEach,
  parameters: {
    episode: { responses: { "POST /api/transcript/refine/waive": {} } },
  },
  args: {
    items: [],
    selectedId: null,
    attention: hostAttention({
      pending: 0,
      refineWaiverProject: "/episodes/mira/episode.sharecut",
      rows: attentionRowsOf(
        [
          offlineConflict({
            reason: TRANSCRIPT_REFINE_REFUSAL,
            command: {
              command_id: "approve-1",
              type: DocumentCommand.ApproveEdits,
            },
          }),
        ],
        false,
      ),
    }),
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(/^Your approval:/)).toBeVisible();
    await userEvent.click(view.getByRole("button", { name: "Cut anyway" }));
    await expect(
      await view.findByText(
        "Waiver recorded. Retry approval to apply pending edits.",
      ),
    ).toBeVisible();
  },
};
