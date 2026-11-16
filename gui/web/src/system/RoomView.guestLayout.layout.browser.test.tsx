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
