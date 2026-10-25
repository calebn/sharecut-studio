import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { recordRoom } from "../test/episodeFixture";
import { withEpisode } from "../test/withEpisode";
import { RecordTransportChip } from "./RecordTransportChip";

const meta: Meta<typeof RecordTransportChip> = {
  title: "Templates/RecordTransportChip",
  component: RecordTransportChip,
  decorators: [withEpisode],
  parameters: { layout: "padded", episode: { record: recordRoom } },
};

export default meta;
type Story = StoryObj<typeof RecordTransportChip>;

export const Recording: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Recording. Open record panel",
      }),
    ).toBeVisible();
  },
};

export const Paused: Story = {
  parameters: {
    episode: { record: { ...recordRoom, state: "paused", take_index: 0 } },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Paused. Open record panel",
      }),
    ).toBeVisible();
  },
};

export const Stopped: Story = {
  parameters: { episode: { record: { ...recordRoom, state: "stopped" } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Open record panel",
      }),
    ).toBeVisible();
  },
};
