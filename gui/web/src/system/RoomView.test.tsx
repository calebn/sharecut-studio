import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
  it("prints the title as the one h1 and keeps one main landmark", () => {
    renderRoom();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Episode 14",
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
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

  it("a producer's rail starts open and has the Everyone toggle", () => {
    renderRoom({
      seat: "producer",
      people: [HOST, JON, ROSA],
      selfName: "Rosa Diaz",
    });
    expect(screen.getByLabelText("Add a note")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Everyone" }),
    ).toBeInTheDocument();
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
});
