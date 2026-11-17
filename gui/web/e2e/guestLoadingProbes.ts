import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { fontsReady } from "./fontsReady";
import {
  holdScripts,
  installBootProbes,
  reactDrewLoadingHeader,
} from "./guestBootProbes";
import { holdFirstProject } from "./guestLink";

export type Rect = { x: number; y: number; w: number; h: number };

export type ShiftEntry = {
  value: number;
  at: number;
  sources: { node: string; from: Rect; to: Rect }[];
};

type Probes = {
  shifts: ShiftEntry[];
  /** `html[data-shell]` in the first microtask after `.stage-frame--guest` was added; null until it was. */
  shellAtFrame: string | null;
  /** Every text the header's visible title (the studio's or the loading screen's) held, with when it first did. */
  titles: { at: number; text: string }[];
  /** The count of grey blocks after every change to the page, until the studio frame was added. */
  blocks: { at: number; count: number }[];
  firstLoadingAt: number | null;
  stillLoadingAt: number | null;
  frameAt: number | null;
};

/**
 * Watches the page from before its first script: layout shifts with their
 * sources, `html[data-shell]` when the studio frame is added, the header
 * title's text, the grey blocks, and the loading screen's clock. One
 * MutationObserver that only counts and reads text, and a buffered
 * PerformanceObserver: nothing here reads layout or samples frames, so it does
 * not change the race it watches.
 */
export async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const out = {
      shifts: [] as unknown[],
      shellAtFrame: null as string | null,
      titles: [] as { at: number; text: string }[],
      blocks: [] as { at: number; count: number }[],
      firstLoadingAt: null as number | null,
      stillLoadingAt: null as number | null,
      frameAt: null as number | null,
    };
    (window as unknown as { __probes: typeof out }).__probes = out;
    const rect = (r: DOMRectReadOnly) => ({
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
    });
    const label = (n: Node | null) => {
      const el = n as Element | null;
      if (!el?.tagName) return "?";
      return `${el.tagName.toLowerCase()}${
        typeof el.className === "string" && el.className
          ? `.${el.className.split(" ")[0]}`
          : ""
      }`;
    };
    const take = (entries: PerformanceEntryList) => {
      for (const entry of entries) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources: {
            node: Node | null;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }[];
        };
        if (shift.hadRecentInput) continue;
        out.shifts.push({
          value: shift.value,
          at: shift.startTime,
          sources: shift.sources.map((s) => ({
            node: label(s.node),
            from: rect(s.previousRect),
            to: rect(s.currentRect),
          })),
        });
      }
    };
    const observer = new PerformanceObserver((list) => take(list.getEntries()));
    observer.observe({ type: "layout-shift", buffered: true });
    (window as unknown as { __takeShifts: () => void }).__takeShifts = () =>
      take(observer.takeRecords());
    let lastTitle: string | null = null;
    const look = () => {
      const now = performance.now();
      const root = document.documentElement;
      if (
        out.frameAt === null &&
        document.querySelector(".stage-frame--guest")
      ) {
        out.frameAt = now;
        out.shellAtFrame = root.dataset.shell ?? "unset";
      }
      if (out.frameAt === null) {
        if (
          out.firstLoadingAt === null &&
          document.querySelector("main.guest-loading")
        )
          out.firstLoadingAt = now;
        const count = document.querySelectorAll(".sys-skeleton-block").length;
        if (out.blocks.at(-1)?.count !== count)
          out.blocks.push({ at: now, count });
        if (
          out.stillLoadingAt === null &&
          document.body?.textContent?.includes("Still loading…")
        )
          out.stillLoadingAt = now;
      }
      const title = document.querySelector(".sys-header-title")?.textContent;
      if (title != null && title !== lastTitle) {
        lastTitle = title;
        out.titles.push({ at: now, text: title });
      }
    };
    new MutationObserver(look).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

/** The probes so far, with the layout shifts the observer has recorded but not yet delivered. */
export async function readProbes(page: Page): Promise<Probes> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __probes: Probes;
      __takeShifts: () => void;
    };
    w.__takeShifts();
    return w.__probes;
  });
}

