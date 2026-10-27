import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { PhoneFrame } from "../storybook/ComposerHarness";
import {
  COMMENT_WITH_ACTIONS,
  OPEN_COMMENT,
  RESOLVED_COMMENT,
} from "../storybook/commentFixtures";
import {
  columnStoryDecorator,
  viewportStoryParameters,
} from "../storybook/storyLayout";
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
  decorators: [columnStoryDecorator],
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

export const Phone: Story = {
  args: {
    comment: COMMENT_WITH_ACTIONS,
    reply: {
      body: "",
      onBodyChange: fn(),
      onSubmit: fn(),
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
