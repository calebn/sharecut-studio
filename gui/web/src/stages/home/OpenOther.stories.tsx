import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { NOT_AN_EPISODE, OpenOther } from "./OpenOther";

const meta: Meta<typeof OpenOther> = {
  title: "Stages/Home/OpenOther",
  component: OpenOther,
  tags: ["autodocs"],
  args: {
    mode: "picker",
    path: "",
    onChooseFolder: fn(),
    onPathChange: fn(),
    onSubmit: fn(),
  },
  decorators: [
    (Story) => (
      <div className="sys-open-stage">
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          '"Open other…" sits at the end of the Recent heading. Without a folder picker, it opens a path form above the Recent cards. Enter submits, and Escape closes the form and returns focus to "Open other…". A blank submission asks for the path to the episode folder. Errors appear under the field.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof OpenOther>;

export const Picker: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open other…" }));
    await expect(args.onChooseFolder).toHaveBeenCalledOnce();
  },
};
export const PathFallback: Story = {
  args: { mode: "path", path: "", defaultOpen: true },
};
export const PathError: Story = {
  args: {
    mode: "path",
    path: "/Users/maya/Podcast/notes",
    defaultOpen: true,
    error: NOT_AN_EPISODE,
  },
};
