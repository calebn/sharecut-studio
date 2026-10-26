import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { useDawStore } from "../state/dawStore";
import {
  studioViewports,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { episode } from "../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { StudioShell } from "./StudioShell";

const meta: Meta<typeof StudioShell> = {
  title: "Templates/Shell",
  component: StudioShell,
  beforeEach: episodeBeforeEach,
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
    viewport: { options: studioViewports },
    episode: {},
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<typeof StudioShell>;

const mainLandmark = (canvasElement: HTMLElement) =>
  within(canvasElement).findAllByRole("main");

type Play = NonNullable<Story["play"]>;

const singleMain: Play = async ({ canvasElement }) => {
  await expect(await mainLandmark(canvasElement)).toHaveLength(1);
};

/** The phone shell has no layout modes, so only the desktop shell carries the class. */
const layoutPlay =
  (mode: "timeline" | "text" | "review"): Play =>
  async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
    await expect(useDawStore.getState().layoutMode).toBe(mode);
    if (!canvasElement.querySelector(".daw-shell--phone"))
      await expect(canvasElement.querySelector(".daw-shell")).toHaveClass(
        `daw-shell--layout-${mode}`,
      );
  };

const guestPlay =
  (banner: string): Play =>
  async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
    await expect(await within(canvasElement).findByText(banner)).toBeVisible();
    await expect(
      canvasElement.querySelector(".daw-shell-guest"),
    ).not.toBeNull();
  };

const phonePlay =
  (mode: string, destination?: string): Play =>
  async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
    await expect(useDawStore.getState().mobileMode).toBe(mode);
    if (destination)
      await expect(useDawStore.getState().moreDestination).toBe(destination);
  };

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
  play: singleMain,
};

export const Phone360: Story = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: singleMain,
};

export const Loading: Story = {
  parameters: { episode: { state: { project: null } } },
  play: async ({ canvasElement }) => {
    await expect(await mainLandmark(canvasElement)).toHaveLength(1);
    await expect(
      (await within(canvasElement).findAllByText("Loading episode…")).length,
    ).toBeGreaterThan(0);
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
  play: layoutPlay("timeline"),
};

export const LayoutText: Story = {
  parameters: { episode: { state: { layoutMode: "text" } } },
  play: layoutPlay("text"),
};

export const LayoutReview: Story = {
  parameters: { episode: { state: { layoutMode: "review" } } },
  play: layoutPlay("review"),
};

export const Guest: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "commenter" } },
  play: guestPlay("Shared comment view · You can comment and suggest edits"),
};

export const GuestViewer: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "viewer" } },
  play: guestPlay("Shared read-only view"),
};

export const GuestEditor: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "editor" } },
  play: guestPlay("Shared edit view · You can add tracks and audio"),
};

const phone = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const PhoneListen: Story = {
  ...phone,
  parameters: { episode: { state: { mobileMode: "listen" } } },
  play: phonePlay("listen"),
};

export const PhoneTimeline: Story = {
  ...phone,
  parameters: { episode: { state: { mobileMode: "timeline" } } },
  play: phonePlay("timeline"),
};

export const PhoneText: Story = {
  ...phone,
  parameters: { episode: { state: { mobileMode: "text" } } },
  play: phonePlay("text"),
};

export const PhoneMore: Story = {
  ...phone,
  parameters: {
    episode: { state: { mobileMode: "more", moreDestination: "hub" } },
  },
  play: phonePlay("more", "hub"),
};

export const PhoneComments: Story = {
  ...phone,
  parameters: {
    episode: { state: { mobileMode: "more", moreDestination: "comments" } },
  },
  play: phonePlay("more", "comments"),
};

export const PhoneGuest: Story = {
  ...phone,
  args: { guestShare: true },
  parameters: {
    episode: { role: "commenter", state: { mobileMode: "listen" } },
  },
  play: async (context) => {
    await phonePlay("listen")(context);
    await guestPlay("Shared comment view · You can comment and suggest edits")(
      context,
    );
  },
};
