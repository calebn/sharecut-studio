import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import type { NoteItem } from "./notesRailModel";
import { RoomView } from "./RoomView";
import type { RoomPerson } from "./roomViewModel";

// Fixtures for every story below. Stubbed state only: nothing here is wired.
const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const ANNEKE = { name: "Anneke de Vries", colorIndex: 1 };
const JOSS = { name: "Joss", colorIndex: 2 };
const JON = { name: "Jon", colorIndex: 3 };
const ROSA = { name: "Rosa Diaz", colorIndex: 2 };
const TITLE = "Episode 14: the one about the mic";

const HOST: RoomPerson = {
  role: "host",
  person: MAYA,
  presence: "live",
  connection: "good",
  level: 0.5,
  speaking: true,
};
const JON_YOU: RoomPerson = {
  role: "guest",
  person: JON,
  you: true,
  presence: "live",
  connection: "good",
  level: 0.3,
};
const ANNEKE_GUEST: RoomPerson = {
  role: "guest",
  person: ANNEKE,
  presence: "live",
  connection: "good",
  level: 0.1,
};
const JOSS_GUEST: RoomPerson = {
  role: "guest",
  person: JOSS,
  presence: "live",
  connection: "good",
  level: 0.2,
};
const ROSA_PRODUCER: RoomPerson = {
  role: "producer",
  person: ROSA,
  presence: "live",
};
const ROSA_YOU: RoomPerson = { ...ROSA_PRODUCER, you: true };

const NOTES: NoteItem[] = [
  {
    id: "m1",
    kind: "marker",
    author: { name: "Rosa Diaz", colorIndex: 2 },
    time: "12:01",
  },
  {
    id: "n1",
    kind: "note",
    author: { name: "Rosa Diaz", colorIndex: 2 },
    text: "Jon's mic drops out here.",
    time: "12:02",
    visibility: "everyone",
  },
  {
    id: "n2",
    kind: "note",
    author: { name: "Rosa Diaz", colorIndex: 2 },
    text: "Lift Jon before the break.",
    time: "12:06",
    visibility: "hosts",
  },
  {
    id: "n3",
    kind: "note",
    author: { name: "Jon", colorIndex: 3 },
    text: "My own note, kept for me.",
    time: "12:07",
    visibility: "hosts",
  },
];

const LIVE = { kind: "live", take: 1, clockSec: 724 } as const;
const WAITING = { kind: "waiting", host: "Maya" } as const;

const meta: Meta<typeof RoomView> = {
  title: "Stages/Record/Room",
  component: RoomView,
  tags: ["autodocs"],
  args: {
    seat: "guest",
    title: TITLE,
    people: [HOST, JON_YOU, ANNEKE_GUEST],
    phase: LIVE,
    notes: [],
    selfName: "Jon",
    onSendNote: fn(),
    onInvite: fn(),
    onMute: fn(),
    onComment: fn(),
    onPause: fn(),
    onMore: fn(),
    onLeave: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ blockSize: "44rem", inlineSize: "100%" }}>
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
          "The Record room for guests and producers on the desktop: a 48 px header with the wordmark, the session title and the status pill; the record alert slot (0 or 44 px); the person tile grid with the listener row; the Notes rail, 320 px beside the grid and open by default for a producer; and the dock at the foot. Composed from the merged pieces: RoomTile, ListenerRow, RoomAlert, RoomStatusPill, RecordDock and NotesRail. The page never scrolls in the live phase. The host and the phone form follow in a later slice.\n\n**Motion.** None yet. Later: the level ring animates, and the new note settles into the list.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RoomView>;

const dockNames = (root: HTMLElement) =>
  within(root.querySelector<HTMLElement>(".sys-dock") ?? root)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

const tileCount = (root: HTMLElement) =>
  root.querySelectorAll(".sys-room-tile").length;

const alertRows = (root: HTMLElement) =>
  root.querySelectorAll(".sys-room-alert-live .sys-status").length;

