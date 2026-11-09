import { composeStories } from "@storybook/react-vite";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";
import type { ScriptPaneProps } from "./ScriptPane";
import { ScriptPane } from "./ScriptPane";
import * as stories from "./ScriptPane.stories";

const { LockedWords } = composeStories(stories);
const baseTurns = LockedWords.args.turns as ScriptPaneProps["turns"];
const unlockedTurns = baseTurns.map((turn) => ({
  ...turn,
  words: turn.words.map(({ locked: _locked, ...word }) => word),
}));

let host: HTMLElement | undefined;
let root: Root | undefined;

beforeAll(async () => {
  await document.fonts.ready;
  // The reading face loads on first use: draw once so both renders below measure with it.
  await measure(baseTurns, "desktop", undefined, 640);
  release();
  await document.fonts.ready;
});

afterEach(() => {
  release();
  document.documentElement.removeAttribute("data-theme");
});

type Shot = {
  words: Array<{ left: number; top: number; width: number; height: number }>;
  locks: Array<{ lock: DOMRect; word: DOMRect; fontSize: number }>;
  heights: Array<{ height: number; lineHeight: number }>;
  scrollHeight: number;
};

function release() {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** The reading face may still be swapping in: wait until a word's width holds for several frames. */
async function settled(el: HTMLElement) {
  const first = () =>
    el.querySelector(".sys-script-word")?.getBoundingClientRect().width ?? 0;
  let last = -1;
  let same = 0;
  for (let at = 0; at < 120 && same < 6; at++) {
    await frame();
    await document.fonts.ready;
    const width = first();
    same = width === last ? same + 1 : 0;
    last = width;
  }
}

async function measure(
  turns: ScriptPaneProps["turns"],
  layout: "desktop" | "phone",
  playing: number | undefined,
  width: number,
): Promise<Shot> {
  host = document.createElement("div");
  host.style.cssText = `inline-size:${width}px;block-size:34rem;`;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    createElement(ScriptPane, {
      ...(LockedWords.args as ScriptPaneProps),
      turns,
      layout,
      playing,
    }),
  );
  await document.fonts.ready;
  await settled(host);
  const nodes = [...host.querySelectorAll<HTMLElement>(".sys-script-word")];
  const body = host.querySelector<HTMLElement>(".sys-script-body");
  if (!body) throw new Error("The Script body is missing");
  const shot: Shot = {
    words: [],
    locks: [],
    heights: [],
    scrollHeight: body.scrollHeight,
  };
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    shot.words.push({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    shot.heights.push({
      height: rect.height,
      lineHeight: Number.parseFloat(style.lineHeight),
    });
    const lock = node.querySelector(".sys-script-lock");
    if (lock) {
      shot.locks.push({
        lock: lock.getBoundingClientRect(),
        word: rect,
        fontSize: Number.parseFloat(style.fontSize),
      });
    }
  }
  return shot;
}

const cases = [
  ["desktop", 640, 1024, 768],
  ["phone", 390, 390, 844],
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const [layout, width, vw, vh] of cases) {
    for (const playing of [undefined, 37, 13]) {
      describe(`locked words in the ${layout} Script, ${theme}, playing ${playing ?? "none"}`, () => {
        it("keeps every word the same box as an unlocked word", async () => {
          await page.viewport(vw, vh);
          document.documentElement.setAttribute("data-theme", theme);
          const locked = await measure(baseTurns, layout, playing, width);
          release();
          const plain = await measure(unlockedTurns, layout, playing, width);
          expect(locked.locks).toHaveLength(3);
          expect(locked.words).toHaveLength(plain.words.length);
          for (const [at, rect] of locked.words.entries()) {
            const other = plain.words[at];
            for (const key of ["left", "top", "width", "height"] as const) {
              expect(
                Math.abs(rect[key] - (other?.[key] ?? Number.NaN)),
                `word ${at} ${key}: ${rect[key]} vs ${other?.[key]}`,
              ).toBeLessThan(0.01);
            }
          }
          expect(locked.scrollHeight).toBe(plain.scrollHeight);
          for (const { height, lineHeight } of locked.heights) {
            expect(Math.abs(height - lineHeight)).toBeLessThanOrEqual(0.5);
          }
          for (const { lock, word, fontSize } of locked.locks) {
            expect(lock.width).toBeGreaterThan(0);
            expect(lock.top).toBeGreaterThanOrEqual(word.top - 0.5);
            expect(lock.right).toBeLessThanOrEqual(word.right + 0.5);
            expect(lock.bottom).toBeLessThanOrEqual(
              word.top + 0.5 * fontSize + 0.5,
            );
          }
        }, 20_000);
      });
    }
  }
}

const ENDINGS = [")", "!", "\u201d", "\u2019"] as const;

/** The last glyph's ink box against the lock box, in page pixels, for a locked word ending in `ending`. */
function inkGap(ending: string) {
  const out: Array<{ gapX: number; gapY: number; lockW: number }> = [];
  const canvas = document.createElement("canvas").getContext("2d");
  if (!canvas) throw new Error("No canvas");
  for (const node of host?.querySelectorAll<HTMLElement>("[data-locked]") ??
    []) {
    const text = node.firstChild;
    const lock = node.querySelector(".sys-script-lock");
    if (!(text instanceof Text) || !lock) continue;
    const range = document.createRange();
    range.setStart(text, text.length - 1);
    range.setEnd(text, text.length);
    const cell = range.getBoundingClientRect();
    const style = getComputedStyle(node);
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const m = canvas.measureText(ending);
    const baseline = cell.top + m.fontBoundingBoxAscent;
    const inkRight = cell.left + m.actualBoundingBoxRight;
    const inkBottom = baseline + m.actualBoundingBoxDescent;
    const inkTop = baseline - m.actualBoundingBoxAscent;
    const box = lock.getBoundingClientRect();
    out.push({
      gapX: box.left - inkRight,
      gapY: Math.max(inkTop - box.bottom, box.top - inkBottom),
      lockW: box.width,
    });
  }
  return out;
}

describe("locked words ending in punctuation", () => {
  for (const ending of ENDINGS) {
    it(`grazes the ink of a word ending in ${ending} by a hairline at most`, async () => {
      await page.viewport(1024, 768);
      const turns = baseTurns.map((turn) => ({
        ...turn,
        words: turn.words.map((w) =>
          w.locked ? { ...w, text: `${w.text}${ending}` } : w,
        ),
      }));
      await measure(turns, "desktop", undefined, 640);
      const gaps = inkGap(ending);
      expect(gaps).toHaveLength(3);
      for (const { gapX, gapY } of gaps) {
        // The lock sits over the last glyph's column; it may only graze the
        // ink's top edge (measured: 0.19px for ! and quotes, 1.19px for ")".
        if (gapX < 0) expect(-gapY).toBeLessThanOrEqual(1.25);
      }
    }, 20_000);
  }
});

describe("locked words under forced colors", () => {
  it("draws the padlock body as an outline, not a fill", async () => {
    await page.viewport(1024, 768);
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "forced-colors", value: "active" }],
    });
    try {
      await measure(baseTurns, "desktop", undefined, 640);
      const rects = [
        ...(host?.querySelectorAll(".sys-script-lock rect") ?? []),
      ];
      expect(rects).toHaveLength(3);
      for (const rect of rects) {
        expect(getComputedStyle(rect).fill).toBe("none");
      }
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "forced-colors", value: "none" }],
      });
    }
  }, 20_000);
});
