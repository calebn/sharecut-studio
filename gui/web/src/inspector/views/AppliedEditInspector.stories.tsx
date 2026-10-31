import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { episode, MIRA, selections } from "../../test/episodeFixture";
import { appliedEditRecord } from "../../test/fixtures";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Applied edit",
  component: InspectorRailStory,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: { selection: selections.appliedEdit },
  },
};
export default meta;

// A mute with source clocks is the one applied edit that can be restored.
const mutedEpisode = episode({
  applied_edits: {
    count: 1,
    records: [
      appliedEditRecord({
        id: "applied-1",
        track_ids: [MIRA],
        timeline_start: 20.4,
        timeline_end: 21.2,
        source_start: 20.4,
        source_end: 21.2,
        params: { mute: true },
      }),
    ],
  },
});
type Story = StoryObj<typeof InspectorRailStory>;

export const Host: Story = {
  parameters: { episode: { project: mutedEpisode } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Applied edit" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Restore" })).toBeVisible();
  },
};

export const Viewer: Story = {
  parameters: { episode: { role: "viewer", project: mutedEpisode } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Applied edit" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Restore" })).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Open History" }),
    ).toBeNull();
  },
};
