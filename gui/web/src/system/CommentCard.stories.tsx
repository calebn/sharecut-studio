import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  COMMENT_WITH_ACTIONS,
  OPEN_COMMENT,
  RESOLVED_COMMENT,
} from "../storybook/commentFixtures";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { playInCanvas } from "../storybook/storyPlay";
import { CommentCard } from "./CommentCard";

const meta: Meta<typeof CommentCard> = {
  title: "System/CommentCard",
  component: CommentCard,
  tags: ["autodocs"],
  args: {
    comment: OPEN_COMMENT,
    onSelect: fn(),
    onResolve: fn(),
    onToggleAction: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "30rem" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "A comment as plain data: author, time in mono, body, replies and action items. Select jumps the playhead. Resolve hands the Undo toast to the caller. A guest viewer sees no resolve and no action toggles. An unsent comment shows the offline glyph, or Not sent when the server refused it. Replying reuses the Composer.\n\n**Motion.** Animations come later: a resolved card settles to its quiet line. Swipe to resolve returns with the wiring.",
      },
    },
  },
};

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
      submitLabel: "Reply",
      placeholder: "Reply to Rosa",
    },
  },
};

export const Resolved: Story = { args: { comment: RESOLVED_COMMENT } };

export const Queued: Story = {
  args: { comment: { ...OPEN_COMMENT, pending: "queued" } },
};

export const Failed: Story = {
  args: { comment: { ...OPEN_COMMENT, pending: "failed" } },
};

export const ReadOnly: Story = {
  args: { comment: COMMENT_WITH_ACTIONS, readOnly: true },
};
