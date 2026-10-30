import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { RecordSessionSummary } from "../../record";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { EndedSessionCard } from "./EndedSessionCard";

const session: RecordSessionSummary = {
  session_id: "s1",
  number: 2,
  state: "ended",
  target_kind: null,
  takes: [
    { take_index: 0, recording_ms: 360_000 },
    { take_index: 1, recording_ms: 300_000 },
  ],
  participants: [
    {
      participant_id: "p_ava",
      display_name: "Ava Lindgren",
      role: "guest",
      track_id: "t_ava",
    },
    {
      participant_id: "p_sam",
      display_name: "Sam",
      role: "guest",
      track_id: null,
    },
  ],
  landed: true,
  ended_at: "2026-10-25T18:00:00Z",
};
const tracks = [
  { id: "t_host", label: "Host" },
  { id: "t_ava", label: "Ava" },
];

const meta: Meta<typeof EndedSessionCard> = {
  title: "Stages/Record/Ended session card",
  component: EndedSessionCard,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    viewport: { options: studioViewports },
    docs: {
      description: {
        component:
          "The previous session on the Record stage. Once a session has landed, each person's track is a menu of the project's tracks; picking one moves all of that person's clips of the session there, keeping their start times, as one undo step. A person whose clips sit on several tracks reads Several tracks. Without a landing, with one track or with no clips found, the row is plain text.\n\n**Motion.** None beyond the shared Menu drop-in.",
      },
    },
  },
  args: {
    session,
    trackNames: new Map(tracks.map((t) => [t.id, t.label])),
    tracks,
    movable: new Set(["p_ava", "p_sam"]),
    onRemap: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof EndedSessionCard>;

export const Default: Story = {};

export const MenuOpen: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Track for Ava Lindgren: Ava" }),
    );
    const menu = within(
      await within(canvasElement.ownerDocument.body).findByRole("menu"),
    );
    await expect(
      menu.getByRole("menuitemradio", { name: "Ava" }),
    ).toHaveAttribute("aria-checked", "true");
    await userEvent.click(menu.getByRole("menuitemradio", { name: "Host" }));
    await expect(args.onRemap).toHaveBeenCalledWith("p_ava", "t_host");
  },
};

export const Busy: Story = { args: { busy: true } };

export const NotLanded: Story = {
  args: { session: { ...session, landed: false } },
};
