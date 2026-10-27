import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { openDialogByLauncher } from "../test/storyDialog";
import { Button } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import { NotesRail, type NotesRailProps } from "./NotesRail";
import type { NoteItem } from "./notesRailModel";
import { Sheet } from "./Sheet";

const MARKER_ROSA: NoteItem = {
  id: "m1",
  kind: "marker",
  author: { name: "Rosa Diaz", colorIndex: 2 },
  time: "12:01",
};
const NOTE_MAYA: NoteItem = {
  id: "n1",
  kind: "note",
  author: { name: "Maya Chen", colorIndex: 0 },
  text: "Jon's mic drops out here.",
  time: "12:02",
  visibility: "everyone",
};
const NOTE_ROSA: NoteItem = {
  id: "n2",
  kind: "note",
  author: { name: "Rosa Diaz", colorIndex: 2 },
  text: "Can we keep the laugh in this take?",
  time: "12:04",
  visibility: "everyone",
};
const MARKER_MAYA: NoteItem = {
  id: "m2",
  kind: "marker",
  author: { name: "Maya Chen", colorIndex: 0 },
  time: "12:09",
};
const SESSION_MAYA: NoteItem = {
  id: "n3",
  kind: "note",
  author: { name: "Maya Chen", colorIndex: 0 },
  text: "Start with the cold open, then the interview.",
  time: null,
  visibility: "everyone",
};
const PRIVATE_ROSA: NoteItem = {
  id: "n4",
  kind: "note",
  author: { name: "Rosa Diaz", colorIndex: 2 },
  text: "Jon's level is low, lift him before the break.",
  time: "12:06",
  visibility: "hosts",
};

const MIXED = [
  MARKER_ROSA,
  NOTE_MAYA,
  NOTE_ROSA,
  MARKER_MAYA,
  SESSION_MAYA,
] satisfies NoteItem[];

const meta: Meta<typeof NotesRail> = {
  title: "Stages/Record/NotesRail",
  component: NotesRail,
  tags: ["autodocs"],
  args: {
    items: [],
    viewer: "host",
    selfName: "Maya Chen",
    draft: "",
    onDraftChange: fn(),
    draftTime: null,
    onClearTime: fn(),
    everyone: false,
    onEveryoneChange: fn(),
    onSend: fn(),
    paused: false,
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ blockSize: "36rem", display: "flex" }}>
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
          'The Notes rail: a 320 px column in the Record room. Markers and notes are one chronological list of QueueRow comment rows (the same row Review uses, so a note looks the same before and after it lands). A marker reads "Marker" with the comment-pin glyph; a note shows its text, clamped to one line with the full text as its title. A session-level note has no time chip. A hosts-only note carries a lock. The composer is one field with the time chip at its left (clear it to make a session note) and the send glyph inside: Enter sends, Shift+Enter starts a new line. Send is off until the draft has words, and says why. The "Everyone" toggle appears for host and producers only; guests see markers, everyone-notes and their own.\n\n**Motion.** None in this slice. The new row settling into the list and the send glyph come later.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof NotesRail>;

/**
 * Holds the draft, the pinned time, the Everyone choice and the list so the
 * stories type and send for real. The caller's handlers still run.
 */
function LiveRail({
  items,
  draft,
  draftTime,
  everyone,
  selfName,
  onSend,
  onEveryoneChange,
  ...rest
}: NotesRailProps) {
  const [list, setList] = useState(items);
  const [text, setText] = useState(draft);
  const [time, setTime] = useState(draftTime);
  const [all, setAll] = useState(everyone);
  return (
    <NotesRail
      {...rest}
      selfName={selfName}
      items={list}
      draft={text}
      onDraftChange={setText}
      draftTime={time}
      onClearTime={() => setTime(null)}
      everyone={all}
      onEveryoneChange={
        onEveryoneChange
          ? (next) => {
              setAll(next);
              onEveryoneChange(next);
            }
          : undefined
      }
      onSend={(note) => {
        onSend(note);
        setList((prev) => [
          ...prev,
          {
            id: `sent-${prev.length + 1}`,
            kind: "note",
            author: { name: selfName, colorIndex: 0 },
            text: note.text,
            time: note.time,
            visibility: note.everyone ? "everyone" : "hosts",
          },
        ]);
        setText("");
      }}
    />
  );
}

