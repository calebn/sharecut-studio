import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import type { TakeClipping } from "./keeper/clipRegions";
import { recordStoryDecorator } from "./recordStoryDecorator";
import { TakeClippingReport } from "./TakeClippingReport";

const report: TakeClipping = {
  takeIndex: 1,
  known: true,
  regions: [
    { segmentIndex: 0, startMs: 65_000, endMs: 66_000, segmentStartMs: 65_000 },
    {
      segmentIndex: 1,
      startMs: 130_000,
      endMs: 131_000,
      segmentStartMs: 10_000,
    },
  ],
};
const meta: Meta<typeof TakeClippingReport> = {
  title: "Templates/TakeClippingReport",
  component: TakeClippingReport,
  tags: ["autodocs"],
  parameters: isolatedStoryParameters,
  decorators: [recordStoryDecorator],
  args: { report, roomState: "stopped" },
};
export default meta;
type Story = StoryObj<typeof TakeClippingReport>;
export const LiveClipping: Story = { args: { roomState: "recording" } };
export const PausedClipping: Story = { args: { roomState: "paused" } };
export const GuestReport: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("1:05–1:06")).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};
export const KnownClean: Story = {
  args: { report: { takeIndex: 1, known: true, regions: [] } },
};
export const Truncated: Story = {
  args: { report: { ...report, truncated: true } },
};
export const WaitingForTimeline: Story = {
  args: { jumpFor: () => null },
  play: async ({ canvasElement }) => {
    for (const button of within(canvasElement).getAllByRole("button", {
      name: /Jump to/,
    })) {
      await expect(button).toBeDisabled();
    }
  },
};
export const LandedOnTimeline: Story = {
  args: { jumpFor: () => fn() },
  play: async ({ canvasElement }) => {
    for (const button of within(canvasElement).getAllByRole("button", {
      name: /Jump to/,
    })) {
      await expect(button).toBeEnabled();
    }
  },
};
