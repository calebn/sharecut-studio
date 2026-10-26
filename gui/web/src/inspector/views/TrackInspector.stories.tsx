import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { MIRA, selections, TOMAS } from "../../test/episodeFixture";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Track",
  component: InspectorRailStory,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: { selection: selections.track },
  },
};
export default meta;
type Story = StoryObj<typeof InspectorRailStory>;

export const Host: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Mira" }),
    ).toBeVisible();
  },
};

export const Viewer: Story = {
  parameters: { episode: { role: "viewer" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Mira" }),
    ).toBeVisible();
  },
};

export const MultipleTracks: Story = {
  parameters: {
    episode: {
      selection: { kind: "track", trackId: MIRA, trackIds: [MIRA, TOMAS] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Mira" }),
    ).toBeVisible();
  },
};
