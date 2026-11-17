import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { RoomView, type RoomViewProps } from "./RoomView";
import type { RoomPerson } from "./roomViewModel";

let host: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const noop = () => {};

const ME: RoomPerson = {
  role: "guest",
  person: { name: "Ava", colorIndex: 0 },
  you: true,
  presence: "live",
  connection: "good",
  level: 1,
  speaking: true,
};
const OTHERS: RoomPerson[] = [
  {
    role: "host",
    person: { name: "Maya", colorIndex: 1 },
    presence: "live",
    connection: "good",
    level: 1,
    speaking: true,
  },
  {
    role: "guest",
    person: { name: "Bo", colorIndex: 2 },
    presence: "live",
    connection: "good",
    level: 1,
    speaking: true,
  },
  {
    role: "guest",
    person: { name: "Cy", colorIndex: 3 },
    presence: "live",
    connection: "good",
    level: 1,
    speaking: true,
  },
];

async function render(
  width: number,
  height: number,
  props: Partial<RoomViewProps> & Pick<RoomViewProps, "seat" | "phase">,
) {
  await page.viewport(width, height);
  host = document.createElement("div");
  host.style.cssText = `inline-size:${width}px;block-size:${height}px;`;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    createElement(RoomView, {
      title: "Aligned dialogue",
      people: [ME],
      notes: [],
      selfName: "Ava",
      onSendNote: noop,
      onSelfPress: noop,
      onLeave: noop,
      onMute: noop,
      onComment: noop,
      lookingIn: 0,
      ...props,
    }),
  );
  await document.fonts.ready;
  await frame();
  await frame();
  return host;
}

const rect = (el: Element) => el.getBoundingClientRect();
const LIVE = { kind: "live", take: 1, clockSec: 60 } as const;
// The level ring grows to 8 px past the avatar when its owner speaks; 1 px more keeps a visible gap.
const CLEAR_PX = 9;

describe("the own tile's Devices cue on the guest page", () => {
  for (const [width, height] of [
    [768, 1024],
    [800, 1000],
    [1024, 768],
    [1280, 800],
  ] as const) {
    for (const railOpen of [true, false]) {
      for (const count of [1, 2, 3, 4]) {
        it(`clears the avatar and its ring at ${width}x${height}, rail ${railOpen ? "open" : "closed"}, ${count} ${count === 1 ? "person" : "people"}`, async () => {
          const room = await render(width, height, {
            seat: "guest",
            phase: LIVE,
            viewerWidth: "desktop",
            defaultNotesOpen: railOpen,
            people: [...OTHERS.slice(0, count - 1), ME],
          });
          const cue = room.querySelector(".sys-room-devices");
          if (!cue) throw new Error("The own tile has no cue");
          const own = cue.closest(".sys-room-tile");
          if (!own) throw new Error("The cue sits outside a tile");
          const face = rect(own.querySelector(".sys-room-face") as Element);
          expect(face.top - rect(cue).bottom).toBeGreaterThanOrEqual(CLEAR_PX);
          const tiles = [...room.querySelectorAll(".sys-room-tile")];
          const inset = (tile: Element) =>
            rect(tile.querySelector(".sys-room-face") as Element).top -
            rect(tile).top;
          // The own tile's meter makes its foot taller, as on develop; the push is the same.
          const pushes = tiles.map(
            (tile) =>
              getComputedStyle(tile.querySelector(".sys-room-main") as Element)
                .marginBlockStart,
          );
          expect(pushes, "20 px on every tile").toEqual(
            pushes.map(() => "20px"),
          );
          expect(rect(cue).height).toBe(16);
          expect(
            new Set(
              tiles.filter((t) => t !== own).map((t) => Math.round(inset(t))),
            ).size,
            "the other avatars sit level",
          ).toBeLessThanOrEqual(1);
        });
      }
    }
  }

  it("leaves the host studio's avatars where develop put them", async () => {
    const room = await render(1024, 768, {
      seat: "host",
      phase: LIVE,
      embedded: true,
      people: [...OTHERS.slice(0, 2), { ...ME, you: false }],
    });
    expect(room.querySelector(".sys-room-devices")).toBeNull();
    for (const main of room.querySelectorAll(".sys-room-main")) {
      expect(getComputedStyle(main).marginBlockStart).toBe("0px");
    }
  });
});

