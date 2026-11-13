import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  type ReviewContent,
  ReviewQueue,
  type ReviewQueueProps,
} from "../../review/ReviewQueue";
import {
  attentionRowsOf,
  type ReviewAttention,
  type ReviewFilter,
  type ReviewItem,
} from "../../review/reviewQueueModel";
import { StageFrame } from "../../stage/frame/StageFrame";
import { StageHost } from "../../stage/hosts/StageHost";
import { reviewContent } from "../../storybook/reviewContent";
import {
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { SaveIndicator } from "../../system/SaveIndicator";
import { episode } from "../../test/episodeFixture";
import { offlineConflict } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { DocumentCommand } from "../../types/documentCommands.generated";
import { WORD_STARTS } from "./guestFixture";

/** Where the guest's cut sat: the first turn's 12:04. */
const CUT_START = WORD_STARTS[0] ?? 724;
const CUT_END = CUT_START + 2.6;

const COMMENT: ReviewItem = {
  id: "m1",
  kind: "comment",
  at: 702,
  savedSeconds: 0,
};
const SECOND_COMMENT: ReviewItem = { ...COMMENT, id: "m2", at: 760 };

/** The Rosa comment for both ids; `offline` draws the clock of a row not yet sent. */
const guestContent =
  (offline: boolean) =>
  (item: ReviewItem): ReviewContent => {
    const shown = reviewContent({ ...item, id: "m1" });
    return {
      ...shown,
      row: {
        ...shown.row,
        offline,
        unread: false,
        ...(item.id === "m2" ? { time: "12:40" } : {}),
      },
    };
  };

type GuestReviewProps = {
  save: Parameters<typeof SaveIndicator>[0];
  queue: Omit<
    ReviewQueueProps,
    "filter" | "selectedId" | "onFilter" | "onSelect"
  >;
};

function GuestReview({ save, queue }: GuestReviewProps) {
  const [filter, setFilter] = useState<ReviewFilter>("all");
  return (
    <div className="guest-review-story">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "var(--space-3) var(--space-4)",
        }}
      >
        <span>Guest review</span>
        <SaveIndicator {...save} />
      </div>
      <ReviewQueue
        {...queue}
        guest
        filter={filter}
        selectedId={null}
        onFilter={setFilter}
        onSelect={fn()}
      />
    </div>
  );
}

const attentionOf = (over: Partial<ReviewAttention> = {}): ReviewAttention => ({
  pending: 0,
  rows: [],
  unreadable: false,
  dismissFailed: false,
  checking: false,
  canDismiss: true,
  onDismissAll: fn(),
  onRetry: fn(),
  ...over,
});

/** The red "Couldn't reach the server" line and the beige "Needs attention" bar are gone. */
const expectNoBanner = async (canvas: HTMLElement) => {
  await expect(canvas.querySelector('[class*="banner"]')).toBeNull();
  await expect(within(canvas).queryByRole("alert")).toBeNull();
  await expect(within(canvas).queryByText(/reach the server/i)).toBeNull();
};

const suggestionActions = () => ({
  onHear: fn(),
  onSuggestAgain: fn(),
  onDrop: fn(),
});

const conflictRows = () =>
  attentionRowsOf(
    [
      offlineConflict({
        code: "range_changed",
        reason: "Selected audio changed. Select the range again.",
        command: {
          command_id: "guest-cut-1",
          type: DocumentCommand.EditSelectedRange,
          payload: {
            action: "cut",
            targets: [
              {
                intervals: [{ start: CUT_START, end: CUT_END }],
                track_ids: ["guest"],
                clips: [],
                media_seals: [],
              },
            ],
          },
        },
      }),
    ],
    true,
  );

