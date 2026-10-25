import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { recordRoom } from "../test/episodeFixture";
import { withEpisode } from "../test/withEpisode";
import { RecordingOverlay } from "./RecordingOverlay";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const take = {
  ...recordRoom,
  state: "recording" as const,
  take_index: 1,
  timeline_start_sec: 12,
  recording_ms: 8_000,
};

const meta: Meta<typeof RecordingOverlay> = {
  title: "Templates/RecordingOverlay",
  component: RecordingOverlay,
  decorators: [timelineLaneStoryDecorator, withEpisode],
  parameters: {
    lanePreviewLabel: "Recording overlay preview",
    episode: { record: take },
  },
  args: { zoomPxPerSec: 20, trailingPadPx: 0 },
};

export default meta;
type Story = StoryObj<typeof RecordingOverlay>;

export const Recording: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("img", {
        name: "Take 2 recording — provisional recording",
      }),
    ).toBeVisible();
  },
};

export const Paused: Story = {
  parameters: { episode: { record: { ...take, state: "paused" } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("img", {
        name: "Take 2 paused — provisional recording",
      }),
    ).toBeVisible();
  },
};
