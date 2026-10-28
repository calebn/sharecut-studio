import { describe, expect, it } from "vitest";
import type { NoteItem } from "./notesRailModel";
import type { RoomPhase } from "./roomPhase";
import type { RoomPerson, RoomViewInput } from "./roomViewModel";
import { notePeek, roomViewModel, tileProps } from "./roomViewModel";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const JON = { name: "Jon", colorIndex: 3 };
const ANNEKE = { name: "Anneke de Vries", colorIndex: 1 };
const JOSS = { name: "Joss", colorIndex: 2 };
const ROSA = { name: "Rosa Diaz", colorIndex: 4 };

const LIVE: RoomPhase = { kind: "live", take: 1, clockSec: 724 };
const WAITING: RoomPhase = { kind: "waiting", host: "Maya" };

const host = (rest: Partial<RoomPerson> = {}): RoomPerson => ({
  role: "host",
  person: MAYA,
  presence: "live",
  ...rest,
});
const guest = (
  person: RoomPerson["person"],
  rest: Partial<RoomPerson> = {},
): RoomPerson => ({ role: "guest", person, presence: "live", ...rest });
const producer = (rest: Partial<RoomPerson> = {}): RoomPerson => ({
  role: "producer",
  person: ROSA,
  presence: "live",
  ...rest,
});

const base = (rest: Partial<RoomViewInput>): RoomViewInput => ({
  role: "guest",
  people: [],
  phase: LIVE,
  viewerWidth: "desktop",
  ...rest,
});

const names = (tiles: ReturnType<typeof roomViewModel>["tiles"]) =>
  tiles.map((tile) =>
    tile.kind === "invite"
      ? "invite"
      : tile.props.presence === "placeholder"
        ? "placeholder"
        : tile.props.person.name,
  );

describe("roomViewModel tiles", () => {
  it("lists the host first for the host's own view, then the guests", () => {
    const model = roomViewModel(
      base({
        role: "host",
        people: [
          guest(JON),
          host({ you: true }),
          guest(ANNEKE, { presence: "joining" }),
        ],
      }),
    );
    expect(names(model.tiles)).toEqual([
      "Maya Okafor",
      "Jon",
      "Anneke de Vries",
      "invite",
    ]);
  });

  it("keeps a guest's own tile in place on the desktop", () => {
    const model = roomViewModel(
      base({ people: [host(), guest(JON, { you: true }), guest(ANNEKE)] }),
    );
    expect(names(model.tiles)).toEqual([
      "Maya Okafor",
      "Jon",
      "Anneke de Vries",
    ]);
  });

  it("leads with a guest's own tile on the phone", () => {
    const model = roomViewModel(
      base({
        viewerWidth: "phone",
        people: [host(), guest(JON, { you: true })],
      }),
    );
    expect(names(model.tiles)).toEqual(["Jon", "Maya Okafor"]);
  });

  it("omits a producer's own tile, since producers only listen", () => {
    const model = roomViewModel(
      base({
        role: "producer",
        people: [host(), guest(JON), producer({ you: true })],
      }),
    );
    expect(names(model.tiles)).toEqual(["Maya Okafor", "Jon"]);
    expect(model.listeners).toEqual([
      { key: "producer-Rosa Diaz", person: ROSA, label: "You" },
    ]);
  });

  it("fills a host's room with Invite slots up to four recorded people", () => {
    const solo = roomViewModel(
      base({ role: "host", people: [host({ you: true })] }),
    );
    expect(solo.tiles.filter((tile) => tile.kind === "invite")).toHaveLength(3);
    const full = roomViewModel(
      base({
        role: "host",
        people: [
          host({ you: true }),
          guest(JON),
          guest(ANNEKE),
          guest(JOSS),
          guest(ROSA),
        ],
      }),
    );
    expect(full.tiles.filter((tile) => tile.kind === "invite")).toHaveLength(0);
    expect(full.tiles).toHaveLength(5);
  });

  it("gives no Invite slots when the host has no invite handler", () => {
    const model = roomViewModel(
      base({ role: "host", invite: false, people: [host({ you: true })] }),
    );
    expect(model.tiles.some((tile) => tile.kind === "invite")).toBe(false);
  });

  it("gives guests and producers no Invite slots", () => {
    const model = roomViewModel(
      base({ people: [host(), guest(JON, { you: true })] }),
    );
    expect(model.tiles.some((tile) => tile.kind === "invite")).toBe(false);
  });
});

