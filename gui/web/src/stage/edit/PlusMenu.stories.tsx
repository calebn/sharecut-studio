import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { PlusMenu } from "./PlusMenu";

const meta: Meta<typeof PlusMenu> = {
  title: "Stages/Edit/PlusMenu",
  component: PlusMenu,
  beforeEach: episodeBeforeEach,
  decorators: [
    withEpisode,
    (Story) => (
      <div style={{ inlineSize: "11rem" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    episode: {},
    docs: {
      description: {
        component:
          "The + row under the last track header: Import audio, a new empty track, a chapter at the playhead and a Record take, each an existing command. Audio files dropped on the row become new tracks. A link that cannot add audio has no row.\n\n**Motion.** The panel drops in with `--motion-hover` through `ui/Menu`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PlusMenu>;

export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "+" }),
    );
    await expect(
      await within(document.body).findByRole("menuitem", {
        name: /Import audio/,
      }),
    ).toBeVisible();
  },
};

export const DropOver: Story = {
  args: { dropOver: true, fileCount: 2 },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: /2/ }),
    ).toBeVisible();
  },
};

export const GuestCommenter: Story = {
  parameters: { episode: { role: "commenter" } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("button", { name: "+" }),
    ).toBeNull();
  },
};
