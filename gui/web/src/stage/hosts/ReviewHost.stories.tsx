import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { applyDocumentSnapshot } from "../../document/applyDocumentUpdate";
import {
  documentScope,
  resetDocumentAuthority,
} from "../../document/authorityState";
import { reviewApiBase } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { episode, selections } from "../../test/episodeFixture";
import { pipelineJobSnapshot } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { StageFrame } from "../frame/StageFrame";
import { StageHost, type StageHostProps } from "./StageHost";

const meta: Meta<StageHostProps> = {
  title: "Stages/Review/Host",
  component: StageHost,
  beforeEach: episodeBeforeEach,
  render: ({ guestShare, loadFailure }) => (
    <StageFrame guestShare={guestShare}>
      {(viewAnchor) => (
        <>
          <StageHost
            viewAnchor={viewAnchor}
            guestShare={guestShare}
            loadFailure={loadFailure}
          />
        </>
      )}
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
      within(canvasElement).getByRole("region", { name: "Queue" }),
    ).toBeVisible();
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
    await expect(
      await within(host as HTMLElement).findByRole("heading", {
        name: "The transcript didn't load",
      }),
    ).toBeVisible();
    await userEvent.click(
      await within(host as HTMLElement).findByRole("button", {
        name: "Try again",
      }),
    );
    await expect(args.loadFailure?.onRetry).toHaveBeenCalledOnce();
  },
};

