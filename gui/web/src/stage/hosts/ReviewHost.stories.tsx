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
          "The Review stage host: the Queue, where comments are items next to suggestions and checks, and the comment field opens above the card for a host. A Viewer or Commenter link gets the same Queue as a reader, with comments only and no Stage bar: a Commenter has the comment field, a Viewer has none.\n\n**Motion.** Selecting a comment swaps the card in one frame. The comment field opens with focus and closes on Escape.",
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
    await waitFor(() =>
      expect(canvasElement.querySelector(".rv-stage")).not.toBeNull(),
    );
    await expect(
      within(canvasElement).queryByRole("tablist", {
        name: "Review sections",
      }),
    ).toBeNull();
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

const OPEN_COMMENT = { kind: "comment", id: "comment-1" } as const;

const commentThreadPlay: Story["play"] = async ({ canvasElement }) => {
  const title = await within(canvasElement).findByRole("heading", {
    name: "Comment from Ines",
  });
  const card = title.closest("article") as HTMLElement;
  await expect(title).toBeVisible();
  await expect(within(card).getByText("Looking at it now.")).toBeVisible();
  await expect(
    within(card).getByRole("checkbox", { name: "Review the cut" }),
  ).toBeVisible();
  await expect(
    within(card).getByRole("textbox", { name: "Reply to Ines" }),
  ).toBeVisible();
  await expect(
    within(card).getByRole("button", { name: "Resolve" }),
  ).toBeEnabled();
};

export const CommentThread: Story = {
  parameters: {
    episode: { state: { stage: "review" }, selection: OPEN_COMMENT },
  },
  play: commentThreadPlay,
};

export const CommentThreadPhone: Story = {
  ...phone,
  parameters: {
    episode: { state: { stage: "review" }, selection: OPEN_COMMENT },
  },
  play: commentThreadPlay,
};

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

export const StaleCommentsSection: Story = {
  parameters: running({ reviewSection: "comments" }),
  play: queuePlay,
};

const composingPlay: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const field = await canvas.findByRole("textbox", { name: "Comment" });
  await waitFor(() => expect(field).toHaveFocus());
  await expect(canvas.getByText("0:40")).toBeVisible();
  await userEvent.type(field, "Trim this{Escape}");
  await waitFor(() =>
    expect(canvas.queryByRole("textbox", { name: "Comment" })).toBeNull(),
  );
  await expect(useDawStore.getState().commentDraft).toBeNull();
};

const composing = running({ commentDraft: { startSec: 40.2, endSec: null } });

export const Composing: Story = {
  parameters: composing,
  play: composingPlay,
};

export const ComposingPhone: Story = {
  ...phone,
  parameters: composing,
  play: composingPlay,
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
    await waitFor(() =>
      expect(canvasElement.querySelector(".rv-stage")).not.toBeNull(),
    );
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
    await waitFor(() =>
      expect(canvasElement.querySelector(".rv-stage")).not.toBeNull(),
    );
  },
};

const phone390 = {
  globals: { viewport: { value: "mobile390", isRotated: false } },
} as const;

const asGuest = (role: "commenter" | "viewer", episodeState: object = {}) => ({
  args: { guestShare: true },
  parameters: {
    episode: { role, state: { stage: "review" }, ...episodeState },
  },
});

const NO_COMMENTS = episode({ comments: [] });

const noDecisions = async (canvas: ReturnType<typeof within>) => {
  await expect(
    await canvas.findByRole("region", { name: "Queue" }),
  ).toBeVisible();
  await expect(
    canvas.queryByRole("tablist", { name: "Review sections" }),
  ).toBeNull();
  for (const name of [/^Cut/, /^Keep/, /Find more/, /Deliver/, /Resolve/])
    await expect(canvas.queryByRole("button", { name })).toBeNull();
};

const commenterPlay: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await noDecisions(canvas);
  await expect(
    await canvas.findByRole("textbox", { name: "Comment" }),
  ).toBeVisible();
  await expect(
    canvas.getByRole("textbox", { name: "Your name" }),
  ).toBeVisible();
};

export const GuestCommenter: Story = {
  ...asGuest("commenter"),
  play: commenterPlay,
};

export const GuestCommenterPhone: Story = {
  ...phone,
  ...asGuest("commenter"),
  play: commenterPlay,
};

export const GuestCommenterPhone390: Story = {
  ...phone390,
  ...asGuest("commenter"),
  play: commenterPlay,
};

export const GuestCommenterEmpty: Story = {
  ...phone,
  ...asGuest("commenter", { project: NO_COMMENTS }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (await canvas.findAllByText("No comments yet"))[0],
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Deliver/ })).toBeNull();
    await expect(
      canvas.getByRole("textbox", { name: "Comment" }),
    ).toBeVisible();
  },
};

const viewerPlay: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await noDecisions(canvas);
  await expect(canvas.queryByRole("textbox", { name: "Comment" })).toBeNull();
  await expect(canvas.queryByRole("button", { name: "Comment" })).toBeNull();
};

export const GuestViewer: Story = {
  ...asGuest("viewer"),
  play: viewerPlay,
};

export const GuestViewerPhone: Story = {
  ...phone,
  ...asGuest("viewer"),
  play: viewerPlay,
};