const meta: Meta<GuestReviewProps> = {
  title: "Stages/Review/Guest",
  render: (props) => <GuestReview {...props} />,
  args: {
    save: { state: "saved" },
    queue: { items: [COMMENT], content: guestContent(false) },
  },
  parameters: {
    ...viewportStoryParameters,
    viewport: { options: studioViewports },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "A guest's review while offline and after reconnecting. The Save state dot carries the connection: a hollow cloud with a count while edits wait. Comments not yet sent show a clock and send by themselves on reconnect. A suggestion that no longer fits a newer host edit is a Status row in the queue with Hear, Suggest again here and Drop it. There is no banner.\n\n**Motion.** Animations come later: the clock leaving a sent row and a dropped row collapsing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<GuestReviewProps>;

export const Offline: Story = {
  args: {
    save: { state: "offline" },
    queue: { items: [COMMENT], content: guestContent(false) },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Offline")).toBeInTheDocument();
    await expectNoBanner(canvasElement);
  },
};

export const OfflineQueued: Story = {
  args: {
    save: { state: "offline", waiting: 2 },
    queue: {
      items: [COMMENT, SECOND_COMMENT],
      content: guestContent(true),
      attention: attentionOf({ pending: 2 }),
    },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("2 waiting")).toBeInTheDocument();
    await expect(view.getByText("2 edits waiting to send")).toBeInTheDocument();
    await expect(view.getAllByTitle("Waiting to send")).toHaveLength(2);
    await expectNoBanner(canvasElement);
  },
};

export const Conflict: Story = {
  args: {
    save: { state: "saved" },
    queue: {
      items: [COMMENT],
      content: guestContent(false),
      attention: attentionOf({
        rows: conflictRows(),
        suggestionActions: suggestionActions(),
      }),
    },
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("group", { name: "Needs attention. 1 conflict" }),
    ).toBeInTheDocument();
    await expect(
      view.getByText("Your cut at 12:04 overlaps a newer edit"),
    ).toBeInTheDocument();
    const hear = view.getByRole("button", { name: "Hear your cut at 12:04" });
    const again = view.getByRole("button", {
      name: "Suggest again here, your cut at 12:04",
    });
    const drop = view.getByRole("button", {
      name: "Drop it, your cut at 12:04",
    });
    view.getByRole("button", { name: "Dismiss all" }).focus();
    for (const button of [hear, again, drop]) {
      await userEvent.tab();
      await expect(button).toHaveFocus();
    }
    await expectNoBanner(canvasElement);
    await userEvent.click(drop);
    const actions = args.queue.attention?.suggestionActions;
    await expect(actions?.onDrop).toHaveBeenCalledOnce();
    await expect(actions?.onHear).not.toHaveBeenCalled();
    await expect(actions?.onSuggestAgain).not.toHaveBeenCalled();
  },
};