export const LoadRetrying: Story = {
  args: {
    loadFailure: { ...FAILURE, message: "Trying again…", recovering: true },
  },
  parameters: { episode: { state: { stage: "review", project: null } } },
  play: async ({ canvasElement }) => {
    const retry = await within(canvasElement).findByRole("button", {
      name: "Try again",
    });
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toHaveAttribute("aria-disabled", "true");
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

const asGuest = (role: "commenter" | "viewer", episodeState: object = {}) => ({
  args: { guestShare: true },
  parameters: {
    episode: { role, state: { stage: "review" }, ...episodeState },
  },
});

const NO_COMMENTS = episode({ comments: [] });
const TRANSCRIPT_WORDS_PENDING = episode({
  meta: {
    name: "After Hours Almanac 12",
    workspace_dir: "/episodes/after-hours",
    hydration: { transcript_words: false },
  },
});

const DETAIL_TOKEN = "b".repeat(64);
const DETAIL_ROUTE = `${reviewApiBase("episode")}/daw/document/state`;

function startDetailRequest() {
  const project = useDawStore.getState().project;
  if (!project) throw new Error("The guest project should be hydrated");
  resetDocumentAuthority(useDawStore.getState().projectPath);
  applyDocumentSnapshot(
    { server_seq: 0, state_token: DETAIL_TOKEN, project },
    { scope: documentScope() },
  );
}

// jsdom has no media queries, so only a real phone viewport mounts the Listen layout.
const onPhone = (host: HTMLElement) =>
  host.querySelector(".stage-frame--phone") !== null;

const commentControl = (
  canvas: ReturnType<typeof within>,
  host: HTMLElement,
) =>
  onPhone(host)
    ? canvas.findByRole("button", { name: /^Comment at/ })
    : canvas.findByRole("textbox", { name: "Comment" });

const listenSurface = async (
  canvas: ReturnType<typeof within>,
  host: HTMLElement,
) =>
  onPhone(host)
    ? canvas.findByRole("slider", { name: "Episode overview" })
    : (await canvas.findAllByRole("region", { name: "Queue" }))[0];

const noDecisions = async (canvas: ReturnType<typeof within>) => {
  await expect(
    await canvas.findByRole("region", { name: "Queue" }),
  ).toBeVisible();
  for (const name of [/^Cut/, /^Keep/, /Find more/, /Deliver/, /Resolve/])
    await expect(canvas.queryByRole("button", { name })).toBeNull();
};

const WIDE_ONLY_REASON =
  "The guest Queue column and the always-open comment field exist on a tablet or desktop; a 360 px viewport selects the phone Listen layout (Stages/Review/Guest).";

const wideGuest = (role: "commenter" | "viewer", episodeState: object = {}) => {
  const base = asGuest(role, episodeState);
  return {
    ...base,
    parameters: { ...base.parameters, wideOnlyReason: WIDE_ONLY_REASON },
  };
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
  ...wideGuest("commenter"),
  tags: ["wide-only"],
  play: commenterPlay,
};

export const GuestCommenterTranscriptPending: Story = {
  ...phone,
  ...asGuest("commenter", {
    project: TRANSCRIPT_WORDS_PENDING,
    hang: [DETAIL_ROUTE],
  }),
  beforeEach: () => () => resetDocumentAuthority(),
  play: async ({ canvasElement }) => {
    startDetailRequest();
    const canvas = within(canvasElement);
    await expect(await listenSurface(canvas, canvasElement)).toBeVisible();
    await expect(await commentControl(canvas, canvasElement)).toBeEnabled();
    await expect(
      canvasElement.querySelector(".sys-skeleton[aria-busy='true']"),
    ).not.toBeNull();
    await expect(
      canvas.queryByText("The host has not made a transcript of this version."),
    ).toBeNull();
    const retry = await canvas.findByRole(
      "button",
      { name: "Retry" },
      { timeout: 6_000 },
    );
    await userEvent.click(retry);
    await expect(
      canvasElement.querySelector(".sys-skeleton[aria-busy='true']"),
    ).not.toBeNull();
    await expect(await commentControl(canvas, canvasElement)).toBeEnabled();
  },
};

export const GuestCommenterTranscriptFailure: Story = {
  ...phone,
  ...asGuest("commenter", {
    project: TRANSCRIPT_WORDS_PENDING,
    responses: { [DETAIL_ROUTE]: { server_seq: 0 } },
  }),
  beforeEach: () => () => resetDocumentAuthority(),
  play: async ({ canvasElement }) => {
    startDetailRequest();
    const canvas = within(canvasElement);
    const heading = await canvas.findByRole("heading", {
      name: "The transcript didn't load",
    });
    const alert = heading.closest<HTMLElement>('[role="alert"]');
    if (!alert) throw new Error("The transcript failure should be an alert");
    await expect(
      within(alert).getByRole("heading", {
        name: "The transcript didn't load",
      }),
    ).toBeVisible();
    await expect(
      within(alert).getByText("Try again in a moment."),
    ).toBeVisible();
    await expect(
      within(alert).queryByText(/server_seq|Invalid document basis/),
    ).toBeNull();
    await expect(await listenSurface(canvas, canvasElement)).toBeVisible();
    await expect(await commentControl(canvas, canvasElement)).toBeEnabled();
    const retry = within(alert).getByRole("button", { name: "Try again" });
    await userEvent.click(retry);
    await expect(retry).toHaveFocus();
    await expect(
      within(alert).getByRole("heading", {
        name: "The transcript didn't load",
      }),
    ).toBeVisible();
    await expect(await listenSurface(canvas, canvasElement)).toBeVisible();
    await expect(await commentControl(canvas, canvasElement)).toBeEnabled();
  },
};

export const GuestViewerTranscriptWordsUnavailable: Story = {
  ...phone,
  ...asGuest("viewer", {
    project: TRANSCRIPT_WORDS_PENDING,
    state: { stage: "review", shareTranscriptWords: false },
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await listenSurface(canvas, canvasElement)).toBeVisible();
    await expect(
      canvasElement.querySelector(".sys-skeleton[aria-busy='true']"),
    ).toBeNull();
    await expect(
      canvas.queryByText("The host has not made a transcript of this version."),
    ).toBeNull();
    await expect(canvas.queryByRole("textbox", { name: "Comment" })).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: /^Comment at/ }),
    ).toBeNull();
  },
};

export const GuestCommenterEmpty: Story = {
  ...phone,
  ...asGuest("commenter", { project: NO_COMMENTS }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await commentControl(canvas, canvasElement)).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: /^Show\b.*\bcomments?/ }),
    ).toBeNull();
    if (!onPhone(canvasElement))
      await expect(
        (await canvas.findAllByText(/^(No comments( yet)?|0 comments)$/))[0],
      ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Deliver/ })).toBeNull();
  },
};

const viewerPlay: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await noDecisions(canvas);
  await expect(canvas.queryByRole("textbox", { name: "Comment" })).toBeNull();
  await expect(canvas.queryByRole("button", { name: "Comment" })).toBeNull();
};

