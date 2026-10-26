import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { RecordDock } from "./RecordDock";

const meta: Meta<typeof RecordDock> = {
  title: "System/RecordDock",
  component: RecordDock,
  tags: ["autodocs"],
  args: {
    seat: "host",
    record: { face: "idle", onStart: fn(), onStop: fn() },
    onMute: fn(),
    onComment: fn(),
    onPause: fn(),
    onNotes: fn(),
    onMore: fn(),
    onLeave: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ paddingBlockStart: "12rem", maxInlineSize: "80rem" }}>
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
          "The Record stage's Action bar in its transport form: centred round buttons, 48 px secondaries around one 64 px primary, 16 px apart, with Leave or More 24 px away at the far right, pulled closer under 40rem. The primary is the most frequent act for the role: Record for the host, Mute for a guest, Comment for a producer. Only the buttons a role has are present. After Stop a status line replaces the secondaries. Presentational: state in, callbacks out.\n\n**Motion.** None yet. Later: the Record button pulse and the status line cross-fade.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RecordDock>;

const buttonNames = (root: HTMLElement) =>
  within(root)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

export const RecordHost: Story = {
  play: async ({ canvasElement }) => {
    const dock = canvasElement.querySelector<HTMLElement>(".sys-dock");
    const rem = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const style = dock ? getComputedStyle(dock) : undefined;
    const content =
      (dock?.clientWidth ?? 0) -
      Number.parseFloat(style?.paddingLeft ?? "0") -
      Number.parseFloat(style?.paddingRight ?? "0");
    // jsdom has no layout (width 0) and no container query, so Notes shows there;
    // a browser measures the dock's content box, as the container query does.
    const narrow = content > 0 && content <= 40 * rem;
    await expect(buttonNames(canvasElement)).toEqual(
      narrow
        ? ["Mute", "Comment", "Record", "More"]
        : ["Mute", "Comment", "Record", "Notes", "More"],
    );
  },
};

export const RecordHostLive: Story = {
  args: { record: { face: "live", onStart: fn(), onStop: fn() } },
};

export const RecordHostPaused: Story = {
  args: { record: { face: "paused", onStart: fn(), onStop: fn() } },
};

export const RecordHostWaitingForGuest: Story = {
  args: {
    record: {
      face: "idle",
      disabledReason: "Waiting for Jon to join",
      onStart: fn(),
      onStop: fn(),
    },
  },
};

export const RecordGuest: Story = {
  args: { seat: "guest", record: undefined },
  play: async ({ canvasElement }) => {
    await expect(buttonNames(canvasElement)).toEqual([
      "Mute",
      "Comment",
      "Notes",
      "Leave room",
    ]);
  },
};

export const RecordGuestMuted: Story = {
  args: { seat: "guest", record: undefined, muted: true, unreadNotes: 2 },
};

export const RecordGuestSaving: Story = {
  args: {
    seat: "guest",
    record: undefined,
    status: "Saving · 64% · keep this page open",
    leaveDisabledReason: "Your recording is still saving",
  },
};

export const RecordProducer: Story = {
  args: { seat: "producer", record: undefined, notesOpen: true },
  play: async ({ canvasElement }) => {
    await expect(buttonNames(canvasElement)).toEqual([
      "Comment",
      "Notes",
      "Leave room",
    ]);
  },
};