/**
 * The studio has replaced the loading screen: the frame is up, the bar is not
 * busy, the title holds the episode's name and the version line is read.
 */
export async function landed(page: Page, name: string) {
  await expect(page.locator(".stage-frame--guest")).toBeVisible();
  await expect(page.locator(".sys-app-header-host")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(page.locator(".sys-header-title")).toHaveText(name);
  await expect(page.locator(".sys-header-sub")).not.toContainText(
    "Shared link",
  );
  await fontsReady(page);
}

/**
 * The header's right side has what presence brings: the host's avatar. A bar
 * that folds its right side into a menu (a phone 320 px wide) has none to wait
 * for.
 */
export async function rightSideArrived(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const right = document.querySelector(".sys-header-right");
    return (
      !right ||
      getComputedStyle(right).display === "none" ||
      right.querySelector(".avatar-face") !== null
    );
  });
}

/** Two animation frames in the page, so what an arrival moved has been laid out. */
export async function afterFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** Opens a review link and waits until its header has everything it will hold. */
export async function openLanded(page: Page, token: string, name: string) {
  await page.goto(`/r/${token}`);
  await landed(page, name);
  await rightSideArrived(page);
  await afterFrames(page);
}

/**
 * Waits for what arrives after the studio has landed, each on its own state:
 * the transcript's first word and the guest's own avatar in the header's right
 * side (the presence answer). On a phone it also checks that the Listen
 * strip's scrubber is in the page: the strip is part of the studio frame and
 * is there from its first paint, so this is not a late arrival and is met at
 * once; it makes the test fail at its time-out if a phone has no strip. Then
 * two animation frames pass in the page, so the shifts those arrivals cause
 * have been laid out and recorded. Each is a locator wait that fails at the
 * test timeout if the thing never comes; none is a pause.
 */
export async function lateArrivals(page: Page, touch: boolean): Promise<void> {
  await page
    .locator(".stage-host-guest-script .sys-script-word")
    .first()
    .waitFor({ state: "attached" });
  await rightSideArrived(page);
  if (touch)
    await page
      .locator(".sys-listen-dock-strip .sys-overview")
      .first()
      .waitFor({ state: "attached" });
  await afterFrames(page);
}

export const shiftSum = (probes: Probes) =>
  probes.shifts.reduce((sum, entry) => sum + entry.value, 0);

/** The header bar's and its title's boxes now. The title is the grey block while the loading screen has no name. */
export async function headerBoxes(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const host = document.querySelector(".sys-app-header-host");
    return {
      host: box(host),
      title: box(host?.querySelector(".sys-header-title")),
      block: box(host?.querySelector(".sys-skeleton-block--title")),
    };
  });
}

export const HEADER_HEIGHT = { phone: 45, desktop: 49 } as const;
export const SHIFT_BUDGET = 0.002;
export const ALL = ["x", "y", "w", "h"] as const;
export const NOT_WIDTH = ["x", "y", "h"] as const;

/** Soft-checks that `got` is `want` within `tolerance` px on each of `keys`. */
export const near = (
  got: Rect | null,
  want: Rect | null,
  tolerance = 1,
  keys: readonly (keyof Rect)[] = ALL,
  state = "",
) => {
  expect.soft(got, "the title has a box").not.toBeNull();
  expect.soft(want, "the title has a box to compare with").not.toBeNull();
  if (!got || !want) return;
  for (const key of keys)
    expect
      .soft(
        Math.abs(got[key] - want[key]),
        `${state} ${key}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`,
      )
      .toBeLessThanOrEqual(tolerance);
};

/** The screen reader's line, not the "Still loading…" row that has a status role too. */
export const status = (page: Page) =>
  page.locator("main.guest-loading > [role=status]");

const SHOTS = process.env.GUEST_LOADING_SHOTS;

/** Saves a screenshot under `GUEST_LOADING_SHOTS` when it is set; `clip` keeps only that part of the page. */
export async function shot(page: Page, name: string, clip?: Rect) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({
    path: join(SHOTS, `${name}.png`),
    clip: clip && { x: clip.x, y: clip.y, width: clip.w, height: clip.h },
    animations: "disabled",
  });
}

