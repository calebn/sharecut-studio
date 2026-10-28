import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { openDialogByLauncher } from "../test/storyDialog";
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
const MAYA_YOU: RoomPerson = { ...HOST, you: true };
const JON_JOINING: RoomPerson = {
  role: "guest",
  person: JON,
  presence: "joining",
};
const ANNEKE_SAVING = (done: number): RoomPerson => ({
  ...ANNEKE_GUEST,
  saving: { done, total: 10 },
});
const SAVED_GUESTS: RoomPerson[] = [
  { ...JON_YOU, you: false, saving: "saved" },
  { ...ANNEKE_GUEST, saving: "saved" },
];

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
    onStartTake: fn(),
    onStopTake: fn(),
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
          'The Record room for every seat: a 48 px header with the wordmark, the session title and the status pill; the record alert slot (0 or 44 px); the person tile grid with the listener row; the Notes rail, 320 px beside the grid and open by default for a producer; and the dock at the foot. Composed from the merged pieces: RoomTile, ListenerRow, RoomAlert, RoomStatusPill, RecordDock and NotesRail. The page never scrolls in the live phase. The host seat adds the Record button, Invite tiles for the empty seats and the saving line after Stop. The phone form puts the tiles in a square 2x2 grid, a Notes peek line (the latest note, one line) above the dock, and the Notes rail in a bottom Sheet; a landscape phone puts the tiles in one row with the dock as a vertical bar on the right edge.\n\nNotes can be held with a reason (`notesDisabledReason`), the Everyone toggle shows for a producer only with `noteVisibility`, a saving phase may carry a `percent` for the upload, tiles key on `RoomPerson.id`, and `page` makes a bare page fill 100dvh.\n\nThe Declined phase (`declined`) dims the tiles to 40% under a light scrim and docks a 72 px peek bar: "You\'re not being recorded." and Join recording, held with "You can join after this take." until the room is waiting again; the rest of the room goes inert.\n\n**Motion.** None yet. Later: the level ring animates, the new note settles into the list, and the Declined scrim fades in with `--motion-state`.',
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

export const GuestSaving: Story = {
  args: {
    phase: { kind: "saving", savedPeople: 1, totalPeople: 3, percent: 64 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Saving · 64%")).toBeInTheDocument();
    await expect(
      canvas.getByText("Saving · 64% · keep this page open"),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Leave room" }),
    ).toBeDisabled();
  },
};

export const GuestNotesClosed: Story = {
  args: {
    phase: WAITING,
    defaultNotesOpen: true,
    notesDisabledReason: "Notes open when the take starts.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Add a note")).toBeDisabled();
    await expect(
      canvas.getByText("Notes open when the take starts."),
    ).toBeVisible();
  },
};

export const GuestSameName: Story = {
  args: {
    people: [
      HOST,
      { ...JON_YOU, id: "p_1" },
      { ...ANNEKE_GUEST, id: "p_2", person: JON },
      { ...JOSS_GUEST, id: "p_3", person: JON },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(4);
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
    await expect(
      canvas.queryByRole("button", { name: "Everyone" }),
    ).not.toBeInTheDocument();
    await expect(dockNames(canvasElement)).toEqual([
      "Comment",
      "Notes",
      "Leave room",
    ]);
  },
};

const hostDock = (root: HTMLElement) =>
  dockNames(root).filter((name) => !name?.startsWith("Notes"));

const peekText = (root: HTMLElement) =>
  root.querySelector(".sys-room-view-peek")?.textContent ?? "";

const phone = {
  viewerWidth: "phone",
  notes: NOTES,
} as const;

const landscapeFrame = (Story: () => ReactElement) => (
  <div style={{ blockSize: "24rem", inlineSize: "46rem" }}>
    <Story />
  </div>
);

const landscapeParameters = {
  ...viewportStoryParameters,
  wideOnlyReason:
    "The landscape phone layout needs more than 360 px of width for four tiles beside the dock bar.",
} as const;

export const GuestWaitingPhone: Story = {
  args: { ...phone, people: [HOST, JON_YOU], phase: WAITING, notes: [] },
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(2);
    await expect(peekText(canvasElement)).toContain("No notes yet");
    await expect(dockNames(canvasElement)).toEqual([
      "Mute",
      "Notes",
      "Leave room",
    ]);
  },
};

export const GuestLivePhone: Story = {
  args: {
    ...phone,
    people: [HOST, JON_YOU, ANNEKE_GUEST, ROSA_PRODUCER],
  },
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(3);
    await expect(canvasElement.querySelector(".sys-room-view-rail")).toBeNull();
    await expect(peekText(canvasElement)).toContain(
      "Jon: My own note, kept for me.",
    );
    await expect(dockNames(canvasElement)).toEqual([
      "Mute",
      "Comment",
      "Notes",
      "Leave room",
    ]);
  },
};

