import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { LiveComments } from "./LiveComments";
import type { LiveComment } from "./liveCommentQueue";
import {
  recordMobileViewport,
  recordStoryDecorator,
} from "./recordStoryDecorator";
import type { RecordSnapshot } from "./types";

const host = recordParticipant({
  participant_id: "host-1",
  role: "host",
  display_name: "Ada",
});
const me = recordParticipant();

function snapshot(state: RecordSnapshot["state"]): RecordSnapshot {
  return recordSnapshot({ state, participants: [host, me] });
}

function liveComment(
  id: string,
  author: string,
  body: string,
  recording_ms: number,
): LiveComment {
  return {
    id,
    take_index: 0,
    recording_ms,
    pressed_wall_ms: recording_ms,
    author,
    body,
  };
}

/** Fresh array per story so no story can mutate another's fixtures. */
function sampleComments(): LiveComment[] {
  return [
    liveComment("c1", "guest-1", "levels look good", 12000),
    liveComment("c2", "host-1", "redo the intro after this take", 45000),
  ];
}

const DRAFT = "check the laugh at 12:04";

type Args = Parameters<typeof LiveComments>[0];

/** Hold `note` in story state so the field is typeable; still log `onNote`. */
function NoteHarness(args: Args) {
  const [note, setNote] = useState(args.note);
  return (
    <LiveComments
      {...args}
      note={note}
      onNote={(value) => {
        setNote(value);
        args.onNote(value);
      }}
    />
  );
}

const meta: Meta<typeof LiveComments> = {
  title: "Templates/LiveComments",
  component: LiveComments,
  tags: ["autodocs"],
  decorators: [recordStoryDecorator],
  render: (args) => <NoteHarness key={args.note} {...args} />,
  args: {
    note: "",
    onNote: fn(),
    onMarker: fn(),
    onSubmitNote: fn(),
    me,
  },
};

export default meta;
type Story = StoryObj<typeof LiveComments>;

export const Empty: Story = {
  args: { snapshot: snapshot("recording") },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const add = canvas.getByRole("button", { name: "Add note" });
    await expect(add).toBeDisabled();
    await userEvent.type(canvas.getByLabelText("Note"), "nice");
    await expect(args.onNote).toHaveBeenLastCalledWith("nice");
    await expect(add).toBeEnabled();
  },
};

export const WithComments: Story = {
  args: { snapshot: snapshot("recording"), comments: sampleComments() },
  parameters: {
    docs: {
      description: {
        story: "The viewer's own comment renders as “You”.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("You: levels look good")).toBeVisible();
    await expect(
      canvas.getByText("Ada: redo the intro after this take"),
    ).toBeVisible();
  },
};

export const NoteDraft: Story = {
  args: {
    snapshot: snapshot("recording"),
    comments: sampleComments(),
    note: DRAFT,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Add note" }),
    ).toBeEnabled();
  },
};

export const Paused: Story = {
  args: {
    snapshot: snapshot("paused"),
    comments: sampleComments(),
    note: DRAFT,
  },
  parameters: {
    docs: {
      description: {
        story: "A paused take is still open: Marker and Add note stay enabled.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Marker" })).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: "Add note" }),
    ).toBeEnabled();
  },
};

const closedPlay: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("button", { name: "Marker" })).toBeDisabled();
  await expect(canvas.getByLabelText("Note")).toBeDisabled();
  await expect(canvas.getByRole("button", { name: "Add note" })).toBeDisabled();
};

export const TakeClosed: Story = {
  args: {
    snapshot: snapshot("stopped"),
    comments: sampleComments(),
    note: DRAFT,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Same draft as NoteDraft, but the take is stopped: Marker and the note form are disabled.",
      },
    },
  },
  play: closedPlay,
};

export const Lobby: Story = {
  args: { snapshot: snapshot("lobby"), note: DRAFT },
  parameters: {
    docs: {
      description: {
        story: "Before the first take starts, the form is disabled.",
      },
    },
  },
  play: closedPlay,
};

export const MobileLongThread: Story = {
  globals: recordMobileViewport.globals,
  args: {
    snapshot: snapshot("recording"),
    comments: [
      ...sampleComments(),
      liveComment(
        "c3",
        "host-1",
        "Bo, when you get to the part about the second season, slow down a little and give the listener a beat before the punchline — we lost it last take because it landed right on top of my laugh.",
        61000,
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        liveComment(`m${i}`, i % 2 ? "host-1" : "guest-1", "Marker", 70000 + i),
      ),
    ],
  },
  parameters: {
    ...recordMobileViewport.parameters,
    docs: {
      description: {
        story:
          "Phone width (360px) with a long comment body and a busy thread.",
      },
    },
  },
};
