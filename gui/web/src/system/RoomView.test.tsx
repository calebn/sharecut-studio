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
