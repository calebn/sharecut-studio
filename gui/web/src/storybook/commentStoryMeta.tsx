import type { Meta } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CommentCard } from "../system/CommentCard";
import { Composer } from "../system/Composer";
import { ComposerHarness } from "./ComposerHarness";
import { OPEN_COMMENT } from "./commentFixtures";
import { columnStoryDecorator, viewportStoryParameters } from "./storyLayout";

export const composerStoryMeta = {
  component: Composer as never,
  render: (args) => <ComposerHarness {...args} />,
  tags: ["autodocs"],
  args: { onSubmit: fn(), onAnchor: fn(), explainEmpty: true },
  decorators: [columnStoryDecorator],
} satisfies Meta<typeof ComposerHarness>;

export const commentCardStoryMeta = {
  component: CommentCard,
  tags: ["autodocs"],
  args: {
    comment: OPEN_COMMENT,
    onSelect: fn(),
    onResolve: fn(),
    onToggleAction: fn(),
  },
  decorators: [columnStoryDecorator],
} satisfies Meta<typeof CommentCard>;

export function storyParameters(description: string) {
  return {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: { component: description },
    },
  };
}
