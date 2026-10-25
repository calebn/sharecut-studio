import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { selections } from "../../test/episodeFixture";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Social clip",
  component: InspectorRailStory,
  decorators: [withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: { selection: selections.social },
  },
};
export default meta;
type Story = StoryObj<typeof InspectorRailStory>;

export const Host: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: "A loaf tells you when it is ready",
      }),
    ).toBeVisible();
  },
};

export const Viewer: Story = {
  parameters: { episode: { role: "viewer" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: "A loaf tells you when it is ready",
      }),
    ).toBeVisible();
  },
};