export const SHOTS_ON = SHOTS !== undefined;

/** Every visible thing in the header bar, with its box, and the bar's own box and rule. */
export type Inventory = {
  bar: Rect;
  /** The bar's bottom border: the last pixel row of its box. */
  rule: number;
  items: { name: string; box: Rect }[];
};

/**
 * What the header bar holds now. The coach tip's bubble is a popup meant to
 * hang under the bar and is left out, as are an icon's own strokes and the
 * screen-reader-only text.
 */
export async function headerInventory(page: Page): Promise<Inventory> {
  return page.evaluate(() => {
    const host = document.querySelector(".sys-app-header-host");
    if (!host) throw new Error("the page has no header bar");
    const rect = (b: DOMRect) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
    const items: Inventory["items"] = [];
    for (const el of host.querySelectorAll("*")) {
      if (el.closest(".sys-coach-tip")) continue;
      const svg = el.closest("svg");
      if (svg && svg !== el) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      const cls = typeof el.className === "string" ? el.className : "";
      const label = el.getAttribute("aria-label");
      items.push({
        name: `${el.tagName.toLowerCase()}${cls ? `.${cls.split(" ")[0]}` : ""}${label ? ` "${label}"` : ""}`,
        box: rect(box),
      });
    }
    return {
      bar: rect(host.getBoundingClientRect()),
      rule: Number.parseFloat(getComputedStyle(host).borderBottomWidth),
      items,
    };
  });
}

/** What of the header lies above the bar or reaches its rule, each with how far. */
export function reachingPast(inventory: Inventory): string[] {
  const inner = inventory.bar.y + inventory.bar.h - inventory.rule;
  const past: { by: number; text: string }[] = [];
  for (const { name, box } of inventory.items) {
    const under = box.y + box.h - inner;
    if (under > 0.05)
      past.push({
        by: under,
        text: `${name} ends ${under.toFixed(1)} px past the bar's inner edge`,
      });
    const over = inventory.bar.y - box.y;
    if (over > 0.05)
      past.push({
        by: over,
        text: `${name} begins ${over.toFixed(1)} px above the bar`,
      });
  }
  return past.sort((a, b) => b.by - a.by).map((p) => p.text);
}

export type TargetReport = {
  name: string;
  box: Rect;
  /** The area, `side` wide and tall at least, that must press the control: it holds the control's box and lies where the control answers. */
  area: Rect;
  /** The longest stretch, in px, over which the control answers a press in its middle column, inside the bar. */
  tall: number;
  answered: number;
  asked: number;
  /** What answers a press 1 px under the bar's box, in the control's middle column, when it is in the header; null when it is not. */
  under: string | null;
};

/**
 * Where a press would land. For each visible button in the header bar (the
 * coach tip's own Dismiss left out), the longest stretch inside the bar over
 * which it answers `elementFromPoint` down its middle column is found, and
 * the area at least `side` px wide and tall that holds its box and lies on
 * that stretch (or, when the stretch is shorter, as near its centre as the bar
 * allows), and across the stretch it answers along its own row, is tried on a
 * grid of points: every point must answer the control or something in it. The
 * four rounded corners of the area are not tried. A press 1 px under the bar's
 * box, in the control's middle column, is also asked: `under` names what
 * answers it when that is part of the header. An area that runs to the
 * screen's edge is as wide as the screen leaves it. `shared` lists the points
 * of the bar that lie under two controls at once, which `elementFromPoint`
 * alone cannot show, since it names only the one on top. `only` narrows the
 * controls to those matching the selector.
 */
