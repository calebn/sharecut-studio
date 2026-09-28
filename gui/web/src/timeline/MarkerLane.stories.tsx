import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { sampleComment } from "../test/fixtures";
import { MarkerLaneView } from "./MarkerLaneView";
import { timelineMarkerStoryDecorator } from "./timelineLaneStoryDecorator";

const ALL_ROWS = {
  chapters: true,
  social: true,
  comments: true,
  clipping: true,
};

const meta: Meta<typeof MarkerLaneView> = {
  title: "Templates/MarkerLane",
  component: MarkerLaneView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [timelineMarkerStoryDecorator],
  args: {
    chapters: [
      { time: 1, title: "Cold open" },
      { time: 8, title: "The signal" },
    ],
    socialClips: [
      {
        id: "social-1",
        track_id: "mira-voice",
        start: 3,
        end: 6,
        score: 0.82,
        title_suggestion: "Why the signal mattered",
        approved: false,
        review_required: true,
      },
    ],
    comments: [
      sampleComment({ id: "cm-pin", author: "Ari", timeline_start: 4 }),
      sampleComment({
        id: "cm-span",
        author: "Mira",
        timeline_start: 10,
        timeline_end: 13,
        action_items: [
          {
            id: "a1",
            text: "Trim",
            done: false,
            completed_at: null,
            completed_by: null,
          },
        ],
      }),
    ],
    clippingFlags: [
      {
        id: "clip-flag-1",
        trackId: "mira-voice",
        label: "Mira",
        start: 11.5,
        end: 11.8,
      },
    ],
    rows: ALL_ROWS,
    zoomPxPerSec: 40,
    width: 640,
    editable: true,
    selectedCommentId: null,
    onSelectChapter: fn(),
    onSelectSocial: fn(),
    onSelectComment: fn(),
    onSelectClipping: fn(),
    onMoveChapter: fn(),
    onMoveSocial: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof MarkerLaneView>;

export const AllRows: Story = {
  play: async ({ canvasElement, args }) => {
    await expect(canvasElement.querySelectorAll(".marker-row")).toHaveLength(4);
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", {
      name: "Chapter The signal",
    });
    await userEvent.click(button);
    await expect(args.onSelectChapter).toHaveBeenCalled();
  },
};

export const SelectedComment: Story = {
  args: { selectedCommentId: "cm-span" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Comment by Mira" });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toHaveClass("span");
  },
};

export const ReadOnly: Story = {
  args: { editable: false },
  play: async ({ canvasElement }) => {
    const chapter = canvasElement.querySelector(
      ".chapter-marker",
    ) as HTMLElement;
    await expect(chapter).toHaveStyle({ cursor: "pointer" });
  },
};

export const Empty: Story = {
  args: {
    rows: { chapters: false, social: false, comments: false, clipping: false },
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".marker-lane.empty"),
    ).not.toBeNull();
    await expect(canvasElement.querySelector(".marker-row")).toBeNull();
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { width: 360, zoomPxPerSec: 24 },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".marker-lane")).toHaveStyle({
      width: "360px",
    });
  },
};
