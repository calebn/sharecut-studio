import type { Meta, StoryObj } from "@storybook/react-vite";
import { LiveComments } from "./LiveComments";
import type { LiveComment } from "./liveCommentQueue";
import type { RecordParticipant, RecordSnapshot } from "./types";

const noop = () => undefined;

const host: RecordParticipant = {
  participant_id: "host-1",
  role: "host",
  display_name: "Ada",
  connected: true,
  consented: true,
  muted: false,
  headphones_ack: true,
};

const me: RecordParticipant = {
  participant_id: "guest-1",
  role: "guest",
  display_name: "Bo",
  connected: true,
  consented: true,
  muted: false,
  headphones_ack: true,
};

function snapshot(state: RecordSnapshot["state"]): RecordSnapshot {
  return {
    session_id: "sess-1",
    state,
    take_index: 0,
    participants: [host, me],
    caps: { recorded: 4, producers: 2 },
  };
}

const comments: LiveComment[] = [
  {
    id: "c1",
    take_index: 0,
    recording_ms: 12000,
    pressed_wall_ms: 1,
    author: "guest-1",
    body: "levels look good",
  },
  {
    id: "c2",
    take_index: 0,
    recording_ms: 45000,
    pressed_wall_ms: 2,
    author: "host-1",
    body: "redo the intro after this take",
  },
];

const meta: Meta<typeof LiveComments> = {
  title: "Record/LiveComments",
  component: LiveComments,
  tags: ["autodocs"],
  args: {
    note: "",
    onNote: noop,
    onMarker: noop,
    onSubmitNote: noop,
    me,
  },
};

export default meta;
type Story = StoryObj<typeof LiveComments>;

export const Empty: Story = {
  args: { snapshot: snapshot("recording") },
};

export const WithComments: Story = {
  args: { snapshot: snapshot("recording"), comments },
  parameters: {
    docs: {
      description: {
        story: "The viewer's own comment renders as “You”.",
      },
    },
  },
};

export const NoteDraft: Story = {
  args: {
    snapshot: snapshot("recording"),
    comments,
    note: "check the laugh at 12:04",
  },
};

export const TakeClosed: Story = {
  args: { snapshot: snapshot("stopped") },
  parameters: {
    docs: {
      description: {
        story:
          "When the take is closed, Marker and the note form are disabled.",
      },
    },
  },
};
