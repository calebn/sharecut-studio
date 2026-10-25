import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { MIRA } from "../test/episodeFixture";
import { withEpisode } from "../test/withEpisode";
import { SoloChip } from "./SoloChip";

const meta: Meta<typeof SoloChip> = {
  title: "Templates/SoloChip",
  component: SoloChip,
  decorators: [withEpisode],
  parameters: {
    layout: "padded",
    episode: { state: { soloTracks: { [MIRA]: true } } },
  },
};

export default meta;
type Story = StoryObj<typeof SoloChip>;

export const Soloed: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: /Clear solo/ }),
    ).toBeVisible();
  },
};