export async function pressTargets(
  page: Page,
  side: number,
  only?: string,
): Promise<{
  bar: Rect;
  rule: number;
  controls: TargetReport[];
  /** Two controls that both lie under the same point of the bar, one line each. */
  shared: string[];
}> {
  return page.evaluate(
    ({ side: want, only: selector }) => {
      const host = document.querySelector(".sys-app-header-host");
      if (!host) throw new Error("the page has no header bar");
      const bar = host.getBoundingClientRect();
      const rule = Number.parseFloat(getComputedStyle(host).borderBottomWidth);
      const inner = bar.bottom - rule;
      const clamp = (v: number, low: number, high: number) =>
        Math.min(Math.max(v, low), Math.max(low, high));
      const controls = [] as TargetReport[];
      const kept: HTMLElement[] = [];
      const nameOf = (el: Element) =>
        el.getAttribute("aria-label") ??
        (el.textContent ?? "").trim().slice(0, 30);
      for (const el of host.querySelectorAll<HTMLElement>(
        selector ?? "button, [role=button], a[href]",
      )) {
        if (el.closest(".sys-coach-tip")) continue;
        const box = el.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1) continue;
        kept.push(el);
        const answers = (px: number, py: number) => {
          const hit = document.elementFromPoint(px, py);
          return hit !== null && (hit === el || el.contains(hit));
        };
        const wide = Math.max(want, box.width);
        const h = Math.max(want, box.height);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        let run = { from: 0, to: 0 };
        let open: number | null = null;
        for (let py = Math.ceil(bar.top); py <= Math.floor(inner); py += 1) {
          const yes = py < inner && answers(cx, py + 0.5);
          if (yes && open === null) open = py;
          if (!yes && open !== null) {
            if (py - open > run.to - run.from) run = { from: open, to: py };
            open = null;
          }
        }
        const tall = run.to - run.from;
        const y =
          tall >= h - 0.5
            ? clamp(cy - h / 2, run.from, run.to - h)
            : clamp(cy - h / 2, bar.top, inner - h);
        // A control that grows its area toward one side only answers over a
        // run that is not centred on it.
        const across = { from: cx, to: cx };
        while (across.from > 0 && answers(across.from - 0.5, cy))
          across.from -= 1;
        while (across.to < window.innerWidth && answers(across.to + 0.5, cy))
          across.to += 1;
        // An area cannot reach past the screen's edge, so a run that starts
        // there is as wide as the screen leaves it.
        const atEdge =
          across.from <= 0 &&
          across.to - across.from < wide - 0.5 &&
          across.to >= box.right - 0.5;
        const w = atEdge ? across.to : wide;
        const x = atEdge
          ? 0
          : across.to - across.from >= w - 0.5
            ? clamp(cx - w / 2, across.from, across.to - w)
            : clamp(cx - w / 2, 0, window.innerWidth - w);
        let answered = 0;
        let asked = 0;
        for (let i = 0; i < 5; i += 1) {
          for (let j = 0; j < 5; j += 1) {
            // A rounded corner is not the control's to answer for.
            if ((i === 0 || i === 4) && (j === 0 || j === 4)) continue;
            const px = x + 1 + ((w - 2) * i) / 4;
            const py = y + 1 + ((h - 2) * j) / 4;
            asked += 1;
            if (answers(px, py)) answered += 1;
          }
        }
        const hitUnder = document.elementFromPoint(cx, bar.bottom + 0.5);
        controls.push({
          name: nameOf(el),
          box: { x: box.x, y: box.y, w: box.width, h: box.height },
          area: { x, y, w, h },
          tall,
          answered,
          asked,
          under:
            hitUnder && host.contains(hitUnder)
              ? `${hitUnder.tagName.toLowerCase()}${hitUnder.className && typeof hitUnder.className === "string" ? `.${hitUnder.className.split(" ")[0]}` : ""}`
              : null,
        });
      }
      // elementFromPoint names only the control on top; the stack names every
      // control whose area lies under the point.
      const shared: string[] = [];
      const pairs = new Set<string>();
      for (let py = Math.ceil(bar.top) + 0.5; py < inner; py += 2) {
        for (let px = 0.5; px < window.innerWidth; px += 1) {
          const stack = document.elementsFromPoint(px, py);
          const under = kept.filter((el) => stack.includes(el));
          // Boxes that abut share a sub-pixel edge; an area is what reaches past a box.
          const pastBox = (el: Element) => {
            const b = el.getBoundingClientRect();
            return (
              px < b.left - 1 ||
              px > b.right + 1 ||
              py < b.top - 1 ||
              py > b.bottom + 1
            );
          };
          if (under.length < 2 || !under.some(pastBox)) continue;
          const names = under.map(nameOf).join('" and "');
          if (pairs.has(names)) continue;
          pairs.add(names);
          shared.push(`"${names}" both lie under x ${px}, y ${py}`);
        }
      }
      return {
        bar: { x: bar.x, y: bar.y, w: bar.width, h: bar.height },
        rule,
        controls,
        shared,
      };
    },
    { side, only },
  );
}