export const GuestViewer: Story = {
  ...wideGuest("viewer"),
  tags: ["wide-only"],
  play: viewerPlay,
};

export const GuestViewerReadsTranscript: Story = {
  ...asGuest("viewer"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const script = canvasElement.querySelector(".stage-host-guest-script");
    await expect(script).not.toBeNull();
    await expect(
      within(script as HTMLElement).getByText("Read only"),
    ).toBeVisible();
    await expect(canvas.queryByRole("textbox", { name: "Comment" })).toBeNull();
    await expect(
      canvasElement.querySelector(".sys-script-word[data-selected]"),
    ).toBeNull();
  },
};

const cardPlay =
  (commenter: boolean): Story["play"] =>
  async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(".sys-player--expanded"),
      ).toHaveLength(1),
    );
    // One Player: the bar is not mounted beside the card.
    await expect(canvas.queryByRole("group", { name: "Player" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(canvas.getByLabelText(/^Episode overview/)).toBeVisible();
    const script = canvasElement.querySelector(".stage-host-guest-script");
    await expect(script).not.toBeNull();
    if (commenter) {
      const field = await canvas.findByRole("textbox", { name: "Comment" });
      await expect(
        field.compareDocumentPosition(script as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  };

/** Wide guest Review: the one expanded Player first in the center column, then the composer, then the transcript. */
export const GuestCommenterPlayerCard: Story = {
  ...wideGuest("commenter"),
  tags: ["wide-only"],
  play: cardPlay(true),
};

export const GuestViewerPlayerCard: Story = {
  ...wideGuest("viewer"),
  tags: ["wide-only"],
  play: cardPlay(false),
};

const selectionBarPlay: Story["play"] = async ({ canvasElement }) => {
  // The bar floats only while the selected word is on screen.
  const word = await waitFor(() => {
    const found = canvasElement.querySelector<HTMLElement>(
      ".sys-script-word[data-selected]",
    );
    if (!found) throw new Error("No selected word yet");
    return found;
  });
  if (typeof word.scrollIntoView === "function")
    word.scrollIntoView({ block: "center" });
  const bar = await within(canvasElement).findByRole("group", {
    name: "Selection actions",
  });
  await expect(
    within(bar).getByRole("button", { name: "Comment" }),
  ).toBeVisible();
  await expect(
    within(bar).getByRole("button", { name: "Suggest a cut" }),
  ).toBeVisible();
  // Inside the viewport on both sides, and clear of the selected word.
  await waitFor(async () => {
    const box = bar.getBoundingClientRect();
    const sel = word.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(0);
    await expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    await expect(
      box.bottom <= sel.top ||
        box.top >= sel.bottom ||
        box.right <= sel.left ||
        box.left >= sel.right,
    ).toBe(true);
  });
  if (window.matchMedia?.("(pointer: coarse)")?.matches) {
    const min = Number.parseFloat(
      getComputedStyle(bar).getPropertyValue("--touch-min"),
    );
    const rem = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    for (const button of within(bar).getAllByRole("button")) {
      const rect = button.getBoundingClientRect();
      await expect(rect.width).toBeGreaterThanOrEqual(min * rem - 0.5);
      await expect(rect.height).toBeGreaterThanOrEqual(min * rem - 0.5);
    }
  }
};

/** A word selection in the guest transcript floats Comment and Suggest a cut. */
export const GuestCommenterSelection: Story = {
  ...wideGuest("commenter", { selection: selections.range }),
  tags: ["wide-only"],
  play: selectionBarPlay,
};

/** The transcript failed to load: its region says so; the queue, composer and Player stay usable. */
export const GuestRegionFailure: Story = {
  ...wideGuest("commenter"),
  tags: ["wide-only"],
  args: { guestShare: true, loadFailure: FAILURE },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: "The transcript didn't load",
      }),
    ).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Queue" })).toBeVisible();
    await expect(
      canvas.getByRole("textbox", { name: "Comment" }),
    ).toBeEnabled();
    await expect(
      canvasElement.querySelector(".sys-player--expanded"),
    ).not.toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.loadFailure?.onRetry).toHaveBeenCalledOnce();
  },
};