export const GuestLivePhoneNotesSheet: Story = {
  args: { ...phone, people: [HOST, JON_YOU, ANNEKE_GUEST] },
  parameters: isolatedStoryParameters,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogByLauncher(canvasElement, {
      launcherName: "Notes",
      dialogName: "Notes",
    });
    await expect(
      within(dialog).getByText("Jon's mic drops out here."),
    ).toBeVisible();
    await expect(
      within(dialog).getAllByRole("button", { name: "Send note" }),
    ).toHaveLength(1);
  },
};

export const ProducerPhone: Story = {
  args: {
    ...phone,
    seat: "producer",
    people: [HOST, JON_YOU, ANNEKE_GUEST, ROSA_YOU],
    selfName: "Rosa Diaz",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("You, listening")).toBeInTheDocument();
    await expect(tileCount(canvasElement)).toBe(3);
    await expect(peekText(canvasElement)).toContain(
      "Jon: My own note, kept for me.",
    );
    await expect(dockNames(canvasElement)).toEqual([
      "Comment",
      "Notes",
      "Leave room",
    ]);
  },
};

export const GuestLandscape: Story = {
  args: {
    viewerWidth: "phone-landscape",
    notes: NOTES,
    people: [HOST, JON_YOU, ANNEKE_GUEST, JOSS_GUEST],
  },
  tags: ["wide-only"],
  parameters: landscapeParameters,
  decorators: [landscapeFrame],
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(4);
    await expect(canvasElement.querySelector(".sys-room-view-peek")).toBeNull();
    await expect(dockNames(canvasElement)).toEqual([
      "Mute",
      "Comment",
      "Notes",
      "Leave room",
    ]);
  },
};

export const HostEmpty: Story = {
  args: {
    seat: "host",
    people: [MAYA_YOU],
    phase: { kind: "waiting" },
    selfName: "Maya Okafor",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("button", { name: "Invite" }),
    ).toHaveLength(3);
    await expect(tileCount(canvasElement)).toBe(4);
    await expect(canvas.getByRole("button", { name: "Record" })).toBeEnabled();
    await expect(hostDock(canvasElement)).toEqual(["Mute", "Record", "More"]);
  },
};

export const HostWaitingTwoGuests: Story = {
  args: {
    seat: "host",
    people: [MAYA_YOU, JON_YOU, ANNEKE_GUEST],
    phase: { kind: "waiting" },
    selfName: "Maya Okafor",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("button", { name: "Invite" }),
    ).toHaveLength(1);
    await expect(canvas.getByRole("button", { name: "Record" })).toBeEnabled();
    await expect(
      canvas.queryByRole("button", { name: "Comment" }),
    ).not.toBeInTheDocument();
  },
};

export const HostWaitingConsentPending: Story = {
  args: {
    seat: "host",
    people: [MAYA_YOU, JON_JOINING, ANNEKE_GUEST],
    phase: { kind: "waiting" },
    selfName: "Maya Okafor",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Joining…")).toBeInTheDocument();
    const record = canvas.getByRole("button", { name: "Record" });
    await expect(record).toBeDisabled();
    await expect(record).toHaveAttribute("title", "Waiting for Jon to join");
  },
};

export const HostCountdown: Story = {
  args: {
    seat: "host",
    people: [MAYA_YOU, JON_YOU, ANNEKE_GUEST],
    phase: { kind: "countdown", secondsLeft: 3 },
    selfName: "Maya Okafor",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Quiet please · 3"),
    ).toBeInTheDocument();
  },
};

export const HostLive: Story = {
  args: {
    seat: "host",
    people: [MAYA_YOU, JON_YOU, ANNEKE_GUEST, JOSS_GUEST],
    selfName: "Maya Okafor",
    unreadNotes: 2,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("12:04 · Take 1")).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Invite" }),
    ).not.toBeInTheDocument();
    await expect(hostDock(canvasElement)).toEqual([
      "Mute",
      "Comment",
      "Stop take",
      "Pause take",
      "More",
    ]);
  },
};

export const HostLiveNotesOpen: Story = {
  args: {
    seat: "host",
    people: [MAYA_YOU, JON_YOU, ANNEKE_GUEST],
    selfName: "Maya Okafor",
    defaultNotesOpen: true,
    notes: NOTES,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Lift Jon before the break."),
    ).toBeInTheDocument();
    await expect(
      within(canvasElement).getByRole("button", { name: "Everyone" }),
    ).toBeInTheDocument();
  },
};

export const HostPaused: Story = {
  args: {
    seat: "host",
    people: [MAYA_YOU, JON_YOU, ANNEKE_GUEST],
    phase: { kind: "paused", clockSec: 1230 },
    selfName: "Maya Okafor",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Paused · 20:30")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Resume recording" }),
    ).toBeInTheDocument();
  },
};

export const HostSaving: Story = {
  args: {
    seat: "host",
    people: [
      { ...MAYA_YOU, saving: "saved" },
      { ...JON_YOU, saving: { done: 10, total: 10 } },
      ANNEKE_SAVING(4),
    ],
    phase: { kind: "saving", savedPeople: 1, totalPeople: 3 },
    selfName: "Maya Okafor",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Saving · 1 of 3")).toBeInTheDocument();
    await expect(
      canvas.getByText("Saving · 1 of 3 · keep this page open"),
    ).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Record" }),
    ).not.toBeInTheDocument();
  },
};

