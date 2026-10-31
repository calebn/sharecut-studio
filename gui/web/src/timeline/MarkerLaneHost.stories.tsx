import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { sampleComment } from "../test/fixtures";
import { MarkerLaneHost } from "./MarkerLaneHost";
import { timelineMarkerStoryDecorator } from "./timelineLaneStoryDecorator";

const meta: Meta<typeof MarkerLaneHost> = {
  title: "Templates/MarkerLaneHost",
  component: MarkerLaneHost,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    markerRows: {
      chapters: true,
      social: true,
      comments: true,
      clipping: true,
    },
  },
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
    zoomPxPerSec: 40,
    width: 640,
    showMarkers: true,
    showComments: true,
    readOnly: false,
    selected: [],
    duration: 30,
    onSelectChapter: fn(),
    onSelectSocial: fn(),
    onSelectComment: fn(),
    onSelectClipping: fn(),
    onMoveChapter: fn(),
    onMoveSocial: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof MarkerLaneHost>;

export const AllMarkers: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector(".sys-markers")).not.toBeNull();
    await expect(canvasElement.querySelectorAll(".marker-row")).toHaveLength(1);
    const button = canvas.getByRole("button", { name: /The signal/ });
    await userEvent.click(button);
    await expect(args.onSelectChapter).toHaveBeenCalledWith({
      time: 8,
      title: "The signal",
    });
    await userEvent.unhover(button);
  },
};

export const SelectedComment: Story = {
  args: { selected: ["cm-span"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: /^Comment by Mira/ });
    await expect(button).toHaveAttribute("aria-pressed", "true");
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".sys-markers")).toHaveAttribute(
      "data-readonly",
      "true",
    );
  },
};

export const Empty: Story = {
  args: {
    chapters: [],
    socialClips: [],
    comments: [],
    clippingFlags: [],
  },
  parameters: {
    markerRows: {
      chapters: false,
      social: false,
      comments: false,
      clipping: false,
    },
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
