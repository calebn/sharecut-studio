import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { GhostWordChips } from "./GhostWordChips";

const words = [
  { track_id: "guest", word_index: 12, text: "before", start: 6.2, end: 6.5 },
  { track_id: "guest", word_index: 13, text: "we", start: 6.5, end: 6.7 },
  { track_id: "guest", word_index: 14, text: "begin", start: 6.7, end: 7.1 },
];

const meta: Meta<typeof GhostWordChips> = {
  title: "Templates/GhostWordChips",
  component: GhostWordChips,
  tags: ["autodocs"],
  args: { words, label: "Preview restored words" },
};

export default meta;
type Story = StoryObj<typeof GhostWordChips>;

export const RestoredWords: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole("group", { name: "Preview restored words" });
    await expect(group.querySelectorAll(".edit-ghost-word")).toHaveLength(3);
    await expect(group).toHaveTextContent("beforewebegin");
  },
};

export const NoRestoredWords: Story = {
  args: { words: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("group")).toBeNull();
  },
};

export const MobileRestoredWords: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  args: {
    words: [
      ...words,
      {
        track_id: "guest",
        word_index: 15,
        text: "again",
        start: 7.1,
        end: 7.5,
      },
    ],
  },
};