export const HostSaved: Story = {
  args: {
    seat: "host",
    people: [{ ...MAYA_YOU, saving: "saved" }, ...SAVED_GUESTS],
    phase: { kind: "saved" },
    selfName: "Maya Okafor",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Saved").length).toBeGreaterThan(0);
    await expect(canvas.getByRole("button", { name: "Record" })).toBeEnabled();
  },
};

export const HostSolo: Story = {
  args: {
    seat: "host",
    people: [MAYA_YOU],
    selfName: "Maya Okafor",
    onInvite: undefined,
  },
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(1);
    await expect(
      within(canvasElement).queryByRole("button", { name: "Invite" }),
    ).not.toBeInTheDocument();
    await expect(hostDock(canvasElement)).toContain("Stop take");
  },
};

export const HostPhone: Story = {
  args: {
    ...phone,
    seat: "host",
    people: [MAYA_YOU, JON_YOU],
    phase: { kind: "waiting" },
    selfName: "Maya Okafor",
    notes: [],
  },
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(4);
    await expect(
      within(canvasElement).getAllByRole("button", { name: "Invite" }),
    ).toHaveLength(2);
    await expect(hostDock(canvasElement)).toEqual(["Mute", "Record", "More"]);
  },
};

export const HostPhoneLive: Story = {
  args: {
    ...phone,
    seat: "host",
    people: [MAYA_YOU, JON_YOU, ANNEKE_GUEST, JOSS_GUEST],
    selfName: "Maya Okafor",
  },
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(4);
    await expect(peekText(canvasElement)).toContain(
      "Jon: My own note, kept for me.",
    );
    await expect(hostDock(canvasElement)).toEqual([
      "Mute",
      "Comment",
      "Stop take",
      "Pause take",
      "More",
    ]);
  },
};

export const HostPhoneNotesSheet: Story = {
  args: {
    ...phone,
    seat: "host",
    people: [MAYA_YOU, JON_YOU],
    selfName: "Maya Okafor",
  },
  parameters: isolatedStoryParameters,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const peek = canvasElement.querySelector<HTMLElement>(
      ".sys-room-view-peek",
    );
    await expect(peek).not.toBeNull();
    await userEvent.click(peek as HTMLElement);
    const dialog = await within(document.body).findByRole("dialog", {
      name: "Notes",
    });
    await expect(
      within(dialog).getByRole("button", { name: "Everyone" }),
    ).toBeInTheDocument();
  },
};

export const HostLandscape: Story = {
  args: {
    seat: "host",
    viewerWidth: "phone-landscape",
    notes: NOTES,
    people: [MAYA_YOU, JON_YOU, ANNEKE_GUEST],
    selfName: "Maya Okafor",
  },
  tags: ["wide-only"],
  parameters: landscapeParameters,
  decorators: [landscapeFrame],
  play: async ({ canvasElement }) => {
    await expect(tileCount(canvasElement)).toBe(4);
    await expect(
      within(canvasElement).getByRole("button", { name: "Notes" }),
    ).toBeInTheDocument();
  },
};

const DECLINED_JON: RoomPerson = { ...JON_YOU, presence: "declined" };

const declinedBar = (root: HTMLElement) =>
  within(root.querySelector<HTMLElement>(".sys-declined-bar") ?? root);

export const GuestDeclinedDuringTake: Story = {
  args: {
    people: [HOST, DECLINED_JON, ANNEKE_GUEST],
    declined: { onJoin: fn() },
  },
  play: async ({ canvasElement }) => {
    const bar = declinedBar(canvasElement);
    await expect(bar.getByText("You're not being recorded.")).toBeVisible();
    await expect(
      bar.getByRole("button", { name: "Join recording" }),
    ).toBeDisabled();
    await expect(bar.getByText("You can join after this take.")).toBeVisible();
    await expect(
      within(canvasElement).getByRole("group", { name: /Jon, declined/i }),
    ).toBeInTheDocument();
  },
};

export const GuestDeclinedCanRejoin: Story = {
  args: {
    people: [HOST, DECLINED_JON, ANNEKE_GUEST],
    phase: WAITING,
    declined: { onJoin: fn() },
  },
  play: async ({ args, canvasElement }) => {
    const join = declinedBar(canvasElement).getByRole("button", {
      name: "Join recording",
    });
    await expect(join).toBeEnabled();
    await userEvent.click(join);
    await expect(args.declined?.onJoin).toHaveBeenCalledTimes(1);
  },
};

export const GuestDeclinedPhone: Story = {
  args: {
    viewerWidth: "phone",
    people: [HOST, DECLINED_JON, ANNEKE_GUEST],
    notes: NOTES,
    declined: { onJoin: fn() },
  },
  play: async ({ canvasElement }) => {
    const bar = declinedBar(canvasElement);
    await expect(
      bar.getByRole("button", { name: "Join recording" }),
    ).toBeDisabled();
    await expect(
      canvasElement.querySelector(".sys-room-view-body"),
    ).toHaveAttribute("inert");
  },
};
