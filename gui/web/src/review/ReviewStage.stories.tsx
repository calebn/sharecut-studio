import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  expect,
  fireEvent,
  fn,
  userEvent,
  waitFor,
  within,
} from "storybook/test";
import { reviewContent } from "../storybook/reviewContent";
import {
  EXTRA_KIND_ITEMS,
  QUEUE_CHECKED,
  QUEUE_ITEMS,
  QUEUE_WITHOUT_CHECKS,
} from "../storybook/reviewFixtures";
import { ReviewStageHarness } from "../storybook/reviewHarness";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { playInCanvas } from "../storybook/storyPlay";

const PEAKS = Array.from(
  { length: 160 },
  (_, i) => 0.2 + 0.6 * Math.abs(Math.sin(i * 0.37)),
);

const meta: Meta<typeof ReviewStageHarness> = {
  title: "Stages/Review/Review",
  component: ReviewStageHarness,
  tags: ["autodocs"],
  args: {
    initialItems: QUEUE_WITHOUT_CHECKS,
    content: reviewContent,
    duration: 3120,
    peaks: PEAKS,
    initialSelectedId: "f1",
    toastMs: 600_000,
    onOpenInEdit: fn(),
    onComment: fn(),
    onDecide: fn(),
    onFindMore: fn(),
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
          "The Review stage in one frame: the queue, the Decision card, the Overview strip above the Player. Enter does the verb, X keeps, the arrows move on, A and B listen, Shift+Enter applies to the group as one undo step. The next undecided item is selected in the same frame as the decision. Tab keeps the page's focus order, so the buttons and the Undo toast stay reachable.\n\n**Motion.** Animations come later: the advance and the collapse use `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ReviewStageHarness>;

const progress = (canvas: HTMLElement) =>
  within(canvas).getByText(/of \d+ decided/).textContent;

async function press(canvasElement: HTMLElement, keys: string) {
  canvasElement.querySelector<HTMLElement>(".rv-stage")?.focus();
  await userEvent.keyboard(keys);
}

export const Mixed: Story = {
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    const before = progress(canvasElement);
    await press(canvasElement, "{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(progress(canvasElement)).toMatch(/^5 of 10/));
    await expect(view.queryByRole("button", { name: "Cut all 3" })).toBeNull();
    await userEvent.click(await view.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(progress(canvasElement)).toBe(before));
  }),
};

export const Suggestion: Story = {
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await press(canvasElement, "x");
    await expect(await view.findByText("Kept")).toBeInTheDocument();
    await expect(
      await view.findByRole("heading", { name: "Remove “uh,”" }),
    ).toBeInTheDocument();
  }),
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
    initialSelectedId: undefined,
  },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getAllByText("Nothing to decide").length).toBeGreaterThan(
      0,
    );
    await expect(
      view.getByRole("button", { name: "Go to Deliver" }),
    ).toBeInTheDocument();
    await expect(view.queryByRole("button", { name: "Cut" })).toBeNull();
    await expect(canvasElement.querySelector(".sys-decision-title")).toBeNull();
  }),
};

export const Loading: Story = { args: { state: "loading" } };

export const LoadError: Story = { name: "Error", args: { state: "error" } };

export const BulkRunning: Story = {
  args: { bulkRunning: { kind: "filler", total: 11, done: 4 } },
};

export const Processing: Story = {
  args: { job: { title: "Finding more suggestions", progress: 0.4 } },
};

export const RefineCheck: Story = {
  args: { initialItems: QUEUE_ITEMS },
  play: playInCanvas(async ({ canvasElement }) => {
    await press(canvasElement, "{Enter}");
    await expect(
      await within(canvasElement).findByText(/Check 1 word/),
    ).toBeInTheDocument();
  }),
};

export const CutAnywayPrompt: Story = {
  args: { initialItems: QUEUE_ITEMS },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await press(canvasElement, "{Enter}");
    await userEvent.click(
      await view.findByRole("button", { name: "Cut anyway" }),
    );
    await expect(args.onDecide).toHaveBeenCalledTimes(1);
    await expect(
      await view.findByRole("button", { name: "Undo" }),
    ).toBeInTheDocument();
  }),
};

export const TranscriptChecked: Story = {
  args: { initialItems: QUEUE_CHECKED },
  play: playInCanvas(async ({ canvasElement }) => {
    await press(canvasElement, "{Enter}");
    await expect(
      await within(canvasElement).findByRole("button", { name: "Undo" }),
    ).toBeInTheDocument();
    await expect(
      within(canvasElement).queryByRole("button", { name: "Cut anyway" }),
    ).toBeNull();
  }),
};

export const NewKinds: Story = {
  args: {
    initialItems: [...QUEUE_ITEMS, ...EXTRA_KIND_ITEMS],
    initialSelectedId: "r1",
  },
};

export const FalseStart: Story = {
  args: { initialItems: EXTRA_KIND_ITEMS, initialSelectedId: "k1" },
};

export const OtherSuggestion: Story = {
  args: { initialItems: EXTRA_KIND_ITEMS, initialSelectedId: "g1" },
};

export const Unplaced: Story = {
  args: { initialItems: EXTRA_KIND_ITEMS, initialSelectedId: "g2" },
};

export const Guest: Story = {
  args: { guest: true },
  play: playInCanvas(async ({ canvasElement }) => {
    const before = progress(canvasElement);
    await press(canvasElement, "{Enter}");
    await expect(progress(canvasElement)).toBe(before);
  }),
};

export const Phone: Story = {
  args: { layout: "phone" },
  parameters: isolatedStoryParameters,
};

export const PhoneSwipe: Story = {
  args: { layout: "phone" },
  parameters: isolatedStoryParameters,
  play: playInCanvas(async ({ canvasElement }) => {
    const body = canvasElement.querySelector(".sys-decision-body");
    if (!body) throw new Error("no card body");
    const swipe = async (dx: number) => {
      const at = { clientX: 200, clientY: 300, isPrimary: true, pointerId: 1 };
      await fireEvent.pointerDown(body, at);
      await fireEvent.pointerMove(body, { ...at, clientX: 200 + dx });
      await fireEvent.pointerUp(body, { ...at, clientX: 200 + dx });
    };
    await swipe(-100);
    await expect(
      await within(canvasElement).findByText("Kept"),
    ).toBeInTheDocument();
  }),
};
