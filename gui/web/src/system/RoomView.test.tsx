import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SRC_ROOT } from "../test/sourceFiles";
import type { NoteItem } from "./notesRailModel";
import { RoomView, type RoomViewProps } from "./RoomView";
import type { RoomPerson } from "./roomViewModel";

const JON: RoomPerson = {
  role: "guest",
  person: { name: "Jon", colorIndex: 3 },
  you: true,
  presence: "live",
};
const HOST: RoomPerson = {
  role: "host",
  person: { name: "Maya Okafor", colorIndex: 0 },
  presence: "live",
};
const ROSA: RoomPerson = {
  role: "producer",
  person: { name: "Rosa Diaz", colorIndex: 2 },
  you: true,
  presence: "live",
};
const LIVE = { kind: "live", take: 1, clockSec: 724 } as const;

const renderRoom = (rest: Partial<RoomViewProps> = {}) => {
  const onSendNote = vi.fn();
  const props: RoomViewProps = {
    seat: "guest",
    title: "Episode 14",
    people: [HOST, JON],
    phase: LIVE,
    notes: [] as NoteItem[],
    selfName: "Jon",
    onSendNote,
    ...rest,
  };
  const view = render(<RoomView {...props} />);
  return { onSendNote, ...view };
};

const names = () =>
  within(document.querySelector(".sys-dock") as HTMLElement)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));

