import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { EmptySessionView } from "./EmptySessionView";

const meta: Meta<typeof EmptySessionView> = {
  title: "Stages/Edit/EmptySession",
  component: EmptySessionView,
  tags: ["autodocs"],
  args: {
    over: false,
    fileCount: 1,
    onDragOver: fn(),
    onDragLeave: fn(),
    onDrop: fn(),
    onImport: fn(),
    onRecord: fn(),
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "An episode with no tracks shows the two Start tiles (160 by 96) on the timeline well. Audio dropped anywhere on the well becomes new tracks. One file per speaker is taught by the result, not by a paragraph here.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ display: "flex", blockSize: "24rem" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof EmptySessionView>;

export const Rest: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /^Import audio/ }),
    );
    await expect(args.onImport).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: /^Record/ }));
    await expect(args.onRecord).toHaveBeenCalledOnce();
  },
};

export const DragHover: Story = { args: { over: true, fileCount: 3 } };