describe("the labelled dock on a portrait phone", () => {
  const dock = (room: HTMLElement) =>
    rect(room.querySelector(".sys-dock") as Element).height;
  const people = [OTHERS[0] as RoomPerson, ME];

  for (const width of [320, 390, 700, 767]) {
    for (const seat of ["guest", "producer"] as const) {
      for (const [name, phase] of [
        ["waiting", { kind: "waiting", host: "Maya" }],
        ["live", LIVE],
        ["paused", { kind: "paused", clockSec: 60 }],
      ] as const) {
        it(`is 101 px for a ${seat} while ${name} at ${width}`, async () => {
          const room = await render(width, 844, {
            seat,
            phase,
            viewerWidth: "phone",
            people,
          });
          expect(dock(room)).toBeCloseTo(101, 0);
        });
      }
    }

    it(`stacks the saving line under a labelled Leave at ${width}`, async () => {
      const room = await render(width, 844, {
        seat: "guest",
        viewerWidth: "phone",
        phase: { kind: "saving", savedPeople: 0, totalPeople: 2, percent: 10 },
        device: { uploading: true },
        people,
      });
      const status = rect(room.querySelector(".sys-dock-status") as Element);
      const leave = rect(
        room.querySelector(".sys-dock-far .sys-dock-btn") as Element,
      );
      expect(status.top).toBeGreaterThanOrEqual(leave.bottom - 1);
      expect(
        room.querySelector(".sys-dock-far .sys-dock-label"),
      ).not.toBeNull();
      expect(dock(room)).toBeGreaterThan(101);
    });

    it(`stacks the Saved line above Done at ${width}`, async () => {
      const room = await render(width, 844, {
        seat: "guest",
        viewerWidth: "phone",
        phase: { kind: "saved" },
        onDone: noop,
        people,
      });
      const status = rect(room.querySelector(".sys-dock-status") as Element);
      const done = rect(room.querySelector(".sys-dock-done") as Element);
      expect(status.bottom).toBeLessThanOrEqual(done.top);
      expect(dock(room)).toBeCloseTo(101, 0);
    });
  }

  it("is as tall while saving at 767 as at 320", async () => {
    const heights: number[] = [];
    for (const width of [320, 767]) {
      const room = await render(width, 844, {
        seat: "guest",
        viewerWidth: "phone",
        phase: { kind: "saving", savedPeople: 0, totalPeople: 2, percent: 10 },
        device: { uploading: true },
        people,
      });
      heights.push(dock(room));
      root?.unmount();
      host?.remove();
    }
    expect(heights[1]).toBeCloseTo(heights[0] as number, 0);
  });
});

// What develop measured for the embedded host studio at a phone container width:
// below 673 px the dock container is narrow, so the host's dock closes its gap
// to 16 px and stacks the saving line under the button; above it, 24 px and one row.
describe("the host studio's phone dock stays as develop had it", () => {
  const HOST: RoomPerson = {
    role: "host",
    person: { name: "Maya", colorIndex: 1 },
    you: true,
    presence: "live",
    connection: "good",
  };
  const phases = {
    waiting: { kind: "waiting", host: "Maya" },
    live: LIVE,
    saving: { kind: "saving", savedPeople: 0, totalPeople: 2, percent: 10 },
  } as const;
  const height = { waiting: 88, live: 101, saving: 88 } as const;

  for (const width of [560, 650, 680, 700, 767]) {
    const narrow = width <= 672;
    for (const name of ["waiting", "live", "saving"] as const) {
      it(`at ${width} while ${name}`, async () => {
        const room = await render(width, 844, {
          seat: "host",
          embedded: true,
          viewerWidth: "phone",
          phase: phases[name],
          people: [HOST, OTHERS[1] as RoomPerson],
          onStartTake: noop,
          onStopTake: noop,
          onMore: noop,
        });
        const dock = room.querySelector(".sys-dock") as Element;
        const buttons = [...dock.querySelectorAll("button")].filter(
          (b) => getComputedStyle(b).display !== "none",
        );
        const status = dock.querySelector(".sys-dock-status");
        if (name === "saving") {
          expect(dock.getBoundingClientRect().height).toBeCloseTo(
            narrow ? 90 : 88,
            0,
          );
          const last = buttons[buttons.length - 1] as Element;
          expect(
            (status as Element).getBoundingClientRect().top >=
              last.getBoundingClientRect().bottom,
            "saving line stacked under the button",
          ).toBe(narrow);
          return;
        }
        expect(dock.getBoundingClientRect().height).toBeCloseTo(
          height[name],
          0,
        );
        const [a, b] = buttons
          .slice(-2)
          .map((el) => el.getBoundingClientRect());
        expect(
          (b as DOMRect).left - (a as DOMRect).right,
          "Comments to More",
        ).toBeCloseTo(narrow ? 16 : 24, 0);
      });
    }
  }
});