describe("roomViewModel columns", () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 2],
  ])("%i desktop tile(s) use %i column(s)", (count, columns) => {
    const people = [host(), guest(JON), guest(ANNEKE), guest(JOSS)].slice(
      0,
      count,
    );
    const model = roomViewModel(base({ people }));
    expect(model.columns).toBe(columns);
  });

  it("a lone phone tile is still a 2x2 grid", () => {
    const model = roomViewModel(
      base({ viewerWidth: "phone", people: [host({ you: true })] }),
    );
    expect(model.columns).toBe(2);
  });
});

describe("roomViewModel dock and rail", () => {
  it("passes the viewer's seat through and hides Comment while waiting", () => {
    expect(roomViewModel(base({ phase: WAITING })).showComment).toBe(false);
    expect(roomViewModel(base({ phase: LIVE })).showComment).toBe(true);
    expect(
      roomViewModel(base({ role: "producer", phase: LIVE })).dockSeat,
    ).toBe("producer");
  });

  it("opens the rail by default for a desktop producer only", () => {
    expect(roomViewModel(base({ role: "producer" })).railOpen).toBe(true);
    expect(roomViewModel(base({ role: "guest" })).railOpen).toBe(false);
    expect(
      roomViewModel(base({ role: "producer", viewerWidth: "phone" })).railOpen,
    ).toBe(false);
  });

  it("follows the viewer's Notes choice when one is made", () => {
    expect(
      roomViewModel(base({ role: "guest", notesOpen: true })).railOpen,
    ).toBe(true);
    expect(
      roomViewModel(base({ role: "producer", notesOpen: false })).railOpen,
    ).toBe(false);
  });
});

describe("roomViewModel alerts", () => {
  it("shows host-offline to a guest whose host has left or dropped", () => {
    const left = roomViewModel(base({ people: [host({ presence: "left" })] }));
    expect(left.alerts).toEqual([
      { kind: "host-offline", name: "Maya Okafor" },
    ]);
    const dropped = roomViewModel(
      base({ people: [host({ connection: "lost" })] }),
    );
    expect(dropped.alerts).toEqual([
      { kind: "host-offline", name: "Maya Okafor" },
    ]);
  });

  it("never shows host-offline to the host", () => {
    const model = roomViewModel(
      base({ role: "host", people: [host({ you: true, presence: "left" })] }),
    );
    expect(model.alerts).toEqual([]);
  });

  it("never shows host-offline to a producer", () => {
    const model = roomViewModel(
      base({
        role: "producer",
        people: [host({ presence: "left" }), producer({ you: true })],
      }),
    );
    expect(model.alerts).toEqual([]);
  });

  it("passes the caller's other alerts through beside the derived one", () => {
    const model = roomViewModel(
      base({
        alerts: [{ kind: "mic-lost" }],
        people: [host({ presence: "left" })],
      }),
    );
    expect(model.alerts).toEqual([
      { kind: "host-offline", name: "Maya Okafor" },
      { kind: "mic-lost" },
    ]);
  });

  it("the named derived host-offline replaces a caller's nameless one", () => {
    const model = roomViewModel(
      base({
        alerts: [{ kind: "host-offline" }],
        people: [host({ presence: "left" })],
      }),
    );
    expect(model.alerts).toEqual([
      { kind: "host-offline", name: "Maya Okafor" },
    ]);
  });

  it("keeps a caller's host-offline when nothing derives one", () => {
    const model = roomViewModel(
      base({
        alerts: [{ kind: "host-offline", name: "Maya" }],
        people: [host()],
      }),
    );
    expect(model.alerts).toEqual([{ kind: "host-offline", name: "Maya" }]);
  });
});

describe("tileProps", () => {
  it("uses effectiveLive, so a muted person's ring rests", () => {
    const props = tileProps(
      guest(JON, { muted: true, level: 0.8, speaking: true }),
    );
    expect(props).toMatchObject({
      presence: "live",
      level: 0,
      speaking: false,
    });
  });

  it("maps a listener to the ear and a non-live person to their away state", () => {
    expect(tileProps(producer())).toMatchObject({ listener: true });
    expect(tileProps(guest(JON, { presence: "declined" }))).toEqual({
      presence: "declined",
      person: JON,
    });
  });
});

const note = (
  id: string,
  time: string | null,
  rest: Partial<NoteItem> = {},
): NoteItem => ({
  id,
  kind: "note",
  author: { name: "Rosa Diaz" },
  text: `Note ${id}`,
  time,
  visibility: "everyone",
  ...rest,
});

