import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { recordSnapshot } from "../test/fixtures";
import { RecIndicator } from "./RecIndicator";
import { recordStoryDecorator } from "./recordStoryDecorator";

const snapshot = (state: "lobby" | "recording" | "paused" | "stopped") =>
  recordSnapshot({ state, recording_ms: 70_000 });

const meta: Meta<typeof RecIndicator> = {
  title: "Templates/RecIndicator",
  component: RecIndicator,
  tags: ["autodocs"],
  decorators: [recordStoryDecorator],
  args: { clockNowMs: 1_000_000 },
};

export default meta;
type Story = StoryObj<typeof RecIndicator>;

export const WaitingForHost: Story = {
  args: { snapshot: snapshot("lobby"), clockId: "rec-wait-clock" },
};

export const Recording: Story = {
  args: {
    snapshot: snapshot("recording"),
    clockId: "rec-record-clock",
    clipping: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("REC")).toBeVisible();
    await expect(
      canvas.getByRole("img", { name: "Take: no clipping" }),
    ).toBeVisible();
  },
};

export const Clipped: Story = {
  args: {
    snapshot: snapshot("recording"),
    clockId: "rec-clipped-clock",
    clipping: true,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", {
        name: "Take: clipping detected",
      }),
    ).toHaveAttribute("data-lit", "true");
  },
};

export const CaptureFailed: Story = {
  args: {
    snapshot: snapshot("recording"),
    clockId: "rec-failed-clock",
    capture: "failed",
    clipping: false,
  },
};

export const NoAudio: Story = {
  args: {
    snapshot: snapshot("recording"),
    clockId: "rec-silent-clock",
    capture: "silent",
    clipping: false,
  },
};

export const WaitingForMicrophone: Story = {
  args: {
    snapshot: snapshot("recording"),
    clockId: "rec-pending-clock",
    capture: "pending",
    clipping: false,
  },
};

export const PausedOffline: Story = {
  args: {
    snapshot: snapshot("paused"),
    clockId: "rec-paused-clock",
    offline: true,
    clipping: false,
  },
};

export const Stopped: Story = {
  args: { snapshot: snapshot("stopped"), clockId: "rec-stopped-clock" },
};
