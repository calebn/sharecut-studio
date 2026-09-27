import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { sampleComment } from "../test/fixtures";
import { CommentPlaybackBubbleView } from "./CommentPlaybackBubbleView";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const comment = sampleComment({
  id: "a",
  author: "caleb",
  body: "Tighten this open",
  timeline_start: 6,
});

const meta: Meta<typeof CommentPlaybackBubbleView> = {
  title: "Templates/CommentPlaybackBubble",
  component: CommentPlaybackBubbleView,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    lanePreviewLabel: "Comment playback bubble preview",
  },
  decorators: [timelineLaneStoryDecorator],
  args: {
    comment,
    zoomPxPerSec: 10,
    onSelect: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof CommentPlaybackBubbleView>;

export const Playing: Story = {
  play: async ({ canvasElement, args }) => {
    const button = canvasElement.querySelector(
      ".comment-playback-bubble",
    ) as HTMLElement;
    await expect(button).toHaveStyle({ left: "60px" });
    button.click();
    await expect(args.onSelect).toHaveBeenCalledWith(comment);
  },
};

export const LongBody: Story = {
  args: {
    comment: sampleComment({
      id: "long",
      author: "caleb",
      body: "x".repeat(120),
      timeline_start: 0,
    }),
  },
  play: async ({ canvasElement }) => {
    const body = canvasElement.querySelector(".comment-playback-bubble-body");
    await expect(body?.textContent).toBe(`${"x".repeat(79)}…`);
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".lane-row")).toHaveStyle({
      width: "360px",
    });
  },
};

export const NoActiveComment: Story = {
  args: { comment: null },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".comment-playback-bubble"),
    ).toBeNull();
  },
};
