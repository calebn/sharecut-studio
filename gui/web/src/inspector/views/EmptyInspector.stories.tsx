import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { episode } from "../../test/episodeFixture";
import { pendingEditView } from "../../test/fixtures";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Empty",
  component: InspectorRailStory,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  parameters: { layout: "fullscreen", episode: {} },
};
export default meta;
type Story = StoryObj<typeof InspectorRailStory>;

export const NothingSelected: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "Inspector" }),
    ).toBeVisible();
  },
};

export const UnmappedEdits: Story = {
  parameters: {
    episode: {
      project: episode({
        pending_edits: [
          pendingEditView({
            id: "pending-unmapped",
            reason: "Remove the cough",
            mappable: false,
            timeline_start: null,
            timeline_end: null,
            timeline_spans: [],
          }),
        ],
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "remove: Remove the cough",
      }),
    ).toBeVisible();
  },
};
