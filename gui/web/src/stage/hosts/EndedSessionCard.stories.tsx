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
  name: null,
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
          "The previous session on the Record stage. Once a session has landed, each person's track is a menu of the project's tracks, ending in New track; picking a track moves all of that person's clips of the session there, keeping their start times, as one undo step. New track first adds a track named for the person. A landed session with clips on the timeline has the primary Edit Session N, which opens Edit at the session start with its clips selected. A person whose clips sit on several tracks reads Several tracks. A landed, numbered session has a Rename button beside the heading: it opens a text field (Enter or leaving saves, Escape cancels, 80 characters at most), the name replaces the Session N · date heading, and an emptied field clears it. Without a landing, with one track or with no clips found, the row is plain text.\n\n**Motion.** None beyond the shared Menu drop-in.",
      },
    },
  },
  args: {
    session,
    trackNames: new Map(tracks.map((t) => [t.id, t.label])),
    tracks,
    movable: new Set(["p_ava", "p_sam"]),
    onRemap: fn(),
    onNewTrack: fn(),
    onEdit: fn(),
    onRename: fn(),
    hasClips: true,
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

export const Renamed: Story = {
  args: { session: { ...session, name: "Cold open" } },
};

export const Renaming: Story = {
  args: { session: { ...session, name: "Cold open" } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Rename session" }),
    );
    const field = canvas.getByRole("textbox", { name: "Session name" });
    await expect(field).toHaveFocus();
    await userEvent.clear(field);
    await userEvent.type(field, "Interview{Enter}");
    await expect(args.onRename).toHaveBeenCalledWith("Interview");
  },
};

export const Busy: Story = { args: { busy: true } };

export const NotLanded: Story = {
  args: { session: { ...session, landed: false } },
};

export const EditHandoff: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Session 2" }),
    );
    await expect(args.onEdit).toHaveBeenCalledTimes(1);
  },
};

export const NoClipsOnTimeline: Story = {
  args: { hasClips: false, movable: new Set<string>() },
};

export const NewTrackWithOneTrack: Story = {
  args: {
    tracks: [{ id: "t_ava", label: "Ava" }],
    session: {
      ...session,
      participants: [session.participants[0]],
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Track for Ava Lindgren: Ava" }),
    );
    const menu = within(
      await within(canvasElement.ownerDocument.body).findByRole("menu"),
    );
    await userEvent.click(menu.getByRole("menuitem", { name: "New track" }));
    await expect(args.onNewTrack).toHaveBeenCalledWith("p_ava");
  },
};
