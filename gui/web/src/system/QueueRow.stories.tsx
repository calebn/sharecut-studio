import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  FILLER_EXCERPT,
  FILLER_WITH_UNSURE,
  UNSURE_EXCERPT,
} from "../storybook/reviewFixtures";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { QueueRow } from "./QueueRow";
import { Suggestion } from "./Suggestion";

const meta: Meta<typeof QueueRow> = {
  title: "System/QueueRow",
  component: QueueRow,
  tags: ["autodocs"],
  args: {
    kind: "filler",
    snippet: <Suggestion focus segments={FILLER_EXCERPT} />,
    time: "18:36",
    value: "0.8 s",
    onSelect: fn(),
    onVerb: fn(),
    onKeep: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "22.5rem" }}>
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
          "A Review queue row, 56 px: kind glyph or author, the snippet (the Suggestion drawing for a proposal), the time in mono and a value (saved seconds, or a reply count). The selected row has an accent left edge, an unread comment an 8 px accent dot, and a guest's unsent row a clock. Swipe right does the primary and left keeps. A decided row collapses to one quiet line with its result. A queue's own empty, loading and error states belong to the queue, not the row.\n\n**Motion.** Animations come later: the collapse and the swipe settle.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof QueueRow>;

export const Filler: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button"));
    await expect(args.onSelect).toHaveBeenCalledOnce();
    await expect(canvas.getByText("0.8 s")).toBeVisible();
  },
};

export const Pause: Story = {
  args: {
    kind: "pause",
    snippet: <Suggestion kind="pause" length={2.9} to={0.6} />,
    value: "2.3 s",
  },
};

export const Sound: Story = {
  args: { kind: "sound", snippet: "Laugh, 12 dB under Rosa", value: "12 dB" },
};

export const Selected: Story = {
  args: { selected: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button")).toHaveAttribute(
      "aria-current",
      "true",
    );
  },
};

export const UnsureWord: Story = {
  args: {
    kind: "unsure-word",
    snippet: "uncle",
    time: "10:14",
    value: undefined,
  },
};

export const FillerWithUnsureWord: Story = {
  args: { snippet: <Suggestion focus segments={FILLER_WITH_UNSURE} /> },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("uncle")).toHaveClass(
      "sys-sugg-unsure",
    );
  },
};

export const Comment: Story = {
  args: {
    kind: "comment",
    author: { name: "Rosa Diaz", colorIndex: 2 },
    snippet: "Can we keep the laugh here?",
    time: "11:42",
    value: "2 replies",
    unread: true,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: "Unread" }),
    ).toBeVisible();
  },
};

export const Offline: Story = {
  args: {
    kind: "comment",
    author: { name: "You", colorIndex: 0 },
    snippet: "Is this under three seconds of dead air?",
    time: "21:03",
    offline: true,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Waiting to send"),
    ).toBeInTheDocument();
  },
};

export const Decided: Story = {
  args: { decided: { result: "applied", text: "Cut 0.8 s" } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Cut 0.8 s")).toBeVisible();
    await expect(within(canvasElement).queryByRole("button")).toBeNull();
  },
};

export const DecidedKept: Story = {
  args: { decided: { result: "kept", text: "Kept" } },
};

export const LongSnippet: Story = {
  args: {
    snippet: (
      <Suggestion
        segments={[
          ...UNSURE_EXCERPT,
          { text: " and then we walked all the way down to the water." },
        ]}
      />
    ),
  },
};

export const Phone: Story = {};