describe("roomViewModel phone", () => {
  it("opens the sheet, not the rail, on a phone and follows the Notes choice", () => {
    const closed = roomViewModel(base({ viewerWidth: "phone" }));
    expect(closed.sheetOpen).toBe(false);
    expect(closed.notesOpen).toBe(false);
    const open = roomViewModel(
      base({ viewerWidth: "phone", notesOpen: true, role: "producer" }),
    );
    expect(open.sheetOpen).toBe(true);
    expect(open.railOpen).toBe(false);
    expect(open.notesOpen).toBe(true);
  });

  it("never opens the sheet on the desktop", () => {
    const model = roomViewModel(base({ notesOpen: true }));
    expect(model.sheetOpen).toBe(false);
    expect(model.railOpen).toBe(true);
    expect(model.notesOpen).toBe(true);
  });

  it("keeps a 2x2 grid in portrait and puts every tile in one row in landscape", () => {
    const people = [host({ you: true }), guest(JON), guest(ANNEKE)];
    expect(
      roomViewModel(base({ role: "host", viewerWidth: "phone", people }))
        .columns,
    ).toBe(2);
    expect(
      roomViewModel(
        base({ role: "host", viewerWidth: "phone-landscape", people }),
      ).columns,
    ).toBe(4);
    expect(
      roomViewModel(
        base({
          viewerWidth: "phone-landscape",
          people: [host(), guest(JON, { you: true })],
        }),
      ).columns,
    ).toBe(2);
  });

  it("leads with the viewer's own tile in landscape too", () => {
    const model = roomViewModel(
      base({
        viewerWidth: "phone-landscape",
        people: [host(), guest(JON, { you: true })],
      }),
    );
    expect(names(model.tiles)).toEqual(["Jon", "Maya Okafor"]);
  });

  it("shows the peek line in portrait only", () => {
    const notes = [note("a", "12:02")];
    expect(
      roomViewModel(base({ viewerWidth: "phone", notes, selfName: "Jon" }))
        .peek,
    ).toEqual({ author: "Rosa Diaz", text: "Note a", time: "12:02" });
    expect(
      roomViewModel(base({ viewerWidth: "phone-landscape", notes })).peek,
    ).toBeNull();
    expect(roomViewModel(base({ notes })).peek).toBeNull();
  });
});

describe("notePeek", () => {
  it("is null without notes", () => {
    expect(notePeek([], "host", "Maya")).toBeNull();
  });

  it("takes the latest by the recording clock, not the list order", () => {
    const peek = notePeek(
      [note("b", "12:09"), note("a", "12:02"), note("c", null)],
      "host",
      "Maya",
    );
    expect(peek?.text).toBe("Note b");
  });

  it("names a marker and skips notes a guest cannot see", () => {
    const items = [
      note("a", "12:02"),
      note("b", "12:09", { visibility: "hosts" }),
      { id: "m", kind: "marker", author: { name: "Rosa Diaz" }, time: "12:05" },
    ] satisfies NoteItem[];
    expect(notePeek(items, "guest", "Jon")?.text).toBe("Marker");
    expect(notePeek(items, "host", "Maya")?.text).toBe("Note b");
  });
});

describe("roomViewModel host", () => {
  it("gives only the host a Record face, following the phase", () => {
    const people = [host({ you: true })];
    const face = (phase: RoomPhase) =>
      roomViewModel(base({ role: "host", people, phase })).record?.face;
    expect(face(WAITING)).toBe("idle");
    expect(face({ kind: "countdown", secondsLeft: 3 })).toBe("idle");
    expect(face(LIVE)).toBe("live");
    expect(face({ kind: "paused", clockSec: 12 })).toBe("paused");
    expect(face({ kind: "saved" })).toBe("idle");
    expect(roomViewModel(base({ role: "guest" })).record).toBeNull();
    expect(roomViewModel(base({ role: "producer" })).record).toBeNull();
  });

  it("holds the first take back while a guest is still joining", () => {
    const people = [host({ you: true }), guest(JON, { presence: "joining" })];
    expect(
      roomViewModel(base({ role: "host", people, phase: WAITING })).record,
    ).toEqual({ face: "idle", disabledReason: "Waiting for Jon to join" });
    expect(
      roomViewModel(base({ role: "host", people, phase: LIVE })).record,
    ).toEqual({ face: "live" });
  });

  it("lets a host with no guests record a solo take", () => {
    const model = roomViewModel(
      base({ role: "host", people: [host({ you: true })], phase: WAITING }),
    );
    expect(model.record).toEqual({ face: "idle" });
    expect(names(model.tiles)).toEqual([
      "Maya Okafor",
      "invite",
      "invite",
      "invite",
    ]);
  });

  it("replaces the dock controls with a saving line while the take saves", () => {
    const model = roomViewModel(
      base({
        role: "host",
        phase: { kind: "saving", savedPeople: 2, totalPeople: 3 },
      }),
    );
    expect(model.dockStatus).toBe("Saving · 2 of 3 · keep this page open");
    expect(roomViewModel(base({ role: "host", phase: LIVE })).dockStatus).toBe(
      null,
    );
  });
});