export const Empty: Story = {
  args: { items: [] },
  render: (args) => <LiveRail {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("No notes yet. Notes pin to the recording time."),
    ).toBeVisible();
    await expect(
      canvas.getAllByRole("button", { name: "Send note" }),
    ).toHaveLength(1);
  },
};

export const WithNotesAndMarkers: Story = {
  args: { items: MIXED },
  render: (args) => <LiveRail {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("listitem")).toHaveLength(5);
    await expect(canvas.getAllByText("Marker")).toHaveLength(2);
    await expect(
      canvas.getByText("Can we keep the laugh in this take?"),
    ).toBeVisible();
    await expect(
      canvas.getAllByRole("button", { name: "Send note" }),
    ).toHaveLength(1);
  },
};

export const Drafting: Story = {
  args: {
    items: MIXED,
    draftTime: "12:04",
    onSend: fn(),
  },
  render: (args) => <LiveRail {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // The row for the 12:04 note shares the time, so scope to the composer's chip.
    const chip = canvas.getByRole("button", {
      name: "12:04, clear time to make this a session note",
    });
    await expect(within(chip).getByText("12:04")).toBeVisible();
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Add a note" }),
      "Is this under three seconds of dead air?{enter}",
    );
    await expect(args.onSend).toHaveBeenCalledWith({
      text: "Is this under three seconds of dead air?",
      time: "12:04",
      everyone: false,
    });
    await expect(
      canvas.getByRole("textbox", { name: "Add a note" }),
    ).toHaveValue("");
  },
};

export const Paused: Story = {
  args: { items: MIXED, paused: true },
  render: (args) => <LiveRail {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Paused. Notes land at the pause."),
    ).toBeVisible();
    // The composer still works while paused.
    await expect(
      canvas.getAllByRole("button", { name: "Send note" }),
    ).toHaveLength(1);
  },
};

export const PrivateToHost: Story = {
  args: { items: [...MIXED, PRIVATE_ROSA], viewer: "host" },
  render: (args) => <LiveRail {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", {
        name: /Jon's level is low.*Host and producers only/,
      }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Everyone" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

function PhoneRail({
  startAt,
  ...args
}: NotesRailProps & { startAt: DrawerDetent }) {
  const [open, setOpen] = useState(false);
  const [detent, setDetent] = useState<DrawerDetent>(startAt);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open notes</Button>
      <Sheet
        form="bottom"
        title="Notes"
        open={open}
        onClose={() => setOpen(false)}
        detent={detent}
        onDetentChange={setDetent}
      >
        <LiveRail {...args} />
      </Sheet>
    </>
  );
}

function phoneStory(startAt: DrawerDetent): Story {
  return {
    args: { items: MIXED },
    globals: { viewport: { value: "mobile360", isRotated: false } },
    parameters: isolatedStoryParameters,
    decorators: [],
    render: (args) => <PhoneRail {...args} startAt={startAt} />,
    play: async ({ canvasElement, viewMode }) => {
      if (viewMode === "docs") return;
      const dialog = await openDialogByLauncher(canvasElement, {
        launcherName: "Open notes",
        dialogName: "Notes",
      });
      await expect(
        within(dialog).getAllByRole("button", { name: "Send note" }),
      ).toHaveLength(1);
      await expect(
        within(dialog).getByText("Can we keep the laugh in this take?"),
      ).toBeVisible();
    },
  };
}

// In peek the strip is as tall as its content, so the composer sits under a
// short list; the phone list caps its height so a long list cannot hide it.
export const Phone: Story = phoneStory("peek");
export const PhoneSheetHalf: Story = phoneStory("half");
