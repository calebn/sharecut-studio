import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { StatusRow } from "./StatusRow";

const meta: Meta<typeof StatusRow> = {
  title: "System/StatusRow",
  component: StatusRow,
  tags: ["autodocs"],
  args: { state: "queued", title: "Clean up room noise" },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
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
          "One line about a state someone may need to act on, or a task that is running: status glyph, plain title, a detail with numbers, a 4 px bar while running, at most one action. Densities: list 48, alert 44, inline 32. Rows with children expand. The glyph shape differs per state, so colour is never the only cue.\n\n**Motion.** The bar grows with `--motion-state`; an expanding row opens with `--motion-panel`. Not implemented in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StatusRow>;

const named = (state: string): Story["play"] =>
  async function play({ canvasElement }) {
    await expect(within(canvasElement).getByText(state)).toBeInTheDocument();
  };

export const Queued: Story = {
  args: { detail: "Waiting for 2 jobs" },
  play: named("Not yet"),
};
export const Running: Story = {
  args: {
    state: "running",
    title: "Finding the words",
    detail: "3 of 5 sources",
    progress: 0.6,
    action: { label: "Cancel", onAction: fn() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Running")).toBeInTheDocument();
    await expect(
      canvas.getByRole("progressbar", { name: "Finding the words" }),
    ).toHaveAttribute("aria-valuenow", "60");
  },
};
export const Done: Story = {
  args: { state: "done", title: "Transcript ready", detail: "52:10" },
  play: named("Done"),
};
export const NeedsYou: Story = {
  args: {
    state: "needs-you",
    title: "2 words are unsure",
    action: { label: "Fix", onAction: fn() },
  },
  play: named("Needs you"),
};
export const Failed: Story = {
  args: {
    state: "failed",
    title: "Upload stopped",
    detail: "Rosa, take 2",
    details:
      "The connection dropped at 38 percent. The file is safe on this computer.",
    action: { label: "Try again", onAction: fn() },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Failed")).toBeInTheDocument();
    const details = canvas.getByRole("button", {
      name: "Details for Upload stopped",
    });
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(details);
    await expect(canvas.getByText(/connection dropped/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.action?.onAction).toHaveBeenCalledOnce();
  },
};
export const NeedsModel: Story = {
  args: {
    state: "needs-you",
    title: "Speech model needed",
    action: { label: "Get 142 MB", icon: "cloud-download", onAction: fn() },
  },
};

function ExpandableDemo(args: React.ComponentProps<typeof StatusRow>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <StatusRow
      {...args}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    >
      <StatusRow state="done" title="Maya" density="inline" />
      <StatusRow
        state="running"
        title="Rosa"
        detail="1 of 2"
        progress={0.5}
        density="inline"
      />
    </StatusRow>
  );
}

export const Expandable: Story = {
  args: {
    state: "running",
    title: "Uploading takes",
    detail: "3 of 5",
    progress: 0.6,
  },
  render: (args) => <ExpandableDemo {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /Uploading takes/ }),
    );
    await expect(canvas.getByText("Rosa")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: /Uploading takes/ }),
    );
    await expect(canvas.queryByText("Rosa")).toBeNull();
  },
};

export const Alert: Story = {
  args: {
    state: "failed",
    density: "alert",
    title: "Saving failed",
    action: { label: "Retry", onAction: fn() },
  },
};
export const Inline: Story = {
  args: { state: "done", density: "inline", title: "Mic works" },
};