export const Reconnected: Story = {
  args: {
    save: { state: "saved", justSaved: true },
    queue: {
      items: [COMMENT, SECOND_COMMENT],
      content: guestContent(false),
      attention: attentionOf({
        rows: conflictRows(),
        suggestionActions: suggestionActions(),
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByTitle("Waiting to send")).toBeNull();
    await expect(view.queryByText(/waiting/)).toBeNull();
    await expect(
      view.getByRole("button", { name: "Hear your cut at 12:04" }),
    ).toBeInTheDocument();
    await expectNoBanner(canvasElement);
  },
};

const NAME_KEY = "podcast-mcp-guest-comment-name";
const HINT_KEY = "sharecut.roleHintSeen.commenter";

const phoneViewports = {
  ...studioViewports,
  phoneLandscape: {
    name: "Phone landscape 667",
    styles: { width: "667px", height: "375px" },
    type: "mobile",
  },
} as const;

function rememberLocal(key: string, value: string | null) {
  const previous = localStorage.getItem(key);
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  return () => {
    if (previous === null) localStorage.removeItem(key);
    else localStorage.setItem(key, previous);
  };
}

function PhoneShare({ guestShare }: { guestShare: boolean }) {
  return (
    <StageFrame guestShare={guestShare}>
      {(viewAnchor) => (
        <StageHost viewAnchor={viewAnchor} guestShare={guestShare} />
      )}
    </StageFrame>
  );
}

const phoneShare = (
  role: "commenter" | "viewer" | "editor",
  options: {
    viewport?: keyof typeof phoneViewports;
    project?: ReturnType<typeof episode>;
    beforeEach?: () => () => void;
  } = {},
): Story => ({
  render: () => <PhoneShare guestShare={role !== "editor"} />,
  beforeEach: options.beforeEach
    ? [episodeBeforeEach, options.beforeEach]
    : [episodeBeforeEach],
  decorators: [
    withEpisode,
    (Render) => (
      <div data-daw-app-chrome>
        <Render />
      </div>
    ),
  ],
  globals: {
    viewport: { value: options.viewport ?? "mobile390", isRotated: false },
  },
  parameters: {
    viewport: { options: phoneViewports },
    episode: {
      role,
      state: { stage: "review" },
      ...(options.project ? { project: options.project } : {}),
    },
  },
});

// jsdom has no media queries, so only a real phone viewport mounts the Listen layout.
const onPhone = (host: HTMLElement) =>
  host.querySelector(".stage-frame--phone") !== null;

const commentButton = (canvas: ReturnType<typeof within>) =>
  canvas.findByRole("button", { name: /^Comment at/ });

export const CommenterPhone: Story = {
  ...phoneShare("commenter", {
    beforeEach: () => rememberLocal(HINT_KEY, "1"),
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await expect(await commentButton(canvas)).toBeVisible();
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(
      canvas.getByRole("slider", { name: "Episode overview" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: /^Show comments/ }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(
      canvasElement.ownerDocument.documentElement.scrollWidth,
    ).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const CommenterPhoneComposing: Story = {
  ...phoneShare("commenter", {
    beforeEach: () => {
      const hint = rememberLocal(HINT_KEY, "1");
      const name = rememberLocal(NAME_KEY, "Maya");
      return () => {
        hint();
        name();
      };
    },
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await userEvent.click(await commentButton(canvas));
    const field = await canvas.findByRole("textbox", { name: "Comment" });
    await expect(field).toHaveFocus();
    await expect(
      canvas.queryByRole("textbox", { name: "Your name" }),
    ).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(canvas.queryByRole("textbox", { name: "Comment" })).toBeNull(),
    );
    await expect(await commentButton(canvas)).toHaveFocus();
  },
};

export const CommenterPhoneFirstComment: Story = {
  ...phoneShare("commenter", {
    beforeEach: () => {
      const hint = rememberLocal(HINT_KEY, "1");
      const name = rememberLocal(NAME_KEY, null);
      return () => {
        hint();
        name();
      };
    },
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await expect(
      canvas.queryByRole("textbox", { name: "Your name" }),
    ).toBeNull();
    await userEvent.click(await commentButton(canvas));
    await expect(
      await canvas.findByRole("textbox", { name: "Your name" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("textbox", { name: "Comment" }),
    ).toHaveFocus();
  },
};

export const CommenterPhoneComments: Story = {
  ...phoneShare("commenter", {
    beforeEach: () => rememberLocal(HINT_KEY, "1"),
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await userEvent.click(
      await canvas.findByRole("button", { name: /^Show comments/ }),
    );
    const sheet = await within(canvasElement.ownerDocument.body).findByRole(
      "dialog",
      { name: "Comments" },
    );
    await expect(sheet).toBeVisible();
    await expect(
      within(sheet).getByRole("region", { name: "Review queue" }),
    ).toBeVisible();
  },
};

/** Pick the Phone landscape 667 viewport to see the dock fold to one row under the scrubber. */
export const CommenterPhoneFolded: Story = {
  ...phoneShare("commenter", {
    viewport: "phoneLandscape",
    beforeEach: () => rememberLocal(HINT_KEY, "1"),
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await expect(
      await canvas.findByRole("slider", { name: "Episode overview" }),
    ).toBeVisible();
    await expect(await commentButton(canvas)).toBeVisible();
  },
};

export const ViewerPhone: Story = {
  ...phoneShare("viewer"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await expect(
      await canvas.findByRole("slider", { name: "Episode overview" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: /^Comment at/ }),
    ).toBeNull();
    await expect(canvas.getByRole("button", { name: "Play" })).toBeVisible();
  },
};

export const EditorPhone: Story = {
  ...phoneShare("editor"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await expect(
      await canvas.findByRole("group", { name: "Player" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Comment" }));
    await expect(
      await canvas.findByRole("textbox", { name: "Comment" }),
    ).toHaveFocus();
  },
};

export const FirstVisitRoleHint: Story = {
  ...phoneShare("commenter", {
    beforeEach: () => rememberLocal(HINT_KEY, null),
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    const note = await canvas.findByRole("note");
    await expect(note).toHaveTextContent(
      "You can comment and suggest cuts. The host decides.",
    );
    await expect(
      canvas.getByRole("img", { name: "Commenter: can comment" }),
    ).toBeVisible();
    const comment = await commentButton(canvas);
    const row = canvas.getByRole("button", { name: /^Show comments/ });
    await waitFor(async () => {
      const bubble = note.getBoundingClientRect();
      await expect(bubble.left).toBeGreaterThanOrEqual(0);
      await expect(bubble.right).toBeLessThanOrEqual(window.innerWidth);
      for (const covered of [comment, row])
        await expect(bubble.bottom).toBeLessThanOrEqual(
          covered.getBoundingClientRect().top,
        );
    });
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss hint" }));
    await expect(canvas.queryByRole("note")).toBeNull();
  },
};