export const GuestWaiting: Story = {
  args: {
    people: [HOST, JON_YOU],
    phase: WAITING,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Waiting for Maya to start"),
    ).toBeInTheDocument();
    await expect(tileCount(canvasElement)).toBe(2);
    await expect(dockNames(canvasElement)).toEqual([
      "Mute",
      "Notes",
      "Leave room",
    ]);
    await expect(alertRows(canvasElement)).toBe(0);
  },
};

export const GuestLive: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("12:04 · Take 1"),
    ).toBeInTheDocument();
    await expect(tileCount(canvasElement)).toBe(3);
    await expect(dockNames(canvasElement)).toEqual([
      "Mute",
      "Comment",
      "Notes",
      "Leave room",
    ]);
    await expect(alertRows(canvasElement)).toBe(0);
  },
};

export const GuestLiveMuted: Story = {
  args: {
    muted: true,
    people: [HOST, { ...JON_YOU, muted: true, level: 0.6 }, ANNEKE_GUEST],
  },
  play: async ({ canvasElement }) => {
    await expect(dockNames(canvasElement)).toEqual([
      "Unmute",
      "Comment",
      "Notes",
      "Leave room",
    ]);
    await expect(
      within(canvasElement).getByRole("group", { name: /Jon, muted/ }),
    ).toBeInTheDocument();
  },
};

export const GuestMicLost: Story = {
  args: {
    alerts: [{ kind: "mic-lost", onAction: fn() }],
    people: [HOST, { ...JON_YOU, alert: true, level: 0 }, ANNEKE_GUEST],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Your mic stopped.")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Reconnect mic" }),
    ).toBeInTheDocument();
    await expect(alertRows(canvasElement)).toBe(1);
  },
};

export const GuestHostOffline: Story = {
  args: {
    people: [
      { ...HOST, connection: "lost", speaking: false, level: 0 },
      JON_YOU,
      ANNEKE_GUEST,
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        "Maya Okafor dropped. You're still recording on this device.",
      ),
    ).toBeInTheDocument();
    await expect(canvas.getByText("Reconnecting…")).toBeInTheDocument();
    await expect(alertRows(canvasElement)).toBe(1);
  },
};

export const GuestPaused: Story = {
  args: {
    phase: { kind: "paused", clockSec: 1230 },
    defaultNotesOpen: true,
    notes: NOTES,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Paused · 20:30")).toBeInTheDocument();
    await expect(
      canvas.getByText("Paused. Notes land at the pause."),
    ).toBeInTheDocument();
    await expect(dockNames(canvasElement)).toEqual([
      "Mute",
      "Comment",
      "Notes",
      "Leave room",
    ]);
  },
};

export const GuestLiveFourPeople: Story = {
  args: {
    people: [HOST, JON_YOU, ANNEKE_GUEST, JOSS_GUEST, ROSA_PRODUCER],
  },
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(4);
    await expect(
      within(canvasElement).getByText("Rosa Diaz, listening"),
    ).toBeInTheDocument();
  },
};

export const ProducerWaiting: Story = {
  args: {
    seat: "producer",
    people: [HOST, JON_YOU, ANNEKE_GUEST, ROSA_YOU],
    phase: WAITING,
    selfName: "Rosa Diaz",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("You, listening")).toBeInTheDocument();
    await expect(
      canvas.getByText("No notes yet. Notes pin to the recording time."),
    ).toBeInTheDocument();
    await expect(tileCount(canvasElement)).toBe(3);
    await expect(dockNames(canvasElement)).toEqual(["Notes", "Leave room"]);
  },
};

export const ProducerLive: Story = {
  args: {
    seat: "producer",
    people: [HOST, JON_YOU, ANNEKE_GUEST, ROSA_YOU],
    notes: NOTES,
    selfName: "Rosa Diaz",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("12:04 · Take 1")).toBeInTheDocument();
    await expect(
      canvas.getByText("Jon's mic drops out here."),
    ).toBeInTheDocument();
    await expect(dockNames(canvasElement)).toEqual([
      "Comment",
      "Notes",
      "Leave room",
    ]);
  },
};
