import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useDawStore } from "../../state/dawStore";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { episode } from "../../test/episodeFixture";
import { pipelineJobSnapshot } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { StageFrame } from "../frame/StageFrame";
import { StageHost, type StageHostProps } from "./StageHost";

const meta: Meta<StageHostProps> = {
  title: "Stages/Prepare/Host",
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
    episode: { state: { stage: "prepare" } },
    docs: {
      description: {
        component:
          "The Prepare stage host: Sources (Add audio, Record another session), Getting ready (the pipeline panel) and the hand-off to Review or Edit. Host only.\n\n**Motion.** None of its own. Processing progress comes from the pipeline panel and the Stage bar badge; the hand-off button changes label and weight in one frame.",
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

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Getting ready" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: /Add audio/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Record another session" }),
    ).toBeVisible();
  },
};

export const Running: Story = {
  parameters: {
    episode: {
      state: {
        stage: "prepare",
        pipelineJob: pipelineJobSnapshot({ status: "running" }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: /Review|Edit/ }),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  parameters: { episode: { project: NO_TRACKS, state: { stage: "prepare" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: /Drop audio files here/ }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("heading", { name: "Getting ready" }),
    ).toBeNull();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { stage: "prepare", project: null } } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("main", { name: "Prepare" });
    await expect(
      canvasElement.querySelector(
        "[data-stage-host='prepare'][aria-busy='true']",
      ),
    ).not.toBeNull();
  },
};

export const LoadError: Story = {
  args: { loadFailure: FAILURE },
  parameters: { episode: { state: { stage: "prepare", project: null } } },
  play: async ({ args, canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>(
      "[data-stage-host='prepare']",
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
      await within(canvasElement).findByRole("heading", {
        name: "Getting ready",
      }),
    ).toBeVisible();
  },
};

export const PhoneEmpty: Story = {
  ...phone,
  parameters: { episode: { project: NO_TRACKS, state: { stage: "prepare" } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: /Drop audio files here/,
      }),
    ).toBeVisible();
  },
};

export const GuestEditor: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "editor", state: { stage: "prepare" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("This link can't open that"),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: /Add audio/ }),
    ).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: /Go to/ }));
    await waitFor(() => expect(useDawStore.getState().stage).toBe("edit"));
  },
};
