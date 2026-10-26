import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useDawStore } from "../../state/dawStore";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { episode } from "../../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { StageFrame } from "../frame/StageFrame";
import { StageHost, type StageHostProps } from "./StageHost";

const meta: Meta<StageHostProps> = {
  title: "Stages/Deliver/Deliver",
  component: StageHost,
  beforeEach: episodeBeforeEach,
  render: ({ guestShare, loadFailure }) => (
    <StageFrame guestShare={guestShare} loadFailure={loadFailure}>
      <StageHost guestShare={guestShare} loadFailure={loadFailure} />
    </StageFrame>
  ),
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
    ...portaledOverlayParameters,
    viewport: { options: studioViewports },
    episode: { state: { stage: "deliver" } },
    docs: {
      description: {
        component:
          "The Deliver stage host: Readiness (what is still open, each with the fix), then Export, Bounce and Listen link entry points. The dialogs stay mounted in the app, so closing one returns here. Host only.\n\n**Motion.** None. A readiness row changes state in one frame when its cause is fixed.",
      },
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<StageHostProps>;

const phone = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
} as const;

const NO_TRACKS = episode({
  tracks: [],
  clips: { tracks: {}, clip_count: 0 },
  timeline_duration_sec: 0,
  transcript: { utterances: [] },
});

const FAILURE = { message: "The server did not answer.", onRetry: fn() };

export const Ready: Story = {
  parameters: {
    episode: {
      project: episode({
        comments: [],
        edit_impact: { ...episode().edit_impact, pending_review_count: 0 },
      }),
      state: { stage: "deliver" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Export" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Bounce…" })).toBeVisible();
  },
};

export const ItemsOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Decide" }),
    );
    await waitFor(() => expect(useDawStore.getState().stage).toBe("review"));
  },
};

export const Empty: Story = {
  parameters: { episode: { project: NO_TRACKS, state: { stage: "deliver" } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Export" }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { stage: "deliver", project: null } } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("main", { name: "Deliver" });
    await expect(
      canvasElement.querySelector(
        "[data-stage-host='deliver'][aria-busy='true']",
      ),
    ).not.toBeNull();
  },
};

export const LoadError: Story = {
  args: { loadFailure: FAILURE },
  parameters: { episode: { state: { stage: "deliver", project: null } } },
  play: async ({ args, canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>(
      "[data-stage-host='deliver']",
    );
    await userEvent.click(
      await within(host as HTMLElement).findByRole("button", { name: "Retry" }),
    );
    await expect(args.loadFailure?.onRetry).toHaveBeenCalledOnce();
  },
};

export const Phone: Story = {
  ...phone,
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Export" }),
    ).toBeVisible();
  },
};

export const GuestCommenter: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "commenter", state: { stage: "deliver" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("This link can't open that"),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Export" })).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Share a listen link" }),
    ).toBeNull();
  },
};
