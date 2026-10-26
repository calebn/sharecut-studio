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
    onSwitchWindow: fn(),
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
          '"Open other…" at the end of the Recent heading. With an OS picker it opens the picker in folder mode. In a plain browser it opens a popover under the button with one path field ("Folder of the episode") and an Open button; Enter submits. Errors sit under the field in plain words with the fix. An episode another window has open says so and offers "Switch to it".\n\n**Motion.** The popover appears with `--motion-hover`. Not implemented in this slice.',
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
export const AlreadyOpen: Story = {
  args: {
    mode: "path",
    path: "/Users/maya/ShareCut/rosa",
    defaultOpen: true,
    alreadyOpen: true,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Switch to it" }));
    await expect(args.onSwitchWindow).toHaveBeenCalledOnce();
  },
};
