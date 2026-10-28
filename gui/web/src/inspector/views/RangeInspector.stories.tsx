import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { selections } from "../../test/episodeFixture";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Range",
  component: InspectorRailStory,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  args: { placement: "sheet" },
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof InspectorRailStory>;

const rangeFieldsPlay: Story["play"] = async ({ canvasElement }) => {
  await expect(
    await within(canvasElement).findByRole("region", { name: "Range fields" }),
  ).toBeVisible();
};

export const ExactRange: Story = {
  parameters: { episode: { selection: selections.exactRange } },
  play: rangeFieldsPlay,
};

export const WordRange: Story = {
  parameters: { episode: { selection: selections.range } },
  play: rangeFieldsPlay,
};