describe("RoomView", () => {
  it("shows the target slot in the header, full and embedded", () => {
    const { rerender } = renderRoom({
      target: <span>Starts the episode</span>,
    });
    expect(
      within(screen.getByRole("banner")).getByText("Starts the episode"),
    ).toBeVisible();
    rerender(
      <RoomView
        seat="guest"
        title="Episode 14"
        people={[HOST, JON]}
        phase={LIVE}
        notes={[]}
        selfName="Jon"
        onSendNote={vi.fn()}
        target={<span>Starts the episode</span>}
        embedded
      />,
    );
    expect(screen.getByText("Starts the episode")).toBeVisible();
  });

  it("prints the title as the one h1 and keeps one main landmark", () => {
    renderRoom();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Episode 14",
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("opens the device sheet from the viewer's own tile only", async () => {
    const onSelfPress = vi.fn();
    renderRoom({ onSelfPress });
    const presses = screen.getAllByRole("button", { name: "Devices" });
    expect(presses).toHaveLength(1);
    const tile = presses[0].closest(".sys-room-tile");
    expect(tile).toHaveTextContent("Jon");
    await userEvent.click(presses[0]);
    expect(onSelfPress).toHaveBeenCalledTimes(1);
  });

  it("draws no press target without a handler", () => {
    renderRoom();
    expect(screen.queryByRole("button", { name: "Devices" })).toBeNull();
  });

  it("shows the status pill and the one live alert row", () => {
    renderRoom({
      alerts: [{ kind: "mic-lost", onAction: vi.fn() }],
    });
    expect(screen.getByText("12:04 · Take 1")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(
      document.querySelectorAll(".sys-room-alert-live .sys-status"),
    ).toHaveLength(1);
  });

  it("a guest's Notes rail starts closed and the Notes button opens it", async () => {
    renderRoom();
    expect(screen.queryByLabelText("Add a note")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.getByLabelText("Add a note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("a producer's rail starts open and hides Everyone until visibility is on", () => {
    const { unmount } = renderRoom({
      seat: "producer",
      people: [HOST, JON, ROSA],
      selfName: "Rosa Diaz",
    });
    expect(screen.getByLabelText("Add a note")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Everyone" })).toBeNull();
    unmount();
    renderRoom({
      seat: "producer",
      people: [HOST, JON, ROSA],
      selfName: "Rosa Diaz",
      noteVisibility: true,
    });
    expect(
      screen.getByRole("button", { name: "Everyone" }),
    ).toBeInTheDocument();
  });

  it("the host keeps Everyone, and noteVisibility false hides it", () => {
    const host: Partial<RoomViewProps> = {
      seat: "host",
      people: [{ ...HOST, you: true }],
    };
    const { unmount } = renderRoom({ ...host, defaultNotesOpen: true });
    expect(
      screen.getByRole("button", { name: "Everyone" }),
    ).toBeInTheDocument();
    unmount();
    renderRoom({ ...host, defaultNotesOpen: true, noteVisibility: false });
    expect(screen.queryByRole("button", { name: "Everyone" })).toBeNull();
  });

  it("disables the composer with the reason and sends nothing", async () => {
    const { onSendNote } = renderRoom({
      defaultNotesOpen: true,
      notesDisabledReason: "Notes open when the take starts.",
    });
    expect(screen.getByLabelText("Add a note")).toBeDisabled();
    expect(screen.getByText("Notes open when the take starts.")).toBeVisible();
    const send = screen.getByRole("button", { name: "Send note" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(send);
    expect(onSendNote).not.toHaveBeenCalled();
  });

  it("keeps two guests with one name as two tiles", () => {
    const twin = (id: string): RoomPerson => ({
      id,
      role: "guest",
      person: { name: "Guest", colorIndex: 1 },
      presence: "live",
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderRoom({ people: [HOST, twin("p_1"), twin("p_2")] });
    expect(document.querySelectorAll(".sys-room-tile")).toHaveLength(3);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("reads a guest's own upload percent in the pill and the dock", () => {
    renderRoom({
      phase: { kind: "saving", savedPeople: 1, totalPeople: 3, percent: 64.4 },
    });
    expect(
      document.querySelector(".sys-pill, .sys-status-pill"),
    ).toHaveTextContent("Saving · 64%");
    expect(
      screen.getByText("Saving · 64% · keep this page open"),
    ).toBeVisible();
  });

  it("fills a bare page and clears the notch only when asked", () => {
    const { container, unmount } = renderRoom({ page: true });
    expect(container.querySelector(".sys-room-view")).toHaveAttribute(
      "data-page",
    );
    unmount();
    expect(renderRoom().container.querySelector("[data-page]")).toBeNull();
    const css = readFileSync(
      join(SRC_ROOT, "styles/partials/system-record.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.sys-room-view\[data-page\] \{\s*block-size: 100dvh;\s*padding-block-start: env\(safe-area-inset-top\);/,
    );
    expect(css).toMatch(
      /padding-block-end: max\(var\(--space-3\), env\(safe-area-inset-bottom\)\);\s*overflow-y: auto;/,
    );
  });

  it("a guest gets no Everyone toggle", async () => {
    renderRoom();
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.queryByRole("button", { name: "Everyone" })).toBeNull();
  });

  it("sends the draft with the live clock time, and a cleared chip sends a session note", async () => {
    const { onSendNote } = renderRoom({
      seat: "producer",
      people: [HOST, ROSA],
    });
    const field = screen.getByLabelText("Add a note");
    await userEvent.type(field, "Start with the cold open");
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
    expect(onSendNote).toHaveBeenLastCalledWith({
      text: "Start with the cold open",
      time: "12:04",
      everyone: false,
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: "12:04, clear time to make this a session note",
      }),
    );
    await userEvent.type(field, "Session note");
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
    expect(onSendNote).toHaveBeenLastCalledWith({
      text: "Session note",
      time: null,
      everyone: false,
    });
  });

  it("the dock shows the seat's controls and hides Comment while waiting", () => {
    const { rerender } = render(
      <RoomView
        seat="guest"
        title="Episode 14"
        people={[HOST, JON]}
        phase={{ kind: "waiting", host: "Maya" }}
        notes={[]}
        selfName="Jon"
        onSendNote={vi.fn()}
      />,
    );
    expect(names()).toEqual(["Mute", "Notes", "Leave room"]);
    rerender(
      <RoomView
        seat="guest"
        title="Episode 14"
        people={[HOST, JON]}
        phase={LIVE}
        notes={[]}
        selfName="Jon"
        onSendNote={vi.fn()}
      />,
    );
    expect(names()).toEqual(["Mute", "Comment", "Notes", "Leave room"]);
  });

  it("lists the producer as listening, with You for the viewer", () => {
    renderRoom({
      seat: "producer",
      people: [HOST, JON, ROSA],
      selfName: "Rosa Diaz",
    });
    expect(screen.getByText("You, listening")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Listening" })).toBeInTheDocument();
  });

  it("shows no Invite button for a host without an invite handler", () => {
    renderRoom({ seat: "host", people: [HOST], onInvite: undefined });
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
  });

  it("the cleared time chip stays cleared until the phase changes", async () => {
    const { rerender, onSendNote } = renderRoom({
      seat: "producer",
      people: [HOST, ROSA],
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: "12:04, clear time to make this a session note",
      }),
    );
    rerender(
      <RoomView
        seat="producer"
        title="Episode 14"
        people={[HOST, ROSA]}
        phase={{ kind: "live", take: 1, clockSec: 730 }}
        notes={[]}
        selfName="Rosa Diaz"
        onSendNote={onSendNote}
      />,
    );
    expect(screen.queryByRole("button", { name: /clear time/ })).toBeNull();
    rerender(
      <RoomView
        seat="producer"
        title="Episode 14"
        people={[HOST, ROSA]}
        phase={{ kind: "live", take: 2, clockSec: 10 }}
        notes={[]}
        selfName="Rosa Diaz"
        onSendNote={onSendNote}
      />,
    );
    expect(
      screen.getByRole("button", { name: /0:10, clear time/ }),
    ).toBeInTheDocument();
  });
});

const HOST_YOU: RoomPerson = { ...HOST, you: true };
const NOTES: NoteItem[] = [
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
    visibility: "everyone",
  },
];

describe("RoomView on a phone", () => {
  it("shows the latest note as one peek line and no rail", () => {
    renderRoom({ viewerWidth: "phone", notes: NOTES });
    const peek = document.querySelector(".sys-room-view-peek") as HTMLElement;
    expect(peek).toHaveTextContent("Rosa Diaz: Lift Jon before the break.");
    expect(peek).toHaveTextContent("12:06");
    expect(document.querySelector(".sys-room-view-rail")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says there are no notes yet when the list is empty", () => {
    renderRoom({ viewerWidth: "phone" });
    expect(document.querySelector(".sys-room-view-peek")).toHaveTextContent(
      "No notes yet",
    );
  });

  it("the peek line opens the notes sheet", async () => {
    renderRoom({ viewerWidth: "phone", notes: NOTES });
    const peek = document.querySelector(".sys-room-view-peek") as HTMLElement;
    expect(peek).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(peek);
    expect(screen.getByRole("dialog", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByLabelText("Add a note")).toBeInTheDocument();
  });

  it("the dock's Notes button opens the sheet and shows it pressed", async () => {
    renderRoom({ viewerWidth: "phone", notes: NOTES });
    const button = screen.getByRole("button", { name: "Notes" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Notes" })).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("sends a note from the sheet with the live clock time", async () => {
    const { onSendNote } = renderRoom({ viewerWidth: "phone" });
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    const dialog = await screen.findByRole("dialog", { name: "Notes" });
    // The sheet moves focus to Close on the next frame; typing before that loses the field.
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Close" }),
      ).toHaveFocus(),
    );
    await userEvent.type(
      within(dialog).getByLabelText("Add a note"),
      "From the sheet",
    );
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Send note" }),
    );
    expect(onSendNote).toHaveBeenCalledWith({
      text: "From the sheet",
      time: "12:04",
      everyone: false,
    });
  });

  it("keeps the same dock buttons as the desktop for the seat", () => {
    renderRoom({ viewerWidth: "phone" });
    expect(names()).toEqual(["Mute", "Comment", "Notes", "Leave room"]);
  });

  it("has no peek line and no rail in landscape, and the Notes button still opens the sheet", async () => {
    renderRoom({ viewerWidth: "phone-landscape", notes: NOTES });
    expect(document.querySelector(".sys-room-view-peek")).toBeNull();
    expect(document.querySelector(".sys-room-view")).toHaveAttribute(
      "data-width",
      "phone-landscape",
    );
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.getByRole("dialog", { name: "Notes" })).toBeInTheDocument();
  });

  it("renders no sheet on the desktop", () => {
    renderRoom({ notes: NOTES });
    expect(document.querySelector(".sys-room-view-peek")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("RoomView as the host", () => {
  const hostRoom = (rest: Partial<RoomViewProps> = {}) =>
    renderRoom({
      seat: "host",
      people: [HOST_YOU],
      selfName: "Maya Okafor",
      phase: { kind: "waiting" },
      onInvite: vi.fn(),
      onStartTake: vi.fn(),
      onStopTake: vi.fn(),
      ...rest,
    });

  it("shows the host's dock with Record and fills the empty seats with Invite tiles", () => {
    hostRoom();
    expect(names()).toEqual(["Mute", "Record", "Notes", "More"]);
    expect(screen.getAllByRole("button", { name: "Invite" })).toHaveLength(3);
  });

  it("shows no Record button when the host has no take handlers", () => {
    hostRoom({ onStartTake: undefined, onStopTake: undefined });
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
  });

  it("shows the Record button when the host has take handlers", () => {
    hostRoom();
    expect(screen.getByRole("button", { name: "Record" })).toBeEnabled();
  });

  it("disables Record while the room reconnects", () => {
    hostRoom({ phase: { kind: "reconnecting" } });
    const record = screen.getByRole("button", { name: "Record" });
    expect(record).toBeDisabled();
    expect(record).toHaveAttribute("title", "Reconnecting");
  });

  it("starts a take from the Record button", async () => {
    const onStartTake = vi.fn();
    hostRoom({ onStartTake });
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(onStartTake).toHaveBeenCalledTimes(1);
  });

  it("disables Record with the reason while a guest is joining", () => {
    hostRoom({
      people: [
        HOST_YOU,
        {
          role: "guest",
          person: { name: "Jon", colorIndex: 3 },
          presence: "joining",
        },
      ],
    });
    const record = screen.getByRole("button", { name: "Record" });
    expect(record).toBeDisabled();
    expect(record).toHaveAttribute("title", "Waiting for Jon to join");
  });

  it("shows Stop take and Pause while live, and Resume while paused", () => {
    const { rerender } = hostRoom({ phase: LIVE });
    expect(names()).toEqual([
      "Mute",
      "Comment",
      "Stop take",
      "Pause take",
      "Notes",
      "More",
    ]);
    rerender(
      <RoomView
        seat="host"
        title="Episode 14"
        people={[HOST_YOU]}
        phase={{ kind: "paused", clockSec: 800 }}
        notes={[]}
        selfName="Maya Okafor"
        onSendNote={vi.fn()}
        onStartTake={vi.fn()}
        onStopTake={vi.fn()}
      />,
    );
    expect(names()).toContain("Resume recording");
  });

  it("swaps the dock controls for the saving line after Stop", () => {
    hostRoom({ phase: { kind: "saving", savedPeople: 1, totalPeople: 3 } });
    expect(
      screen.getByText("Saving · 1 of 3 · keep this page open"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
  });

  it("holds a guest's Leave back while their recording saves", () => {
    renderRoom({ phase: { kind: "saving", savedPeople: 1, totalPeople: 3 } });
    const leave = screen.getByRole("button", { name: "Leave room" });
    expect(leave).toBeDisabled();
    expect(leave).toHaveAttribute("title", "Your recording is still saving");
  });

  it("lets a guest leave once saving has failed, with no saving line", () => {
    renderRoom({
      phase: { kind: "saving", savedPeople: 0, totalPeople: 1, failed: true },
    });
    expect(screen.getByRole("button", { name: "Leave room" })).toBeEnabled();
    expect(screen.getByText("Saving stopped")).toBeInTheDocument();
    expect(screen.queryByText(/keep this page open/)).toBeNull();
  });

  describe("declined", () => {
    it("shows the peek bar, dims the room and leaves it inert", () => {
      const { container } = renderRoom({
        phase: { kind: "waiting", host: "Maya" },
        declined: { onJoin: vi.fn() },
      });
      expect(screen.getByText("You're not being recorded.")).toBeVisible();
      expect(container.querySelector("[data-declined]")).not.toBeNull();
      expect(container.querySelector(".sys-room-view-body")).toHaveAttribute(
        "inert",
      );
      expect(container.querySelector(".sys-room-view-dock")).toHaveAttribute(
        "inert",
      );
    });

    it("calls onJoin from Join recording when the room is waiting", async () => {
      const onJoin = vi.fn();
      renderRoom({
        phase: { kind: "waiting", host: "Maya" },
        declined: { onJoin },
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Join recording" }),
      );
      expect(onJoin).toHaveBeenCalledOnce();
    });

    it.each([LIVE, { kind: "paused", clockSec: 30 }] as const)(
      "holds Join recording during a %j take with the reason",
      (phase) => {
        renderRoom({ phase, declined: { onJoin: vi.fn() } });
        expect(
          screen.getByRole("button", { name: "Join recording" }),
        ).toBeDisabled();
        expect(screen.getByText("You can join after this take.")).toBeVisible();
      },
    );

    it.each([
      [{ kind: "countdown", secondsLeft: 3 }, "You can join after this take."],
      [
        { kind: "saving", savedPeople: 1, totalPeople: 2 },
        "You can join after this take.",
      ],
      [{ kind: "reconnecting" }, "You can join once the room reconnects."],
    ] as const)("holds Join recording during %j", (phase, reason) => {
      renderRoom({ phase, declined: { onJoin: vi.fn() } });
      expect(
        screen.getByRole("button", { name: "Join recording" }),
      ).toBeDisabled();
      expect(screen.getByText(reason)).toBeVisible();
    });

    it("points the held Join recording at its visible reason", () => {
      renderRoom({ declined: { onJoin: vi.fn() } });
      expect(
        screen.getByRole("button", { name: "Join recording" }),
      ).toHaveAccessibleDescription("You can join after this take.");
    });

    it("moves focus from the dock to Join recording when it works", () => {
      const waiting = { kind: "waiting", host: "Maya" } as const;
      const { rerender, container } = renderRoom({ phase: waiting });
      screen.getByRole("button", { name: "Mute" }).focus();
      rerender(
        <RoomView
          seat="guest"
          title="Episode 14"
          people={[HOST, JON]}
          phase={waiting}
          notes={[]}
          selfName="Jon"
          onSendNote={vi.fn()}
          declined={{ onJoin: vi.fn() }}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Join recording" }),
      ).toHaveFocus();
      expect(container.querySelector(".sys-room-view-dock")).toHaveAttribute(
        "inert",
      );
    });

    it("focuses the bar itself while Join recording is held", () => {
      renderRoom({ declined: { onJoin: vi.fn() } });
      expect(
        screen.getByRole("region", { name: "Not being recorded" }),
      ).toHaveFocus();
    });

    it("closes the phone Notes sheet when the viewer declines", async () => {
      const props: RoomViewProps = {
        seat: "guest",
        title: "Episode 14",
        people: [HOST, JON],
        phase: LIVE,
        notes: [],
        selfName: "Jon",
        onSendNote: vi.fn(),
        viewerWidth: "phone",
      };
      const { rerender } = render(<RoomView {...props} />);
      await userEvent.click(screen.getByRole("button", { name: "Notes" }));
      expect(
        await screen.findByRole("dialog", { name: "Notes" }),
      ).toBeInTheDocument();
      rerender(<RoomView {...props} declined={{ onJoin: vi.fn() }} />);
      expect(screen.queryByRole("dialog", { name: "Notes" })).toBeNull();
    });

    it("adds nothing to a room that has not declined", () => {
      const { container } = renderRoom();
      expect(container.querySelector(".sys-declined")).toBeNull();
      expect(container.querySelector("[inert]")).toBeNull();
    });
  });

  describe("embedded in a stage shell", () => {
    it("drops its own h1, main and footer, and keeps the status pill and dock", () => {
      renderRoom({
        seat: "host",
        people: [{ ...HOST, you: true }],
        embedded: true,
      });
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
      expect(screen.queryByRole("main")).toBeNull();
      expect(screen.queryByRole("contentinfo")).toBeNull();
      expect(screen.getByRole("region", { name: "Episode 14" })).toBeVisible();
      expect(
        screen.getByRole("group", { name: "Recording controls" }),
      ).toBeVisible();
      expect(document.querySelector(".sys-pill")).not.toBeNull();
    });

    it("carries a Record reason of the caller over the model's", () => {
      renderRoom({
        seat: "host",
        people: [{ ...HOST, you: true }],
        embedded: true,
        onStartTake: vi.fn(),
        onStopTake: vi.fn(),
        phase: { kind: "waiting" },
        recordDisabledReason: "Joining the room.",
      });
      expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute(
        "title",
        "Joining the room.",
      );
    });

    it("pairs Notes with a Takes tab when takes are given", async () => {
      const user = userEvent.setup();
      renderRoom({
        seat: "host",
        people: [{ ...HOST, you: true }],
        embedded: true,
        defaultNotesOpen: true,
        takes: <p>take list</p>,
      });
      expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await user.click(screen.getByRole("tab", { name: "Takes" }));
      expect(screen.getByRole("tabpanel")).toHaveTextContent("take list");
    });
  });
});
