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
  title: "Stages/Review/Host",
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
    episode: { state: { stage: "review" } },
    docs: {
      description: {
        component:
          "The Review stage host: Queue, Comments and Tighten as sections of one stage, with the open section kept in the stage slice. A Viewer or Commenter link gets Comments only and no Stage bar.\n\n**Motion.** Switching section swaps the panel in one frame. The saved scroll position of each section returns when it is reopened.",
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

const FAILURE = { message: "The server did not answer.", onRetry: fn() };

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("tablist", { name: "Review sections" }),
    ).toBeVisible();
    await expect(
      canvas.getAllByRole("tab", { name: /Queue|Comments|Tighten/ }).length,
    ).toBeGreaterThanOrEqual(3);
  },
};

const queuePlay: Story["play"] = async ({ canvasElement }) => {
  await waitFor(() =>
    expect(canvasElement.querySelector(".sys-queue-main")).not.toBeNull(),
  );
  await expect(canvasElement.querySelector(".rv-stage")).not.toBeNull();
};

export const Queue: Story = { play: queuePlay };

export const QueuePhone: Story = { ...phone, play: queuePlay };

const running = (state: object) => ({
  episode: { state: { stage: "review", ...state } },
});

export const FindMore: Story = {
  parameters: running({
    pipelineJob: pipelineJobSnapshot({ id: "find", current: 2, total: 5 }),
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Finding suggestions")).toBeVisible();
    await expect(canvas.getByText("40%")).toBeVisible();
  },
};

export const FindMoreBusy: Story = {
  parameters: running({
    pipelineJob: pipelineJobSnapshot({ id: "bounce", kind: "export" }),
  }),
  play: async ({ canvasElement }) => {
    const find = await within(canvasElement).findByRole("button", {
      name: "Find more",
    });
    await expect(find).toBeDisabled();
    await expect(find).toHaveAttribute(
      "title",
      "Wait for the current action to finish.",
    );
  },
};

const unsureWordsPlay: Story["play"] = async ({ canvasElement }) => {
  const group = await within(canvasElement).findByRole("region", {
    name: "Unsure words",
  });
  await expect(within(group).getAllByRole("button").length).toBeGreaterThan(0);
};

export const UnsureWords: Story = { play: unsureWordsPlay };

export const UnsureWordsPhone: Story = { ...phone, play: unsureWordsPlay };

export const SwitchSection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("tab", { name: /Queue/ }));
    await waitFor(() =>
      expect(useDawStore.getState().reviewSection).toBe("queue"),
    );
  },
};

export const Empty: Story = {
  parameters: {
    episode: {
      project: episode({
        comments: [],
        edit_impact: { ...episode().edit_impact, pending_review_count: 0 },
      }),
      state: { stage: "review" },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("tablist", {
        name: "Review sections",
      }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { stage: "review", project: null } } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("main", { name: "Review" });
    await expect(
      canvasElement.querySelector(
        "[data-stage-host='review'][aria-busy='true']",
      ),
    ).not.toBeNull();
  },
};

export const LoadError: Story = {
  args: { loadFailure: FAILURE },
  parameters: { episode: { state: { stage: "review", project: null } } },
  play: async ({ args, canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>(
      "[data-stage-host='review']",
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
      await within(canvasElement).findByRole("tablist", {
        name: "Review sections",
      }),
    ).toBeVisible();
  },
};

export const PhoneGuestCommenter: Story = {
  ...phone,
  args: { guestShare: true },
  parameters: { episode: { role: "commenter", state: { stage: "review" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("region", { name: "Comments" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("tablist", { name: "Review sections" }),
    ).toBeNull();
  },
};

export const GuestViewer: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "viewer", state: { stage: "review" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("region", { name: "Comments" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Deliver" })).toBeNull();
    await expect(
      canvas.queryByRole("tab", { name: /Tighten|Queue/ }),
    ).toBeNull();
  },
};
