import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { ComposerHarness } from "../storybook/ComposerHarness";
import { composerStoryMeta } from "../storybook/commentStoryMeta";

const meta = { ...composerStoryMeta, title: "Zz/SavedName" } satisfies Meta<
  typeof ComposerHarness
>;
export default meta;
export const Saved: StoryObj<typeof ComposerHarness> = {
  args: { name: { value: "Rosa", saved: true, onChange: fn() }, start: "" },
};
