import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useDawStore } from "../../state/dawStore";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { episode } from "../../test/episodeFixture";
import { recordSnapshot } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { StageFrame } from "../frame/StageFrame";
import { StageHost, type StageHostProps } from "./StageHost";

const meta: Meta<StageHostProps> = {
  title: "Stages/Record/Record",
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
    episode: { state: { stage: "record" } },
    docs: {
      description: {
        component:
          "The Record stage host: a launcher with the room status. The Record dialog stays mounted in the app, so a live take keeps running while another stage is up; the Player is hidden here.\n\n**Motion.** The live clock ticks once a second and is announced by the dialog, not here. Nothing else moves.",
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

export const Idle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "No take yet" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("group", { name: "Player" })).toBeNull();
    await userEvent.click(
      canvas.getByRole("button", { name: "Open the room" }),
    );
    await waitFor(() =>
      expect(useDawStore.getState().chrome.recordPanelOpen).toBe(true),
    );
  },
};

export const Live: Story = {
  parameters: {
    episode: {
      state: { stage: "record" },
      record: recordSnapshot({ state: "recording", recording_ms: 70_000 }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Recording" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Back to the room" }),
    ).toBeVisible();
  },
};

export const Paused: Story = {
  parameters: {
    episode: {
      state: { stage: "record" },
      record: recordSnapshot({ state: "paused", recording_ms: 70_000 }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "Paused" }),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  parameters: { episode: { project: NO_TRACKS, state: { stage: "record" } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Open the room",
      }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { stage: "record", project: null } } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("main", { name: "Record" });
    await expect(
      canvasElement.querySelector(
        "[data-stage-host='record'][aria-busy='true']",
      ),
    ).not.toBeNull();
  },
};

export const LoadError: Story = {
  args: { loadFailure: FAILURE },
  parameters: { episode: { state: { stage: "record", project: null } } },
  play: async ({ args, canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>(
      "[data-stage-host='record']",
    );
    await userEvent.click(
      await within(host as HTMLElement).findByRole("button", { name: "Retry" }),
    );
    await expect(args.loadFailure?.onRetry).toHaveBeenCalledOnce();
  },
};

export const PhoneLive: Story = {
  ...phone,
  parameters: {
    episode: {
      state: { stage: "record" },
      record: recordSnapshot({ state: "recording", recording_ms: 70_000 }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "Recording" }),
    ).toBeVisible();
  },
};

export const GuestViewer: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "viewer", state: { stage: "record" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("This link can't open that"),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Open the room" }),
    ).toBeNull();
  },
};
