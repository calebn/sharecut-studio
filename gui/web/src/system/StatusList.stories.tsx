import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { StatusList } from "./StatusList";
import { StatusRow } from "./StatusRow";

const meta: Meta<typeof StatusList> = {
  title: "System/StatusList",
  component: StatusList,
  tags: ["autodocs"],
  args: { label: "Getting ready" },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "40rem" }}>
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
          "A list of Status rows, one list item each, named for assistive tech. Each row keeps one action; extra buttons live in the row's expanded body. A row with a body is a disclosure button with `aria-expanded`. Rows are 48 px at every width, so the phone list is as tall as the desktop one. The glyph names each state in hidden text (Done, Needs you, Failed), so colour and shape are never the only cue. A row that needs you comes first and is expanded.\n\n**Motion.** The bar grows with `--motion-state`; an expanding row opens with `--motion-panel`. Not implemented in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StatusList>;

export const Default: Story = {
  render: (args) => (
    <StatusList {...args}>
      <StatusRow state="done" title="Add audio" detail="3 files" />
      <StatusRow
        state="running"
        title="Transcribe"
        detail="2 of 3 speakers · about 1 min left"
        progress={0.6}
      />
      <StatusRow state="queued" title="Line up tracks" />
      <StatusRow state="queued" title="Clean and level" />
      <StatusRow state="queued" title="Find suggestions" />
    </StatusList>
  ),
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole("list", {
      name: "Getting ready",
    });
    await expect(within(list).getAllByRole("listitem")).toHaveLength(5);
  },
};

export const Mixed: Story = {
  render: (args) => (
    <StatusList {...args}>
      <StatusRow
        state="needs-you"
        title="Line up tracks"
        detail="Guest track moved 4.2 s"
        action={{ label: "Looks right", onAction: fn() }}
      />
      <StatusRow
        state="failed"
        title="Transcribe"
        detail="Rosa, take 2"
        action={{ label: "Try again", onAction: fn() }}
      />
      <StatusRow
        state="needs-you"
        title="Transcription model needed"
        action={{
          label: "Download 1.6 GB",
          icon: "cloud-download",
          onAction: fn(),
        }}
      />
      <StatusRow state="done" title="Clean and level" />
    </StatusList>
  ),
};

function ExpandableDemo(args: { label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <StatusList {...args}>
      <StatusRow
        state="running"
        title="Transcribe"
        detail="2 of 3 speakers"
        progress={0.6}
        expanded={open}
        onToggle={() => setOpen(!open)}
      >
        <StatusList label="Speakers">
          <StatusRow state="done" title="Maya" density="inline" />
          <StatusRow state="done" title="Anneke" density="inline" />
          <StatusRow
            state="running"
            title="Rosa"
            density="inline"
            progress={0.3}
          />
        </StatusList>
      </StatusRow>
      <StatusRow state="queued" title="Clean and level" />
    </StatusList>
  );
}

export const Expandable: Story = {
  render: (args) => <ExpandableDemo {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: /Transcribe/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByRole("list", { name: "Speakers" })).toBeVisible();
    await expect(canvas.getByText("Rosa")).toBeVisible();
  },
};

export const Phone: Story = {
  ...Mixed,
  globals: { viewport: { value: "mobile360", isRotated: false } },
};
