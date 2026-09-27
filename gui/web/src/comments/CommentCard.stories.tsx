import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { sampleComment } from "../test/fixtures";
import { CommentCard } from "./CommentCard";

type Args = Parameters<typeof CommentCard>[0];

function CardHarness(args: Args) {
  const [comment, setComment] = useState(args.comment);
  const [replyDraft, setReplyDraft] = useState(args.replyDraft ?? "");
  const [selected, setSelected] = useState(args.selected ?? false);
  return (
    <div className="comments-panel">
      <ul className="comments-list">
        <CommentCard
          {...args}
          comment={comment}
          selected={selected}
          replyDraft={replyDraft}
          onSelect={
            args.onSelect
              ? () => {
                  setSelected((value) => !value);
                  args.onSelect?.();
                }
              : undefined
          }
          onReplyDraftChange={
            args.onReplyDraftChange
              ? (value) => {
                  setReplyDraft(value);
                  args.onReplyDraftChange?.(value);
                }
              : undefined
          }
          onReply={
            args.onReply
              ? () => {
                  const body = replyDraft.trim();
                  if (!body) return;
                  setComment((current) => ({
                    ...current,
                    replies: [
                      ...(current.replies ?? []),
                      {
                        id: `${current.id}-story-reply-${(current.replies ?? []).length + 1}`,
                        author: "You",
                        body,
                        created_at: "2026-01-02T00:00:00Z",
                      },
                    ],
                  }));
                  setReplyDraft("");
                  args.onReply?.();
                }
              : undefined
          }
          onResolve={
            args.onResolve
              ? (resolved) => {
                  setComment((current) => ({ ...current, resolved }));
                  args.onResolve?.(resolved);
                }
              : undefined
          }
          onToggleAction={
            args.onToggleAction
              ? (actionId, done) => {
                  setComment((current) => ({
                    ...current,
                    action_items: current.action_items.map((item) =>
                      item.id === actionId ? { ...item, done } : item,
                    ),
                  }));
                  args.onToggleAction?.(actionId, done);
                }
              : undefined
          }
        />
      </ul>
    </div>
  );
}

const meta: Meta<typeof CommentCard> = {
  title: "Templates/CommentCard",
  component: CommentCard,
  tags: ["autodocs"],
  render: (args) => (
    <CardHarness
      key={JSON.stringify([args.comment, args.replyDraft, args.selected])}
      {...args}
    />
  ),
  args: {
    comment: sampleComment({
      id: "card-open",
      author: "Mira",
      body: "Keep the pause before the second answer.",
      track_ids: ["Guest"],
    }),
    onSelect: fn(),
    onReply: fn(),
    onReplyDraftChange: fn(),
    onResolve: fn(),
    onToggleAction: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof CommentCard>;

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Resolve" })).toBeVisible();
  },
};

export const Resolved: Story = {
  args: {
    comment: sampleComment({
      id: "card-resolved",
      author: "Ari",
      body: "The transition is clear now.",
      resolved: true,
      resolved_by: "Mira",
      resolved_at: "2026-01-02T00:00:00Z",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /Reopen/ })).toBeVisible();
  },
};

export const ResolveAndReopen: Story = {
  args: {
    comment: sampleComment({ id: "card-toggle", author: "Mira" }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Resolve" }));
    await expect(args.onResolve).toHaveBeenCalledWith(true);
    await userEvent.click(canvas.getByRole("button", { name: /Reopen/ }));
    await expect(args.onResolve).toHaveBeenCalledWith(false);
    await expect(canvas.getByRole("button", { name: "Resolve" })).toBeVisible();
  },
};

export const ActionsAndReplies: Story = {
  args: {
    comment: sampleComment({
      id: "card-actions",
      author: "Bo",
      body: "Two edits for the opening.",
      action_items: [
        {
          id: "trim",
          text: "Trim the intro",
          done: false,
          completed_at: null,
          completed_by: null,
        },
        {
          id: "music",
          text: "Lower the music",
          done: true,
          completed_at: "2026-01-02T00:00:00Z",
          completed_by: "Ari",
        },
      ],
      replies: [
        {
          id: "reply",
          author: "Ari",
          body: "Music is lower now.",
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
    }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Trim the intro" }),
    );
    await expect(args.onToggleAction).toHaveBeenCalledWith("trim", true);
    await userEvent.click(canvas.getByRole("button", { name: "Reply" }));
    await expect(args.onReply).not.toHaveBeenCalled();
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Reply to Bo" }),
      " Thanks ",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Reply" }));
    await expect(args.onReply).toHaveBeenCalled();
    await expect(canvas.getByText("Thanks")).toBeVisible();
    await expect(
      canvas.getByRole("textbox", { name: "Reply to Bo" }),
    ).toHaveValue("");
  },
};

export const Busy: Story = {
  args: {
    comment: sampleComment({ id: "card-busy", author: "Mira" }),
    busy: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Resolve" }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole("textbox", { name: "Reply to Mira" }),
    ).toBeDisabled();
  },
};

export const ReadOnly: Story = {
  args: {
    comment: sampleComment({
      id: "card-readonly",
      author: "Ari",
      resolved: true,
    }),
    showResolve: false,
    showReply: false,
    showActions: false,
    onSelect: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Resolved")).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const MobileLongThread: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  args: {
    comment: sampleComment({
      id: "card-mobile",
      author: "Bo",
      body: "When you reach the second story, pause before the punchline so the listener has time to follow the change in place and speaker.",
      replies: [
        {
          id: "mobile-reply",
          author: "Mira",
          body: "I can leave that beat in the next cut.",
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
    }),
  },
};
