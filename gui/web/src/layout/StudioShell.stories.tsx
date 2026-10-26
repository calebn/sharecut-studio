import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { episode } from "../test/episodeFixture";
import { withEpisode } from "../test/withEpisode";
import { StudioShell } from "./StudioShell";

const viewports = {
  desktop: {
    name: "Desktop 1440",
    styles: { width: "1440px", height: "900px" },
    type: "desktop",
  },
  tablet: {
    name: "Tablet 834",
    styles: { width: "834px", height: "1112px" },
    type: "tablet",
  },
  mobile360: {
    name: "Phone 360",
    styles: { width: "360px", height: "740px" },
    type: "mobile",
  },
} as const;

const meta: Meta<typeof StudioShell> = {
  title: "Templates/Shell",
  component: StudioShell,
  decorators: [
    withEpisode,
    (Story) => (
      <div data-daw-app-chrome>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    viewport: { options: viewports },
    episode: {},
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<typeof StudioShell>;

const mainLandmark = async (canvasElement: HTMLElement) =>
  within(canvasElement).findAllByRole("main");

export const Desktop: Story = {
  tags: ["wide-only"],
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("tab", { name: /Transcript/ }),
    ).toBeVisible();
  },
};

export const Tablet: Story = {
  globals: { viewport: { value: "tablet", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
  },
};

export const Phone360: Story = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { project: null } } },
  play: async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
  },
};

export const EmptyIngest: Story = {
  tags: ["wide-only"],
  parameters: {
    episode: {
      project: episode({
        tracks: [],
        clips: { tracks: {}, clip_count: 0 },
        timeline_duration_sec: 0,
        transcript: { utterances: [] },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: /Drop audio files here/,
      }),
    ).toBeVisible();
  },
};

export const LayoutTimeline: Story = {
  parameters: { episode: { state: { layoutMode: "timeline" } } },
  play: async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
  },
};

export const LayoutText: Story = {
  parameters: { episode: { state: { layoutMode: "text" } } },
  play: async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
  },
};

export const LayoutReview: Story = {
  parameters: { episode: { state: { layoutMode: "review" } } },
  play: async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
  },
};

const guestPlay: Story["play"] = async ({ canvasElement }) => {
  await expect(await mainLandmark(canvasElement)).toHaveLength(1);
};

export const Guest: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "commenter" } },
  play: guestPlay,
};

export const GuestViewer: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "viewer" } },
  play: guestPlay,
};

export const GuestEditor: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "editor" } },
  play: guestPlay,
};

const phone = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const PhoneListen: Story = {
  ...phone,
  parameters: { episode: { state: { mobileMode: "listen" } } },
  play: guestPlay,
};

export const PhoneTimeline: Story = {
  ...phone,
  parameters: { episode: { state: { mobileMode: "timeline" } } },
  play: guestPlay,
};

export const PhoneText: Story = {
  ...phone,
  parameters: { episode: { state: { mobileMode: "text" } } },
  play: guestPlay,
};

export const PhoneMore: Story = {
  ...phone,
  parameters: {
    episode: { state: { mobileMode: "more", moreDestination: "hub" } },
  },
  play: guestPlay,
};

export const PhoneComments: Story = {
  ...phone,
  parameters: {
    episode: { state: { mobileMode: "more", moreDestination: "comments" } },
  },
  play: guestPlay,
};

export const PhoneGuest: Story = {
  ...phone,
  args: { guestShare: true },
  parameters: {
    episode: { role: "commenter", state: { mobileMode: "listen" } },
  },
  play: guestPlay,
};