describe("the looking-in line on a portrait phone", () => {
  const four = [...OTHERS.slice(0, 3), ME];
  const LINE = "3 people with the producer link are looking in";

  for (const width of [320, 390]) {
    for (const seat of ["guest", "producer"] as const) {
      it(`sits under the header and clears the tiles, own cue and dock at ${width}, ${seat}, four people`, async () => {
        const room = await render(width, 844, {
          seat,
          phase: LIVE,
          viewerWidth: "phone",
          people: four,
          lookingIn: 3,
        });
        const line = room.querySelector(".sys-room-looking-in") as Element;
        const header = rect(room.querySelector("header") as Element);
        const first = rect(room.querySelector(".sys-room-tile") as Element);
        const dock = rect(room.querySelector(".sys-dock") as Element);
        const cue = rect(room.querySelector(".sys-room-devices") as Element);
        const box = rect(line);
        expect(line.textContent).toBe(LINE);
        expect(header.height).toBeCloseTo(44, 0);
        expect(box.top).toBeGreaterThanOrEqual(header.bottom);
        expect(box.bottom).toBeLessThanOrEqual(first.top);
        expect(box.bottom).toBeLessThanOrEqual(cue.top);
        expect(box.right).toBeLessThanOrEqual(width);
        expect(dock.bottom).toBeLessThanOrEqual(844 + 0.5);
        expect(dock.height).toBeCloseTo(101, 0);
        for (const tile of room.querySelectorAll(".sys-room-tile")) {
          expect(rect(tile).bottom).toBeLessThanOrEqual(dock.top + 0.5);
        }
      });
    }

    it(`moves the tiles down by its own height and one stage gap at ${width}`, async () => {
      const top = async (lookingIn: number) => {
        const room = await render(width, 844, {
          seat: "guest",
          phase: LIVE,
          viewerWidth: "phone",
          people: four,
          lookingIn,
        });
        const line = room.querySelector(".sys-room-looking-in");
        const stage = room.querySelector(".sys-room-view-stage") as Element;
        return {
          gap: Number.parseFloat(getComputedStyle(stage).rowGap),
          tile: rect(room.querySelector(".sys-room-tile") as Element).top,
          header: rect(room.querySelector("header") as Element).height,
          dock: rect(room.querySelector(".sys-dock") as Element).height,
          line: line ? rect(line).height : 0,
        };
      };
      const without = await top(0);
      root?.unmount();
      host?.remove();
      const withLine = await top(3);
      expect(withLine.header).toBe(without.header);
      expect(withLine.dock).toBe(without.dock);
      // Its own height plus the one stage gap that separates it from the tiles.
      expect(withLine.tile - without.tile).toBeCloseTo(
        withLine.line + withLine.gap,
        0,
      );
    });
  }
});

