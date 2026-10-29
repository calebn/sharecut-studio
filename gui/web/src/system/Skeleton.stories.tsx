import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Skeleton } from "./Skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "System/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
  args: { onRetry: fn() },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'Nothing for 300 ms, then static grey blocks in the destination\'s real layout, then at 4 s the line "Still loading…" with Retry. The times are props; pass `elapsedMs` to freeze a phase.\n\n**Motion.** No shimmer until the animation pass, then `--motion-loop-skeleton` (1.6 s). The 300 ms and 4 s timings are state, not animation.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Skeleton>;

const blocksIn = (root: HTMLElement) =>
  root.querySelectorAll(".sys-skeleton-block");

export const Blank: Story = {
  args: { elapsedMs: 100 },
  play: async ({ canvasElement }) => {
    await expect(blocksIn(canvasElement)).toHaveLength(0);
    await expect(
      canvasElement.querySelector("[aria-busy='true']"),
    ).toHaveAttribute("data-phase", "blank");
    await expect(within(canvasElement).queryByRole("status")).toBeNull();
  },
};
export const List: Story = {
  args: { elapsedMs: 1000 },
  play: async ({ canvasElement }) => {
    await expect(blocksIn(canvasElement)).toHaveLength(4);
    await expect(
      canvasElement.querySelector(".sys-skeleton-blocks--list"),
    ).not.toBeNull();
    await expect(within(canvasElement).queryByRole("status")).toBeNull();
  },
};
export const Cards: Story = {
  args: { elapsedMs: 1000, layout: "cards", rows: 6 },
  play: async ({ canvasElement }) => {
    await expect(blocksIn(canvasElement)).toHaveLength(6);
    await expect(
      canvasElement.querySelector(".sys-skeleton-blocks--cards"),
    ).not.toBeNull();
  },
};
export const StillLoading: Story = {
  args: { elapsedMs: 5000 },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Still loading…")).toBeVisible();
    await expect(blocksIn(canvasElement)).toHaveLength(4);
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

/** Timers run for real: blocks at 50 ms and Retry at 400 ms here. */
export const Timed: Story = {
  args: { blankMs: 50, retryMs: 400 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(blocksIn(canvasElement)).toHaveLength(4));
    await expect(canvas.queryByText("Still loading…")).toBeNull();
    await expect(await canvas.findByText("Still loading…")).toBeVisible();
  },
};
