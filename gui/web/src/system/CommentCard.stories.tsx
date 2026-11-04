import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  COMMENT_WITH_ACTIONS,
  RESOLVED_COMMENT,
} from "../storybook/commentFixtures";
import {
  commentCardStoryMeta,
  storyParameters,
} from "../storybook/commentStoryMeta";
import { playInCanvas } from "../storybook/storyPlay";
import type { CommentCard } from "./CommentCard";

const meta = {
  ...commentCardStoryMeta,
  title: "System/CommentCard",
  parameters: storyParameters(
    "A comment as plain data: author, time in mono, body, replies and action items. Select jumps the playhead. Resolve hands the Undo toast to the caller. A callback left out removes its control: with no resolve and no toggles the action items are a plain list, and with no reply the card has no field. An unsent comment shows the queued clock, or Not sent with Try again and Remove when the server refused it. Replying reuses the Composer.\n\n**Motion.** Animations come later: a resolved card settles to its quiet line. A phone queue row swipes right for its verb, which resolves a comment; the card has no swipe of its own.",
  ),
} satisfies Meta<typeof CommentCard>;

export default meta;
type Story = StoryObj<typeof CommentCard>;

export const Open: Story = {
  play: playInCanvas(async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Rosa/ }));
    await expect(args.onSelect).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Resolve" }));
    await expect(args.onResolve).toHaveBeenCalledWith(true);
  }),
};

export const Selected: Story = { args: { selected: true } };

export const WithActions: Story = { args: { comment: COMMENT_WITH_ACTIONS } };

export const Replying: Story = {
  args: {
    comment: COMMENT_WITH_ACTIONS,
    reply: {
      body: "",
      onBodyChange: fn(),
      onSubmit: fn(),
    },
  },
};

export const Resolved: Story = { args: { comment: RESOLVED_COMMENT } };

export const Queued: Story = {
  args: { pending: { state: "queued" } },
};

export const Failed: Story = {
  args: {
    pending: { state: "failed", onRetry: fn(), onRemove: fn() },
  },
  play: playInCanvas(async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /^Try again/ }),
    );
    if (args.pending?.state !== "failed") throw new Error("expected failed");
    await expect(args.pending.onRetry).toHaveBeenCalled();
  }),
};

export const Commenter: Story = {
  args: {
    comment: COMMENT_WITH_ACTIONS,
    onResolve: undefined,
    onToggleAction: undefined,
    reply: { body: "", onBodyChange: fn(), onSubmit: fn() },
  },
};