const overlap = (a: Rect, b: Rect) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 &&
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

const fmt = (r: Rect) =>
  `x ${r.x.toFixed(1)}..${(r.x + r.w).toFixed(1)}, y ${r.y.toFixed(1)}..${(r.y + r.h).toFixed(1)}`;

/** What is wrong with the press targets: one that does not answer in full, a control's box that ends under the bar's inner edge, a press under the bar that the header answers, two areas that cross. */
export function targetProblems(
  report: Awaited<ReturnType<typeof pressTargets>>,
) {
  const problems: string[] = [];
  const inner = report.bar.y + report.bar.h - report.rule;
  for (const c of report.controls) {
    if (c.answered < c.asked)
      problems.push(
        `"${c.name}" (${fmt(c.box)}) answers ${c.answered} of ${c.asked} points of its ${c.area.w.toFixed(0)} x ${c.area.h.toFixed(0)} area (${fmt(c.area)}), over ${c.tall} px of height inside the bar`,
      );
    if (c.box.y + c.box.h > inner + 0.05)
      problems.push(
        `"${c.name}" ends ${(c.box.y + c.box.h - inner).toFixed(1)} px past the bar's inner edge`,
      );
    if (c.under !== null)
      problems.push(
        `"${c.name}": a press 1 px under the bar, in its middle column, lands on ${c.under} in the header`,
      );
  }
  for (const [i, a] of report.controls.entries())
    for (const b of report.controls.slice(i + 1))
      if (overlap(a.area, b.area))
        problems.push(`"${a.name}" and "${b.name}" press over the same area`);
  return [...problems, ...report.shared];
}

/**
 * The header's title box as the page the server wrote has it, as React's
 * loading header has it, and as the landed studio has it. The script is held
 * after the page's own HTML, then the episode's read is held, so each state
 * lasts long enough to measure with the fonts loaded.
 */
export async function headerAcrossLanding(
  page: Page,
  token: string,
  name: string,
) {
  await installBootProbes(page, name);
  await holdScripts(page, 3000);
  await holdFirstProject(page, token, 2000);
  await page.goto(`/r/${token}`, { waitUntil: "commit" });
  await expect(page.locator(".sys-header-title")).toHaveText(name);
  await expect(status(page)).toHaveText(`Loading ${name}…`);
  await fontsReady(page);
  const written = await headerBoxes(page);
  await expect.poll(() => reactDrewLoadingHeader(page)).toBe(true);
  await expect(status(page)).toHaveText(`Loading ${name}…`);
  await fontsReady(page);
  const drawn = await headerBoxes(page);
  await landed(page, name);
  await rightSideArrived(page);
  await afterFrames(page);
  return { written, drawn, landed: await headerBoxes(page) };
}

/** Where a box in `got` is more than `tolerance` px from the same one in `want` on any side, or is missing, one line each. */
export function boxesMoved(
  got: Record<string, Rect>,
  want: Record<string, Rect>,
  tolerance: number,
): string[] {
  const moved: string[] = [];
  for (const label of new Set([...Object.keys(got), ...Object.keys(want)])) {
    const a = got[label];
    const b = want[label];
    if (!a || !b) {
      moved.push(`${label} is ${a ? "new" : "missing"}`);
      continue;
    }
    for (const side of ALL)
      if (Math.abs(a[side] - b[side]) > tolerance)
        moved.push(
          `${label} ${side} is ${a[side].toFixed(1)}, was ${b[side].toFixed(1)}`,
        );
  }
  return moved;
}
