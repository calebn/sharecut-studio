import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { PhoneFrame } from "../storybook/ComposerHarness";
import {
  COMMENT_WITH_ACTIONS,
  OPEN_COMMENT,
  RESOLVED_COMMENT,
} from "../storybook/commentFixtures";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { playInCanvas } from "../storybook/storyPlay";
import { CommentCard } from "../system/CommentCard";

const meta: Meta<typeof CommentCard> = {
  title: "Stages/Review/CommentCard",
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
          "A Review comment with its thread, in the states the stage meets. The caller owns the Undo toast for Resolve.\n\n**Motion.** Animations come later.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CommentCard>;

export const Open: Story = {
  play: playInCanvas(async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Resolve" }),
    );
    await expect(args.onResolve).toHaveBeenCalledWith(true);
  }),
};

export const WithActions: Story = {
  args: { comment: COMMENT_WITH_ACTIONS },
  play: playInCanvas(async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("checkbox", {
        name: "Re-level the intro",
      }),
    );
    await expect(args.onToggleAction).toHaveBeenCalledWith("a2", true);
  }),
};

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

export const ReadOnly: Story = {
  args: { comment: COMMENT_WITH_ACTIONS, readOnly: true },
};

export const Phone: Story = {
  args: {
    comment: COMMENT_WITH_ACTIONS,
    reply: {
      body: "",
      onBodyChange: fn(),
      onSubmit: fn(),
      submitLabel: "Reply",
      compact: true,
    },
  },
  decorators: [
    (Story) => (
      <PhoneFrame>
        <Story />
      </PhoneFrame>
    ),
  ],
};