describe("the looking-in line hides nothing develop showed", () => {
  const PRODUCER: RoomPerson = {
    role: "producer",
    person: { name: "Pat", colorIndex: 4 },
    presence: "live",
    connection: "good",
  };
  const HOST: RoomPerson = {
    role: "host",
    person: { name: "Maya", colorIndex: 1 },
    you: true,
    presence: "live",
    connection: "good",
    level: 1,
    speaking: true,
  };
  // How far the stage's content runs past what the viewer can see.
  const hidden = (room: HTMLElement) => {
    const stage = room.querySelector(".sys-room-view-stage") as HTMLElement;
    return Math.max(0, stage.scrollHeight - stage.clientHeight);
  };
  const dockBottom = (room: HTMLElement) =>
    rect(room.querySelector(".sys-dock") as Element).bottom;
  const tileHeight = (room: HTMLElement) =>
    rect(room.querySelector(".sys-room-tile") as Element).height;

  type Case = {
    name: string;
    width: number;
    height: number;
    props: Parameters<typeof render>[2];
  };
  const guestPeople = (count: number) => [...OTHERS.slice(0, count - 1), ME];
  const cases: Case[] = [
    {
      name: "host studio 1280x800 with three people and a listener",
      width: 1280,
      height: 722,
      props: {
        seat: "host",
        phase: LIVE,
        embedded: true,
        viewerWidth: "desktop",
        defaultNotesOpen: true,
        people: [
          HOST,
          OTHERS[1] as RoomPerson,
          OTHERS[2] as RoomPerson,
          PRODUCER,
        ],
      },
    },
    {
      name: "host studio 1024x700 with three people and a listener",
      width: 1024,
      height: 622,
      props: {
        seat: "host",
        phase: LIVE,
        embedded: true,
        viewerWidth: "desktop",
        defaultNotesOpen: true,
        people: [
          HOST,
          OTHERS[1] as RoomPerson,
          OTHERS[2] as RoomPerson,
          PRODUCER,
        ],
      },
    },
    ...(["guest", "producer"] as const).flatMap((seat) =>
      [2, 3].map(
        (count): Case => ({
          name: `${seat} on a 667x375 landscape phone with ${count} people`,
          width: 667,
          height: 375,
          props: {
            seat,
            phase: LIVE,
            viewerWidth: "phone-landscape",
            people: guestPeople(count),
          },
        }),
      ),
    ),
    {
      name: "guest at 767 portrait with four people",
      width: 767,
      height: 1024,
      props: {
        seat: "guest",
        phase: LIVE,
        viewerWidth: "phone",
        people: guestPeople(4),
      },
    },
    {
      name: "guest at 768 with the rail open",
      width: 768,
      height: 1024,
      props: {
        seat: "guest",
        phase: LIVE,
        viewerWidth: "desktop",
        defaultNotesOpen: true,
        people: guestPeople(4),
      },
    },
  ];

  const compare = async (item: Case) => {
    const without = await render(item.width, item.height, {
      ...item.props,
      lookingIn: 0,
    });
    const before = {
      hidden: hidden(without),
      dock: dockBottom(without),
      tile: tileHeight(without),
    };
    root?.unmount();
    host?.remove();
    const room = await render(item.width, item.height, {
      ...item.props,
      lookingIn: 3,
    });
    const line = room.querySelector(".sys-room-looking-in") as Element;
    expect(line).not.toBeNull();
    expect(hidden(room)).toBeLessThanOrEqual(before.hidden + 0.5);
    expect(dockBottom(room)).toBeCloseTo(before.dock, 0);
    expect(tileHeight(room)).toBeLessThanOrEqual(before.tile + 0.5);
    const stage = rect(room.querySelector(".sys-room-view-stage") as Element);
    expect(rect(line).top).toBeGreaterThanOrEqual(stage.top);
    expect(rect(line).bottom).toBeLessThanOrEqual(stage.bottom);
  };

  for (const item of cases) {
    it(`${item.name}`, () => compare(item));
  }

  it("holds in dark for a guest at 390 with four people", async () => {
    document.documentElement.dataset.theme = "dark";
    try {
      await compare({
        name: "dark",
        width: 390,
        height: 844,
        props: {
          seat: "guest",
          phase: LIVE,
          viewerWidth: "phone",
          people: guestPeople(4),
        },
      });
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});

describe("the Declined state", () => {
  for (const [width, height, viewerWidth] of [
    [390, 844, "phone"],
    [1280, 800, "desktop"],
  ] as const) {
    for (const lookingIn of [0, 3]) {
      it(`dims the tiles at 40% in flow at ${width}, looking in ${lookingIn}`, async () => {
        const room = await render(width, height, {
          seat: "guest",
          phase: LIVE,
          viewerWidth,
          declined: { onJoin: noop },
          people: [OTHERS[0] as RoomPerson, ME],
          lookingIn,
        });
        const grid = room.querySelector(".sys-room-view-grid") as Element;
        const style = getComputedStyle(grid);
        expect(style.position).toBe("static");
        expect(style.opacity).toBe("0.4");
        const header = rect(room.querySelector("header") as Element);
        for (const tile of room.querySelectorAll(".sys-room-tile")) {
          expect(rect(tile).top).toBeGreaterThanOrEqual(header.bottom);
          expect(rect(tile).bottom).toBeLessThanOrEqual(height);
        }
        const line = room.querySelector(".sys-room-looking-in");
        if (lookingIn > 0) {
          expect(getComputedStyle(line as Element).opacity).toBe("1");
        } else {
          expect(line).toBeNull();
        }
      });
    }
  }
});
