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
import { openDialogByLauncher } from "../test/storyDialog";
import { Button } from "../ui";
import { ReviewQueue, type ReviewQueueProps } from "./ReviewQueue";
import type { ReviewFilter } from "./reviewQueueModel";

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
  tags: ["autodocs"],
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
