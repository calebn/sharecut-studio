import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Avatar } from "../ui";
import { Cover } from "./Cover";

const meta: Meta<typeof Cover> = {
  title: "System/Cover",
  component: Cover,
  tags: ["autodocs"],
  args: {
    size: "page",
    glyph: "inbox",
    title: "Nothing to decide",
    children:
      "Every suggestion has an answer. New ones appear here as you edit.",
    secondary: { label: "Back to Edit", onClick: fn() },
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The one "nothing to show here" layout: a 48 px case glyph, a 20/24 title, one sentence, at most one primary and one text button. Page size adds the 32 px symbol; on phone the text block starts at 30% of the height and the primary is pinned in the thumb zone. Renders a `<section>`, never `<main>`. Never server JSON.\n\n**Motion.** The block fades in with `--motion-state` after the Skeleton hands over; not implemented in this slice.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Cover>;

export const Empty: Story = {};

export const BadLink: Story = {
  args: {
    glyph: "octagon-alert",
    title: "This link does not work",
    children: "Ask the host for a new one.",
    primary: undefined,
  },
};

export const LinkEnded: Story = {
  args: {
    glyph: "door-open",
    title: "This link has ended",
    children: "The host stopped sharing the project.",
  },
};

export const EndedWithRecording: Story = {
  args: {
    glyph: "door-open",
    title: "The session ended",
    children: "Your local recording is safe on this device.",
    primary: { label: "Save my recording", onClick: fn() },
    secondary: undefined,
  },
};

export const RoomFull: Story = {
  args: {
    glyph: "headphones",
    title: "The room is full",
    children: "Try again in a minute.",
    primary: { label: "Try again", onClick: fn() },
    secondary: undefined,
    extra: (
      <span style={{ display: "inline-flex", gap: "0.25rem" }}>
        <Avatar name="Maya Chen" colorIndex={0} />
        <Avatar name="Rosa Diaz" colorIndex={1} />
        <Avatar name="Tom Park" colorIndex={2} />
      </span>
    ),
  },
};

export const HostAsleep: Story = {
  args: {
    glyph: "cloud-off",
    title: "The host is away",
    children: "We will let you in when they are back.",
    primary: { label: "Try again", onClick: fn() },
    secondary: undefined,
  },
};

export const NotServedHere: Story = {
  args: {
    glyph: "cloud-off",
    title: "This is not available here",
    children: "Open the project in the desktop app to use this.",
    primary: undefined,
    secondary: { label: "Back to Home", onClick: fn() },
  },
};

export const RegionFailed: Story = {
  args: {
    size: "region",
    glyph: "octagon-alert",
    title: "This part did not load",
    children: "The rest of the project is fine.",
    primary: { label: "Try again", onClick: fn() },
    secondary: undefined,
  },
};

export const Region: Story = {
  args: {
    size: "region",
    glyph: "text-search",
    title: "No matches",
    children: "Nothing in the transcript matches that search.",
    secondary: undefined,
  },
};

export const Phone: Story = {
  args: {
    primary: { label: "Go to Edit", onClick: fn() },
    secondary: undefined,
  },
};
