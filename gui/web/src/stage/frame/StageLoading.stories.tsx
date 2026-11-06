import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { StageLoading } from "./StageLoading";

const meta: Meta<typeof StageLoading> = {
  title: "Stages/Frame/Loading",
  component: StageLoading,
  tags: ["autodocs"],
  args: {
    stage: "prepare",
    name: "Rosa and Maya",
    shell: "desktop",
    elapsedMs: 1000,
    onRetry: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    viewport: { options: studioViewports },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The Loading cover for a project on its way: nothing for 300 ms, then the Stage bar for real (the name is known from the URL or the Home card) over static grey placeholders in the destination stage\'s own layout, and after 4 s one line, "Still loading…" with a Retry button. No spinner, no "Loading" text. The stories fix the elapsed time; the app lets the timers run.',
      },
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<typeof StageLoading>;

export const Blank: Story = {
  args: { elapsedMs: 100 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("tablist")).toBeNull();
  },
};

export const Prepare: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: /Prepare/, selected: true }),
    ).toBeVisible();
    const visibleLoading = canvas
      .queryAllByText(/Loading/)
      .filter((node) => !node.closest(".sr-only"));
    await expect(visibleLoading).toHaveLength(0);
    await expect(canvas.queryByRole("progressbar")).toBeNull();
  },
};

export const Review: Story = { args: { stage: "review" } };

export const Edit: Story = {
  args: { stage: "edit" },
};

export const EditTablet: Story = {
  args: { stage: "edit", shell: "tablet" },
  globals: { viewport: { value: "tablet", isRotated: false } },
};

export const EditPhone: Story = {
  args: { stage: "edit", shell: "phone" },
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const EditDark: Story = {
  args: { stage: "edit" },
  globals: { theme: "dark", viewport: { value: "desktop", isRotated: false } },
};

export const Deliver: Story = { args: { stage: "deliver" } };

export const Slow: Story = {
  args: { elapsedMs: 9000 },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Still loading…")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const Phone: Story = {
  args: { shell: "phone", stage: "review" },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
