import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { QUEUE_ITEMS, reviewContent } from "../storybook/reviewFixtures";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { ReviewStage, type ReviewStageProps } from "./ReviewStage";

const NO_CHECK = QUEUE_ITEMS.filter((i) => i.id !== "c1" && i.id !== "u1");
const PEAKS = Array.from(
  { length: 160 },
  (_, i) => 0.2 + 0.6 * Math.abs(Math.sin(i * 0.37)),
);

const meta: Meta<typeof ReviewStage> = {
  title: "Stages/Review/Review",
  component: ReviewStage,
  tags: ["autodocs"],
  args: {
    initialItems: NO_CHECK,
    content: reviewContent,
    duration: 3120,
    peaks: PEAKS,
    toastMs: 600_000,
    onOpenInEdit: fn(),
    onComment: fn(),
    onWaive: fn(),
    onHandOff: fn(),
    onRetry: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ blockSize: "100dvh" }}>
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
          "The Review stage in one frame: the queue, the Decision card, the Overview strip above the Player. Enter does the verb, X keeps, Tab and the arrows move on, A and B listen, Shift+Enter applies to the group as one undo step. The next undecided item is selected in the same frame as the decision. A decided row collapses to one line.\n\n**Motion.** Animations come later: the advance and the collapse use `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ReviewStage>;

async function press(canvasElement: HTMLElement, keys: string) {
  canvasElement.querySelector<HTMLElement>(".rv-stage")?.focus();
  await userEvent.keyboard(keys);
}

export const Mixed: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const view = within(canvasElement);
    await expect(
      view.getByRole("button", { name: "Cut all 3" }),
    ).toBeInTheDocument();
    const before = view.getByText(/of \d+ decided/).textContent;
    await press(canvasElement, "{Enter}");
    await waitFor(() =>
      expect(view.getByText(/of \d+ decided/).textContent).not.toBe(before),
    );
    await expect(
      await view.findByRole("button", { name: "Undo" }),
    ).toBeInTheDocument();
  },
};

export const Suggestion: Story = {
  args: { initialSelectedId: "f1" },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await press(canvasElement, "x");
    await expect(
      await within(canvasElement).findByRole("button", { name: "Undo" }),
    ).toBeInTheDocument();
  },
};

export const Comment: Story = {
  args: { initialSelectedId: "m1", initialFilter: "comments" },
};

export const Check: Story = {
  args: { initialItems: QUEUE_ITEMS, initialSelectedId: "c1" },
};

export const Empty: Story = {
  args: {
    initialItems: QUEUE_ITEMS.map((i) => ({
      ...i,
      result: "applied" as const,
    })),
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const LoadError: Story = {
  name: "Error",
  args: { state: "error" },
};

export const BulkRunning: Story = {
  args: { bulkRunning: { kind: "filler", total: 11, done: 4 } },
};

export const Processing: Story = {
  args: { job: { title: "Finding more suggestions", progress: 0.4 } },
};

export const RefineCheck: Story = {
  args: { initialItems: QUEUE_ITEMS, initialSelectedId: "f1" },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await press(canvasElement, "{Enter}");
    await expect(
      await within(canvasElement).findByRole("button", { name: "Cut anyway" }),
    ).toBeInTheDocument();
  },
};

export const CutAnywayPrompt: Story = {
  args: { initialItems: QUEUE_ITEMS, initialSelectedId: "f1" },
  play: async ({ canvasElement, args, viewMode }) => {
    if (viewMode === "docs") return;
    const view = within(canvasElement);
    await press(canvasElement, "{Enter}");
    await userEvent.click(view.getByRole("button", { name: "Cut anyway" }));
    await expect(args.onWaive).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Cut anyway" })).toBeNull(),
    );
  },
};

export const TranscriptChecked: Story = {
  args: { initialItems: QUEUE_ITEMS, initialSelectedId: "u1" },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const view = within(canvasElement);
    await press(canvasElement, "{Enter}");
    await expect(view.getByText(/of \d+ decided/)).toBeInTheDocument();
  },
};

export const Guest: Story = {
  args: { guest: true, initialSelectedId: "f1" },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const before =
      within(canvasElement).getByText(/of \d+ decided/).textContent;
    await press(canvasElement, "{Enter}");
    await expect(
      within(canvasElement).getByText(/of \d+ decided/).textContent,
    ).toBe(before);
  },
};

export const BulkUndo: Story = {
  args: { initialSelectedId: "f1" },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const view = within(canvasElement);
    const before = view.getByText(/of \d+ decided/).textContent;
    await press(canvasElement, "{Shift>}{Enter}{/Shift}");
    await waitFor(() =>
      expect(view.getByText(/of \d+ decided/).textContent).not.toBe(before),
    );
    await userEvent.click(await view.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(view.getByText(/of \d+ decided/).textContent).toBe(before),
    );
  },
};

export const Advance: Story = {
  args: { initialSelectedId: "f1" },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const view = within(canvasElement);
    await press(canvasElement, "x");
    await expect(view.getByText(/of \d+ decided/)).toBeInTheDocument();
    await press(canvasElement, "{Tab}");
  },
};

export const UnsureExcluded: Story = {
  args: { initialSelectedId: "f1" },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const view = within(canvasElement);
    await expect(
      await view.findByRole("button", { name: "Cut all 3" }),
    ).toBeInTheDocument();
  },
};

const phoneParameters = { ...isolatedStoryParameters };

export const Phone: Story = {
  args: { layout: "phone" } satisfies Partial<ReviewStageProps>,
  parameters: phoneParameters,
};

export const PhoneSwipe: Story = {
  args: { layout: "phone", initialSelectedId: "f1" },
  parameters: phoneParameters,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await press(canvasElement, "x");
    await expect(
      await within(canvasElement).findByRole("button", { name: "Undo" }),
    ).toBeInTheDocument();
  },
};
