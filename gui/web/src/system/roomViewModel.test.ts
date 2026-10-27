import { describe, expect, it } from "vitest";
import type { RoomPhase } from "./roomPhase";
import type { RoomPerson, RoomViewInput } from "./roomViewModel";
import { roomViewModel, tileProps } from "./roomViewModel";

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
