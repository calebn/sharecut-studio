import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { RoomToneCapture } from "./RoomToneCapture";
import { recordStoryDecorator } from "./recordStoryDecorator";

const meta: Meta<typeof RoomToneCapture> = {
  title: "Templates/RoomToneCapture",
  component: RoomToneCapture,
  tags: ["autodocs"],
  parameters: isolatedStoryParameters,
  decorators: [recordStoryDecorator],
  args: {
    status: "idle",
    error: null,
    micReady: true,
    captureReady: true,
    onRecord: fn(),
    onSkip: fn(),
    onRetry: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof RoomToneCapture>;
export const Ready: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Record room tone" }),
    );
    await expect(args.onRecord).toHaveBeenCalledOnce();
  },
};
export const MicrophoneRequired: Story = {
  args: { micReady: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Record room tone" }),
    ).toBeDisabled();
  },
};
export const LocalCaptureNotReady: Story = { args: { captureReady: false } };
export const Capturing: Story = {
  args: { status: "capturing" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Recording room tone…" }),
    ).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Skip" }));
    await expect(args.onSkip).toHaveBeenCalledOnce();
  },
};
export const TooLoud: Story = {
  args: { status: "too_loud" },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Retry" }),
    );
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};
export const Recorded: Story = { args: { status: "recorded" } };
export const Skipped: Story = { args: { status: "skipped" } };
export const CaptureFailed: Story = {
  args: { status: "error", error: "Local storage is unavailable." },
};
