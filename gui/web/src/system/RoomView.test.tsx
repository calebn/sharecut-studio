import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { notesNaming, readableText } from "../test/readableText";
import { SRC_ROOT } from "../test/sourceFiles";
import type { NoteItem } from "./notesRailModel";
import { RoomView, type RoomViewProps } from "./RoomView";
import type { RoomPerson } from "./roomViewModel";
import { UnreadStore } from "./useUnreadNotes";

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
    lookingIn: rest.lookingIn ?? 0,
  };
  const view = render(<RoomView {...props} />);
  return { onSendNote, ...view };
};

const names = () =>
  within(document.querySelector(".sys-dock") as HTMLElement)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));

describe("RoomView", () => {
  it("names the host's tile as the host to a guest, and only theirs", () => {
    renderRoom();
    expect(
      screen.getByRole("group", { name: "Maya Okafor, host" }),
    ).toBeVisible();
    expect(screen.getByRole("group", { name: "Jon, you" })).toBeVisible();
    expect(document.querySelectorAll(".sys-room-host")).toHaveLength(1);
  });

  it("keeps room-panel keyboard navigation after a padding click", async () => {
    renderRoom({ takes: <p>Saved take list</p>, defaultNotesOpen: true });
    await userEvent.click(screen.getByRole("tablist", { name: "Room panels" }));
    expect(screen.getByRole("tab", { name: "Comments" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Takes" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Saved take list");
  });

  it("shows the target slot in the header, full and embedded", () => {
    const { rerender } = renderRoom({
      target: <span>Starts the episode</span>,
    });
    expect(
      within(screen.getByRole("banner")).getByText("Starts the episode"),
    ).toBeVisible();
    rerender(
      <RoomView
        lookingIn={0}
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

  it("prints the session name first in the embedded header only", () => {
    const props = {
      seat: "host" as const,
      title: "Episode 14",
      sessionName: "Session 3",
      people: [HOST, JON],
      lookingIn: 0,
      phase: LIVE,
      notes: [],
      selfName: "Host",
      onSendNote: vi.fn(),
      target: <span>Starts the episode</span>,
    };
    const { rerender } = render(<RoomView {...props} embedded />);
    const name = screen.getByText("Session 3");
    expect(
      name.compareDocumentPosition(screen.getByText("Starts the episode")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    rerender(<RoomView {...props} embedded sessionName={undefined} />);
    expect(screen.queryByText("Session 3")).not.toBeInTheDocument();
    rerender(<RoomView {...props} />);
    expect(screen.queryByText("Session 3")).not.toBeInTheDocument();
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
    expect(
      document.querySelectorAll('.sys-room-alert-live[role="status"]'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll(".sys-room-alert-live .sys-status"),
    ).toHaveLength(1);
  });

  it("a guest's Comments rail starts closed and the Comments button opens it", async () => {
    renderRoom();
    expect(screen.queryByLabelText("Add a comment")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByLabelText("Add a comment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comments" })).toHaveAttribute(
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
    expect(screen.getByLabelText("Add a comment")).toBeInTheDocument();
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
      notesDisabledReason: "Comments open when the take starts.",
    });
    expect(screen.getByLabelText("Add a comment")).toBeDisabled();
    expect(
      screen.getByText("Comments open when the take starts."),
    ).toBeVisible();
    const send = screen.getByRole("button", { name: "Post" });
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
    await userEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.queryByRole("button", { name: "Everyone" })).toBeNull();
  });

  it("sends the draft with the live clock time, and a cleared chip sends a session comment", async () => {
    const { onSendNote } = renderRoom({
      seat: "producer",
      people: [HOST, ROSA],
    });
    const field = screen.getByLabelText("Add a comment");
    await userEvent.type(field, "Start with the cold open");
    await userEvent.click(screen.getByRole("button", { name: "Post" }));
    expect(onSendNote).toHaveBeenLastCalledWith({
      text: "Start with the cold open",
      time: "12:04",
      everyone: false,
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: "12:04, clear time to make this a session comment",
      }),
    );
    await userEvent.type(field, "Session comment");
    await userEvent.click(screen.getByRole("button", { name: "Post" }));
    expect(onSendNote).toHaveBeenLastCalledWith({
      text: "Session comment",
      time: null,
      everyone: false,
    });
  });

  it("keeps an unsent comment draft when the rail switches to Takes and back", async () => {
    renderRoom({
      seat: "producer",
      people: [HOST, ROSA],
      takes: <p>Take 1 saved</p>,
    });
    await userEvent.type(
      screen.getByLabelText("Add a comment"),
      "Cut the intro",
    );
    await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    expect(screen.getByText("Take 1 saved")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Comments" }));
    expect(screen.getByLabelText("Add a comment")).toHaveValue("Cut the intro");
  });

  it("the dock shows the seat's controls and hides Comment while waiting", () => {
    const { rerender } = render(
      <RoomView
        lookingIn={0}
        seat="guest"
        title="Episode 14"
        people={[HOST, JON]}
        phase={{ kind: "waiting", host: "Maya" }}
        notes={[]}
        selfName="Jon"
        onSendNote={vi.fn()}
      />,
    );
    expect(names()).toEqual(["Mute", "Comments", "Leave room"]);
    rerender(
      <RoomView
        lookingIn={0}
        seat="guest"
        title="Episode 14"
        people={[HOST, JON]}
        phase={LIVE}
        notes={[]}
        selfName="Jon"
        onSendNote={vi.fn()}
      />,
    );
    expect(names()).toEqual(["Mute", "Comment", "Comments", "Leave room"]);
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

  describe("looking in", () => {
    it.each([
      [1, "Someone with the producer link is looking in"],
      [3, "3 people with the producer link are looking in"],
    ])(
      "shows %i as the first line of the stage, under the header",
      async (lookingIn, text) => {
        const { container } = renderRoom({
          seat: "host",
          people: [HOST, JON, { ...ROSA, you: false }],
          lookingIn,
        });
        const line = screen.getByText(text);
        expect(line.tagName).toBe("P");
        expect(line.closest("ul")).toBeNull();
        expect(
          screen.getByRole("list", { name: "Listening" }),
        ).not.toContainElement(line);
        const stage = container.querySelector(".sys-room-view-stage");
        expect(stage).toContainElement(line);
        expect(stage?.firstElementChild).toBe(line);
        expect(container.querySelector("header")).not.toContainElement(line);
        expect(
          container.querySelector("header")?.compareDocumentPosition(line),
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        const glyph = line.querySelector("svg");
        expect(glyph).not.toBeNull();
        expect(glyph?.closest("[aria-hidden='true']")).not.toBeNull();
        expect(line).not.toHaveAttribute("role");
        await expectNoA11yViolations(container);
      },
    );

    it.each([-1, 2.5, 100, Number.NaN, Number.MAX_SAFE_INTEGER])(
      "shows nothing for %s",
      (lookingIn) => {
        renderRoom({ lookingIn });
        expect(document.querySelector(".sys-room-looking-in")).toBeNull();
      },
    );

    it("shows nothing for nobody, and still shows the line with no listeners", () => {
      const { rerender } = renderRoom({ people: [HOST, JON], lookingIn: 0 });
      expect(document.querySelector(".sys-room-looking-in")).toBeNull();
      rerender(
        <RoomView
          seat="guest"
          title="Episode 14"
          people={[HOST, JON]}
          phase={LIVE}
          notes={[]}
          selfName="Jon"
          onSendNote={vi.fn()}
          lookingIn={1}
        />,
      );
      expect(
        screen.getByText("Someone with the producer link is looking in"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Listening" })).toBeNull();
    });

    it("leaves the line out while the room loads", () => {
      renderRoom({ loading: true, people: [], lookingIn: 2 });
      expect(document.querySelector(".sys-room-looking-in")).toBeNull();
    });
  });

  it("shows no Invite button for a host without an invite handler", () => {
    renderRoom({ seat: "host", people: [HOST], onInvite: undefined });
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
  });

  it("keeps the draft and cleared time chip when the comment could not be sent", async () => {
    const onSendNote = vi.fn(() => false);
    renderRoom({ seat: "producer", people: [HOST, ROSA], onSendNote });
    const field = screen.getByLabelText("Add a comment");
    await userEvent.type(field, "Do not lose me");
    await userEvent.click(
      screen.getByRole("button", {
        name: "12:04, clear time to make this a session comment",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Post" }));
    expect(onSendNote).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /clear time/ })).toBeNull();
    expect(field).toHaveValue("Do not lose me");
  });

  it("the cleared time chip stays cleared until the phase changes", async () => {
    const { rerender, onSendNote } = renderRoom({
      seat: "producer",
      people: [HOST, ROSA],
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: "12:04, clear time to make this a session comment",
      }),
    );
    rerender(
      <RoomView
        lookingIn={0}
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
        lookingIn={0}
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
  it("shows the latest comment as one peek line and no rail", () => {
    renderRoom({ viewerWidth: "phone", notes: NOTES });
    const peek = document.querySelector(".sys-room-view-peek") as HTMLElement;
    expect(peek).toHaveTextContent("Rosa Diaz: Lift Jon before the break.");
    expect(peek).toHaveTextContent("12:06");
    expect(document.querySelector(".sys-room-view-rail")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says there are no comments yet when the list is empty", () => {
    renderRoom({ viewerWidth: "phone" });
    expect(document.querySelector(".sys-room-view-peek")).toHaveTextContent(
      "No comments yet",
    );
  });

  it("the peek line opens the comments sheet", async () => {
    renderRoom({ viewerWidth: "phone", notes: NOTES });
    const peek = document.querySelector(".sys-room-view-peek") as HTMLElement;
    expect(peek).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(peek);
    expect(
      screen.getByRole("dialog", { name: "Comments" }),
    ).toBeInTheDocument();
    expect(peek).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Add a comment")).toBeInTheDocument();
  });

  it("posts a comment from the sheet with the live clock time", async () => {
    const { onSendNote } = renderRoom({ viewerWidth: "phone" });
    await userEvent.click(
      document.querySelector(".sys-room-view-peek") as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "Comments" });
    // The sheet moves focus to Close on the next frame; typing before that loses the field.
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Close" }),
      ).toHaveFocus(),
    );
    await userEvent.type(
      within(dialog).getByLabelText("Add a comment"),
      "From the sheet",
    );
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Post" }),
    );
    expect(onSendNote).toHaveBeenCalledWith({
      text: "From the sheet",
      time: "12:04",
      everyone: false,
    });
  });

  it("has no peek line and no rail in landscape, and the Comments button still opens the sheet", async () => {
    renderRoom({ viewerWidth: "phone-landscape", notes: NOTES });
    expect(document.querySelector(".sys-room-view-peek")).toBeNull();
    expect(document.querySelector(".sys-room-view")).toHaveAttribute(
      "data-width",
      "phone-landscape",
    );
    await userEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(
      screen.getByRole("dialog", { name: "Comments" }),
    ).toBeInTheDocument();
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
    expect(names()).toEqual(["Mute", "Record", "Comments", "More"]);
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
    hostRoom({ phase: { kind: "reconnecting", paused: false, clockSec: 43 } });
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
      "Comments",
      "More",
    ]);
    rerender(
      <RoomView
        lookingIn={0}
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
    renderRoom({
      phase: { kind: "saving", savedPeople: 1, totalPeople: 3 },
      device: { uploading: true },
    });
    const leave = screen.getByRole("button", { name: "Leave room" });
    expect(leave).toHaveAttribute("aria-disabled", "true");
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
      [
        { kind: "reconnecting", paused: false, clockSec: 43 },
        "You can join once the room reconnects.",
      ],
    ] as const)("holds Join recording during %j", (phase, reason) => {
      renderRoom({ phase, declined: { onJoin: vi.fn() } });
      expect(
        screen.getByRole("button", { name: "Join recording" }),
      ).toBeDisabled();
      expect(screen.getByText(reason)).toBeVisible();
    });

    it("moves focus from the dock to Join recording when it works", () => {
      const waiting = { kind: "waiting", host: "Maya" } as const;
      const { rerender, container } = renderRoom({ phase: waiting });
      screen.getByRole("button", { name: "Mute" }).focus();
      rerender(
        <RoomView
          lookingIn={0}
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

    it("closes the phone Comments sheet when the viewer declines", async () => {
      const props: RoomViewProps = {
        seat: "guest",
        title: "Episode 14",
        people: [HOST, JON],
        lookingIn: 0,
        phase: LIVE,
        notes: [],
        selfName: "Jon",
        onSendNote: vi.fn(),
        viewerWidth: "phone",
      };
      const { rerender } = render(<RoomView {...props} />);
      await userEvent.click(
        document.querySelector(".sys-room-view-peek") as HTMLElement,
      );
      expect(
        await screen.findByRole("dialog", { name: "Comments" }),
      ).toBeInTheDocument();
      rerender(<RoomView {...props} declined={{ onJoin: vi.fn() }} />);
      expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    });

    it.each([
      LIVE,
      { kind: "reconnecting", paused: false, clockSec: 43 },
    ] as const)(
      "gives a producer an enabled Join to listen during %j",
      async (phase) => {
        const onJoin = vi.fn();
        renderRoom({ seat: "producer", phase, declined: { onJoin } });
        const bar = screen.getByRole("region", { name: "Not in the room" });
        expect(bar).toBeVisible();
        expect(bar.querySelector("svg.lucide-headphones")).not.toBeNull();
        const join = screen.getByRole("button", { name: "Join to listen" });
        expect(join).toBeEnabled();
        expect(join).toHaveAccessibleDescription(
          "You're not in the room yet. You won't be recorded.",
        );
        expect(
          screen.queryByRole("button", { name: "Join recording" }),
        ).toBeNull();
        expect(screen.queryByText(/You can join/)).toBeNull();
        await userEvent.click(join);
        expect(onJoin).toHaveBeenCalledOnce();
      },
    );

    it("describes a guest's held Join recording by the bar sentence and the reason", () => {
      renderRoom({ declined: { onJoin: vi.fn() } });
      expect(
        screen
          .getByRole("region", { name: "Not being recorded" })
          .querySelector("svg.lucide-mic-off"),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Join recording" }),
      ).toHaveAccessibleDescription(
        "You're not being recorded. You can join after this take.",
      );
    });

    it("leaves the status pill out until the room's snapshot is known", () => {
      const { container } = renderRoom({ statusKnown: false });
      expect(container.querySelector(".sys-pill")).toBeNull();
    });

    it("keeps the whole body inert when declined with no one looking in", () => {
      const { container } = renderRoom({
        declined: { onJoin: () => {} },
        people: [HOST, { ...JON, you: true }],
      });
      expect(container.querySelector(".sys-room-view-body")).toHaveAttribute(
        "inert",
      );
    });

    it("puts the looking-in line as the first child of the Declined bar, and nowhere else", () => {
      const { container } = renderRoom({
        declined: { onJoin: () => {} },
        people: [HOST, { ...JON, you: true }, { ...ROSA, role: "producer" }],
        lookingIn: 2,
      });
      const body = container.querySelector(
        ".sys-room-view-body",
      ) as HTMLElement;
      expect(body).toHaveAttribute("inert");
      const lines = container.querySelectorAll(
        ".sys-room-looking-in, .sys-declined-looking-in",
      );
      expect(lines).toHaveLength(1);
      const line = lines[0] as HTMLElement;
      expect(line).toHaveClass("sys-declined-looking-in");
      expect(line).toHaveTextContent(
        "2 people with the producer link are looking in",
      );
      expect(line.closest("[inert]")).toBeNull();
      expect(line.closest("[aria-hidden='true']")).toBeNull();
      expect(body).not.toContainElement(line);
      const layer = container.querySelector(".sys-declined") as HTMLElement;
      const bar = layer.querySelector(".sys-declined-bar") as HTMLElement;
      expect(bar.firstElementChild).toBe(line);
      expect(line.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(layer.children).toHaveLength(2);
    });

    it("keeps the Declined layer free of the line when nobody is looking in", () => {
      const { container } = renderRoom({
        declined: { onJoin: () => {} },
        people: [HOST, { ...JON, you: true }],
        lookingIn: 0,
      });
      const layer = container.querySelector(".sys-declined") as HTMLElement;
      expect(layer.querySelector(".sys-declined-looking-in")).toBeNull();
      expect(layer.children).toHaveLength(2);
      expect(layer.firstElementChild).toHaveClass("sys-declined-scrim");
      expect(layer.lastElementChild).toHaveClass("sys-declined-bar");
      expect(layer.lastElementChild?.firstElementChild?.tagName).toBe("svg");
    });

    it("keeps the looking-in line first in the stage when not declined", () => {
      const { container } = renderRoom({ lookingIn: 2 });
      const stage = container.querySelector(".sys-room-view-stage");
      expect(stage?.firstElementChild).toHaveClass("sys-room-looking-in");
      expect(container.querySelector("[inert]")).toBeNull();
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

    it("pairs Comments with a Takes tab when takes are given", async () => {
      const user = userEvent.setup();
      renderRoom({
        seat: "host",
        people: [{ ...HOST, you: true }],
        embedded: true,
        defaultNotesOpen: true,
        takes: <p>take list</p>,
      });
      expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await user.click(screen.getByRole("tab", { name: "Takes" }));
      expect(screen.getByRole("tabpanel")).toHaveTextContent("take list");
    });
  });

  it("focuses the title when focusTitle turns true on a loaded room", () => {
    const { rerender } = renderRoom();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).not.toHaveFocus();
    rerender(
      <RoomView
        lookingIn={0}
        seat="producer"
        title="Episode 14"
        people={[HOST, JON]}
        phase={LIVE}
        notes={[]}
        selfName="Jon"
        onSendNote={vi.fn()}
        focusTitle
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  describe("loading", () => {
    it("draws the shell with placeholders, a busy root and one status line", () => {
      const { container } = renderRoom({ loading: true, people: [] });
      expect(container.querySelector(".sys-room-view")).not.toHaveAttribute(
        "aria-busy",
      );
      expect(container.querySelector("header")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(container.querySelector(".sys-room-view-grid")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(
        container.querySelectorAll(".sys-room-tile--skeleton"),
      ).toHaveLength(4);
      expect(screen.getByText("Joining the room…")).not.toHaveAttribute("role");
      expect(
        screen.getByText("Joining the room…").closest("[aria-busy]"),
      ).not.toBeNull();
      expect(
        document.querySelectorAll('.sys-room-alert-live[role="status"]'),
      ).toHaveLength(1);
      expect(
        screen.getByRole("heading", { level: 1, name: "Episode 14" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("banner")).toBeVisible();
      expect(container.querySelector(".sys-pill")).toBeNull();
      expect(container.querySelector(".sys-room-view-rail")).toBeNull();
      expect(container.querySelector(".sys-room-view-peek")).toBeNull();
      expect(screen.queryByText(/Looking for|Loading studio/)).toBeNull();
    });

    it("focuses the title only when asked", () => {
      const { unmount } = renderRoom({ loading: true, people: [] });
      expect(document.body).toHaveFocus();
      unmount();
      renderRoom({ loading: true, people: [], focusTitle: true });
      expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    });

    it("keeps the dock inert and opens no sheet", () => {
      const { container } = renderRoom({
        loading: true,
        people: [],
        viewerWidth: "phone",
      });
      expect(container.querySelector(".sys-room-view-dock")).toHaveAttribute(
        "inert",
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows a connecting alert with a reachable Retry", async () => {
      const user = userEvent.setup();
      const onAction = vi.fn();
      renderRoom({
        loading: true,
        people: [],
        alerts: [{ kind: "connecting", onAction }],
      });
      expect(screen.getByText("Still connecting…")).toBeVisible();
      const live = document.querySelector(".sys-room-alert-live");
      expect(live?.closest("[aria-busy]")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Retry" }).closest("[aria-busy]"),
      ).toBeNull();
      expect(screen.queryByText("Joining the room…")).toBeNull();
      expect(
        document.querySelectorAll('.sys-room-alert-live[role="status"]'),
      ).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(onAction).toHaveBeenCalledOnce();
    });
  });
});

describe("RoomView comments naming", () => {
  const phases: RoomViewProps["phase"][] = [
    { kind: "waiting" },
    LIVE,
    { kind: "paused", clockSec: 724 },
    { kind: "saved" },
  ];

  it.each([
    ["host", [{ ...HOST, you: true }]],
    ["guest", [HOST, JON]],
    ["producer", [HOST, ROSA]],
  ] as const)("reads Comments and never Notes for the %s", (seat, people) => {
    for (const viewerWidth of ["desktop", "phone"] as const) {
      for (const phase of phases) {
        for (const takes of [undefined, <p key="t">Take 1 saved</p>]) {
          for (const open of [true, false]) {
            const { unmount } = renderRoom({
              seat,
              people: [...people],
              phase,
              viewerWidth,
              takes,
              defaultNotesOpen: open,
              notes: NOTES,
            });
            expect(notesNaming(document.body)).toEqual([]);
            const text = readableText(document.body);
            if (viewerWidth === "phone" && !open) {
              expect(
                document.querySelector(".sys-room-view-peek-label"),
              ).toHaveTextContent("Comments");
            } else if (viewerWidth === "phone") {
              expect(text).toContain("Comments");
              screen.getByRole("dialog", {
                name: takes ? "Comments and takes" : "Comments",
              });
            } else if (open) {
              screen.getByRole("complementary", {
                name: takes ? "Comments and takes" : "Comments",
              });
            }
            unmount();
          }
        }
      }
    }
  });

  describe("the Comments sheet's dock floor", () => {
    const root = document.documentElement;
    afterEach(() => {
      vi.restoreAllMocks();
      root.removeAttribute("data-room-sheet");
    });

    function restDockAt(top: number) {
      vi.spyOn(root, "clientWidth", "get").mockReturnValue(390);
      vi.spyOn(root, "clientHeight", "get").mockReturnValue(844);
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        const dock = this.classList.contains("sys-room-view-dock");
        return {
          top: dock ? top : 0,
          bottom: dock ? top + 106 : 0,
          left: 0,
          right: dock ? 390 : 0,
          width: dock ? 390 : 0,
          height: dock ? 106 : 0,
          x: 0,
          y: dock ? top : 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    }

    it("publishes the dock floor while the sheet is open, with its own class on the panel", () => {
      restDockAt(686);
      renderRoom({ viewerWidth: "phone", defaultNotesOpen: true });
      expect(root.getAttribute("data-room-sheet")).toBe("bottom");
      expect(root.style.getPropertyValue("--room-sheet-bottom")).toBe("158px");
      expect(screen.getByRole("dialog", { name: "Comments" })).toHaveClass(
        "sys-room-comments",
      );
    });

    it("follows Close and clears on unmount", async () => {
      restDockAt(686);
      const { unmount } = renderRoom({
        viewerWidth: "phone",
        defaultNotesOpen: true,
      });
      expect(root.getAttribute("data-room-sheet")).toBe("bottom");
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(root.hasAttribute("data-room-sheet")).toBe(false);
      await userEvent.click(
        document.querySelector(".sys-room-view-peek") as HTMLElement,
      );
      expect(root.getAttribute("data-room-sheet")).toBe("bottom");
      unmount();
      expect(root.hasAttribute("data-room-sheet")).toBe(false);
    });

    it("publishes nothing on the desktop, while loading, or under Declined", () => {
      restDockAt(686);
      for (const rest of [
        { viewerWidth: "desktop" as const },
        { viewerWidth: "phone" as const, loading: true },
        { viewerWidth: "phone" as const, declined: { onJoin: () => {} } },
      ]) {
        const { unmount } = renderRoom({ ...rest, defaultNotesOpen: true });
        expect(root.hasAttribute("data-room-sheet")).toBe(false);
        unmount();
      }
    });
  });

  it("says no comments yet on the closed phone peek", () => {
    renderRoom({ viewerWidth: "phone", notes: [] });
    const peek = document.querySelector(".sys-room-view-peek") as HTMLElement;
    expect(peek).toHaveTextContent("CommentsNo comments yet");
  });

  it.each([
    ["host", [{ ...HOST, you: true }]],
    ["producer", [HOST, ROSA]],
  ] as const)(
    "the %s's dock button reopens a rail left on Takes on the Comments tab",
    async (seat, people) => {
      renderRoom({
        seat,
        people: [...people],
        takes: <p>Take 1 saved</p>,
        defaultNotesOpen: true,
      });
      await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
      const toggle = screen.getByRole("button", { name: "Comments" });
      await userEvent.click(toggle);
      await userEvent.click(toggle);
      await userEvent.click(toggle);
      expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    },
  );

  it("names the rail Comments until a Takes tab exists, then Comments and takes", () => {
    const { unmount } = renderRoom({ defaultNotesOpen: true });
    expect(
      screen.getByRole("complementary", { name: "Comments" }),
    ).toBeVisible();
    expect(screen.queryByRole("tab")).toBeNull();
    unmount();
    renderRoom({ takes: <p>Take 1 saved</p>, defaultNotesOpen: true });
    expect(
      screen.getByRole("complementary", { name: "Comments and takes" }),
    ).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it.each([
    ["host", [{ ...HOST, you: true }]],
    ["guest", [HOST, JON]],
    ["producer", [HOST, ROSA]],
  ] as const)(
    "the %s's Comments toggle is pressed only while the Comments tab shows, and from Takes it shows Comments",
    async (seat, people) => {
      renderRoom({
        seat,
        people: [...people],
        takes: <p>Take 1 saved</p>,
        defaultNotesOpen: true,
      });
      const toggle = screen.getByRole("button", { name: "Comments" });
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(toggle);
      expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("complementary")).toBeVisible();
      expect(toggle).toHaveFocus();
      await userEvent.click(toggle);
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(toggle).toHaveAttribute("aria-pressed", "false");
    },
  );

  it("keeps the toggle pressed on a rail with no Takes tab, and closes it on press", async () => {
    renderRoom({ defaultNotesOpen: true });
    const toggle = screen.getByRole("button", { name: "Comments" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("names the phone sheet Comments until a Takes tab exists", async () => {
    const { unmount } = renderRoom({ viewerWidth: "phone", notes: NOTES });
    await userEvent.click(
      document.querySelector(".sys-room-view-peek") as HTMLElement,
    );
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeVisible();
    unmount();
    renderRoom({
      viewerWidth: "phone",
      notes: NOTES,
      takes: <p>Take 1 saved</p>,
    });
    await userEvent.click(
      document.querySelector(".sys-room-view-peek") as HTMLElement,
    );
    expect(
      screen.getByRole("dialog", { name: "Comments and takes" }),
    ).toBeVisible();
  });

  it.each([
    ["host", [{ ...HOST, you: true }]],
    ["producer", [HOST, ROSA]],
  ] as const)(
    "the %s's phone peek opens the sheet on the Comments tab",
    async (seat, people) => {
      renderRoom({
        seat,
        people: [...people],
        viewerWidth: "phone",
        takes: <p>Take 1 saved</p>,
      });
      await userEvent.click(
        document.querySelector(".sys-room-view-peek") as HTMLElement,
      );
      await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
      await userEvent.click(
        within(
          screen.getByRole("dialog", { name: "Comments and takes" }),
        ).getByRole("button", { name: "Close" }),
      );
      await userEvent.click(
        document.querySelector(".sys-room-view-peek") as HTMLElement,
      );
      expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    },
  );
});

describe("RoomView phone layout (3834 PR 7)", () => {
  const commentsButtons = () =>
    screen.queryAllByRole("button", { name: /^Comments/ });

  it("a phone guest has one door to Comments, the peek, and a labelled dock", () => {
    renderRoom({ viewerWidth: "phone" });
    expect(commentsButtons()).toHaveLength(1);
    expect(commentsButtons()[0]).toHaveClass("sys-room-view-peek");
    expect(document.querySelector(".sys-dock")).toHaveAttribute(
      "data-labelled",
    );
    expect(names()).toEqual(["Mute", "Comment", "Leave room"]);
  });

  it("a phone producer has the peek only and Comment, Leave", () => {
    renderRoom({
      seat: "producer",
      people: [HOST, ROSA],
      selfName: "Rosa Diaz",
      viewerWidth: "phone",
    });
    expect(commentsButtons()).toHaveLength(1);
    expect(commentsButtons()[0]).toHaveClass("sys-room-view-peek");
    expect(names()).toEqual(["Comment", "Leave room"]);
  });

  it("an embedded host on a phone keeps the dock's Comments toggle, unlabelled", () => {
    renderRoom({
      seat: "host",
      people: [HOST_YOU],
      embedded: true,
      viewerWidth: "phone",
    });
    expect(commentsButtons()).toHaveLength(2);
    expect(
      within(document.querySelector(".sys-dock") as HTMLElement).getByRole(
        "button",
        { name: "Comments" },
      ),
    ).toBeInTheDocument();
    expect(document.querySelector(".sys-dock-label")).toBeNull();
  });

  it("a desktop guest keeps the dock's Comments toggle", () => {
    renderRoom({ viewerWidth: "desktop" });
    expect(commentsButtons()).toHaveLength(1);
    expect(commentsButtons()[0]).not.toHaveClass("sys-room-view-peek");
    expect(document.querySelector(".sys-dock-label")).toBeNull();
  });

  it("a landscape phone keeps the toggle too", () => {
    renderRoom({ viewerWidth: "phone-landscape" });
    expect(
      within(document.querySelector(".sys-dock") as HTMLElement).getByRole(
        "button",
        { name: "Comments" },
      ),
    ).toBeInTheDocument();
  });

  it("the page header holds the brand symbol and the name ShareCut once", () => {
    renderRoom({ viewerWidth: "phone" });
    const header = screen.getByRole("banner");
    expect(header.querySelector(".sys-room-view-symbol")).not.toBeNull();
    expect(within(header).getAllByText("ShareCut")).toHaveLength(1);
  });

  it("the guest's own tile says you, the embedded host's does not", () => {
    const { unmount } = renderRoom({ onSelfPress: vi.fn() });
    expect(screen.getByRole("group", { name: "Jon, you" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Devices" })).toBeVisible();
    unmount();
    renderRoom({
      seat: "host",
      people: [HOST_YOU],
      embedded: true,
      onSelfPress: vi.fn(),
    });
    expect(
      screen.getByRole("group", { name: "Maya Okafor, host" }),
    ).toBeVisible();
    expect(screen.queryByText("(you)")).toBeNull();
  });
});

describe("RoomView, host phone Comments sheet during a take (#4660)", () => {
  const ME: RoomPerson = { ...HOST, you: true };
  const WAITING = { kind: "waiting" } as const;
  const PAUSED = { kind: "paused", clockSec: 12 } as const;
  const SAVED = { kind: "saved" } as const;
  const guestNote = (id: string, text = `hello ${id}`): NoteItem => ({
    id,
    kind: "note",
    author: { name: "Jon", colorIndex: 3 },
    text,
    time: "0:10",
    visibility: "everyone",
  });
  const hostNote = (id: string): NoteItem => ({
    id,
    kind: "note",
    author: { name: "Maya Okafor", colorIndex: 0 },
    text: `mine ${id}`,
    time: "0:11",
    visibility: "everyone",
    mine: true,
  });
  const markerNote = (id: string): NoteItem => ({
    id,
    kind: "marker",
    author: { name: "Jon", colorIndex: 3 },
    time: "0:12",
  });

  function hostPhone(over: Partial<RoomViewProps> = {}) {
    let props: RoomViewProps = {
      seat: "host",
      title: "Episode 14",
      people: [ME, JON],
      lookingIn: 0,
      phase: LIVE,
      viewerWidth: "phone",
      defaultNotesOpen: true,
      collapseNotesInTake: true,
      countUnread: new UnreadStore(),
      notes: [],
      selfName: "Maya Okafor",
      onSendNote: vi.fn(),
      takes: <p>Saved take list</p>,
      ...over,
    };
    const view = render(<RoomView {...props} />);
    return {
      ...view,
      update(next: Partial<RoomViewProps>) {
        props = { ...props, ...next };
        view.rerender(<RoomView {...props} />);
      },
    };
  }
  const peek = () =>
    document.querySelector(".sys-room-view-peek") as HTMLElement;
  const badge = () => document.querySelector(".sys-dock-badge--inline");
  const sheet = () =>
    screen.queryByRole("dialog", { name: "Comments and takes" });

  it("starts collapsed to the peek bar during a live take", () => {
    hostPhone();
    expect(sheet()).toBeNull();
    expect(peek()).toHaveAttribute("aria-expanded", "false");
  });

  it("also collapses while the take is paused", () => {
    hostPhone({ phase: PAUSED });
    expect(sheet()).toBeNull();
    expect(peek()).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    ["waiting", WAITING],
    ["saved", SAVED],
  ] as const)(
    "keeps today's open sheet when the room is %s",
    (_name, phase) => {
      hostPhone({ phase });
      expect(sheet()).toBeVisible();
      expect(peek()).toHaveAttribute("aria-expanded", "true");
    },
  );

  it("collapses when a take starts, if the host did not open the sheet themselves", () => {
    const view = hostPhone({ phase: WAITING });
    expect(sheet()).toBeVisible();
    view.update({ phase: LIVE });
    expect(sheet()).toBeNull();
    view.update({ phase: SAVED });
    expect(sheet()).toBeVisible();
  });

  it("one tap on the peek opens it, and it stays open through Stop, Start, Pause and loading", async () => {
    const view = hostPhone();
    await userEvent.click(peek());
    expect(sheet()).toBeVisible();
    expect(peek()).toHaveAttribute("aria-expanded", "true");
    for (const phase of [
      SAVED,
      WAITING,
      LIVE,
      { kind: "live", take: 2, clockSec: 3 } as const,
      PAUSED,
      LIVE,
    ]) {
      view.update({ phase });
      expect(sheet()).toBeVisible();
      expect(peek()).toHaveAttribute("aria-expanded", "true");
    }
    view.update({ loading: true });
    view.update({ loading: false });
    expect(sheet()).toBeVisible();
  });

  it("collapses again when the host closes it, and the next comment counts from zero", async () => {
    const view = hostPhone();
    await userEvent.click(peek());
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(sheet()).toBeNull();
    expect(peek()).toHaveAttribute("aria-expanded", "false");
    view.update({ notes: [guestNote("1")] });
    expect(badge()).toHaveTextContent("1");
  });

  it("shows a count badge and a pulse for a guest's comment, named on the button only", () => {
    const view = hostPhone({ notes: [guestNote("1")] });
    expect(badge()).toBeNull();
    view.update({ notes: [guestNote("1"), guestNote("2")] });
    expect(badge()).toHaveTextContent("1");
    expect(badge()).toHaveAttribute("data-pulse");
    expect(peek()).toHaveAccessibleName(/1 ?unread$/);
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("a second comment makes it 2 and restarts the pulse on a new badge element", () => {
    const view = hostPhone();
    view.update({ notes: [guestNote("1")] });
    const first = badge();
    view.update({ notes: [guestNote("1"), guestNote("2")] });
    expect(badge()).toHaveTextContent("2");
    expect(badge()).not.toBe(first);
    expect(peek()).toHaveAccessibleName(/2 ?unread$/);
  });

  it("caps the badge at 99+ and says 99 or more", () => {
    const view = hostPhone();
    view.update({
      notes: Array.from({ length: 120 }, (_, i) => guestNote(`n${i}`)),
    });
    expect(badge()).toHaveTextContent("99+");
    expect(peek()).toHaveAccessibleName(/99\+ ?unread$/);
  });

  it("does not badge the host's own comments or any marker", () => {
    const view = hostPhone();
    view.update({
      notes: [hostNote("1"), markerNote("2")],
    });
    expect(badge()).toBeNull();
    expect(peek().querySelector("[data-pulse]")).toBeNull();
    expect(peek()).toHaveAccessibleName(/^Comments/);
    expect(peek()).not.toHaveAccessibleName(/unread/);
  });

  it("counts a guest who shares the host's display name", () => {
    const view = hostPhone({ selfName: "Jon" });
    view.update({ notes: [{ ...guestNote("1"), mine: false }] });
    expect(badge()).toHaveTextContent("1");
  });

  it("opening the sheet clears the badge", async () => {
    const view = hostPhone();
    view.update({ notes: [guestNote("1")] });
    expect(badge()).toHaveTextContent("1");
    await userEvent.click(peek());
    expect(badge()).toBeNull();
    expect(screen.getByText("hello 1")).toBeVisible();
  });

  it("a comment arriving while the Comments tab is open is seen: no badge, no pulse, even after closing", async () => {
    const view = hostPhone();
    await userEvent.click(peek());
    view.update({ notes: [guestNote("1")] });
    expect(screen.getByText("hello 1")).toBeVisible();
    expect(badge()).toBeNull();
    expect(peek().querySelector("[data-pulse]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(badge()).toBeNull();
  });

  it("on the Takes tab a comment is not seen: no badge or pulse while open, a quiet badge after closing, cleared by reading Comments", async () => {
    const view = hostPhone();
    await userEvent.click(peek());
    await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    view.update({ notes: [guestNote("1")] });
    expect(badge()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(badge()).toHaveTextContent("1");
    expect(badge()).not.toHaveAttribute("data-pulse");
    await userEvent.click(peek());
    await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    await userEvent.click(screen.getByRole("tab", { name: "Comments" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(badge()).toBeNull();
  });

  it("a reconnect remount with a kept store does not count the comments already in the room", () => {
    const store = new UnreadStore();
    const notes = [1, 2, 3, 4, 5].map((n) => guestNote(`${n}`));
    const first = hostPhone({ notes, countUnread: store });
    expect(badge()).toBeNull();
    first.unmount();
    const second = hostPhone({ notes, countUnread: store });
    expect(badge()).toBeNull();
    second.update({ notes: [...notes, guestNote("6")] });
    expect(badge()).toHaveTextContent("1");
  });

  it("seeds after loading: no badge for the five comments that arrive with the room", () => {
    const view = hostPhone({ loading: true, notes: [] });
    view.update({
      loading: false,
      notes: [1, 2, 3, 4, 5].map((n) => guestNote(`${n}`)),
    });
    expect(badge()).toBeNull();
  });

  it("is off without the store: a guest's phone never shows a badge", () => {
    const view = renderRoom({ viewerWidth: "phone", notes: [] });
    const props = {
      seat: "guest" as const,
      title: "Episode 14",
      people: [HOST, JON],
      lookingIn: 0,
      phase: LIVE,
      viewerWidth: "phone" as const,
      selfName: "Jon",
      onSendNote: vi.fn(),
    };
    view.rerender(<RoomView {...props} notes={[guestNote("1")]} />);
    expect(badge()).toBeNull();
    expect(peek()).toHaveAccessibleName(/^Comments/);
    expect(peek()).not.toHaveAccessibleName(/unread/);
  });

  it("a desktop host keeps the open rail: no peek bar, no badge", () => {
    const view = hostPhone({ viewerWidth: "desktop" });
    expect(document.querySelector(".sys-room-view-peek")).toBeNull();
    expect(
      screen.getByRole("complementary", { name: "Comments and takes" }),
    ).toBeVisible();
    view.update({ notes: [guestNote("1")] });
    expect(badge()).toBeNull();
  });

  it("has no axe violations with the badge showing", async () => {
    const view = hostPhone();
    view.update({ notes: [guestNote("1"), guestNote("2")] });
    expect(badge()).toHaveTextContent("2");
    await expectNoA11yViolations(document.body);
  });
});
