import { devices, expect, test } from "@playwright/test";
import {
  dbToGain,
  dbToY,
  ENVELOPE_TOP_DB,
  gainToDb,
} from "../src/system/envelopeMath";
import { storyUrl } from "./storyUrl";

/**
 * Real-layout checks for the System elements. The jsdom story run has no CSS,
 * so the sizes the design system names are measured here.
 */

async function open(
  page: import("@playwright/test").Page,
  id: string,
  width: number,
) {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(storyUrl(id, { theme: "light" }));
}

test("System/AppHeader shows the stage labels at 1280", async ({ page }) => {
  await open(page, "system-appheader--host", 1280);
  const tab = page.getByRole("tab", { name: /^Prepare/ });
  await expect(tab).toBeVisible();
  const label = tab.locator(".sys-stage-label");
  const box = await label.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(30);
  expect((await tab.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(90);
});

test("System/AppHeader shows icons only for inactive stages under 1100", async ({
  page,
}) => {
  await open(page, "system-appheader--host", 900);
  const tab = page.getByRole("tab", { name: /^Prepare/ });
  await expect(tab).toBeVisible();
  const box = await tab.locator(".sys-stage-label").boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(2);
  const edit = await page
    .getByRole("tab", { name: /^Edit/ })
    .locator(".sys-stage-label")
    .boundingBox();
  expect(edit?.width ?? 0).toBeGreaterThan(20);
});

for (const [shell, width, tab] of [
  ["desktop", 1280, 96],
  ["tablet", 1150, 88],
] as const) {
  test(`System/AppHeader stage tabs are ${tab} px wide on the ${shell} shell`, async ({
    page,
  }) => {
    await open(page, "system-appheader--host", width);
    await page.evaluate((value) => {
      document.documentElement.dataset.shell = value;
    }, shell);
    const prepare = page.getByRole("tab", { name: /^Prepare/ });
    await expect(prepare).toBeVisible();
    await expect
      .poll(async () => (await prepare.boundingBox())?.width)
      .toBe(tab);
  });
}

for (const [story, label] of [
  ["system-stagebar--record-live-phone", "live"],
  ["system-stagebar--record-live-phone-hour", "live over an hour"],
  ["system-stagebar--record-paused-phone", "paused"],
] as const) {
  for (const width of [320, 360, 390]) {
    test(`System/StageBar phone tab bar fits the Record pill (${label}) at ${width}`, async ({
      page,
    }) => {
      await open(page, story, width);
      await expect(page.getByRole("tab", { name: /^Record/ })).toBeVisible();
      const geometry = await page.evaluate(() => {
        const rect = (el: Element) => el.getBoundingClientRect();
        const tabs = [...document.querySelectorAll(".sys-stage-tab")];
        const record = tabs[0];
        const pill = record.querySelector(".sys-stage-badge--pill");
        const icon = record.querySelector("svg");
        if (!pill || !icon) throw new Error("Record tab has no pill or icon");
        return {
          documentWidth: document.documentElement.scrollWidth,
          list: rect(document.querySelector(".sys-stage-list") as Element),
          tabs: tabs.map((tab) => rect(tab)),
          pill: rect(pill),
          icon: rect(icon),
        };
      });
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      for (const tab of geometry.tabs) {
        expect(tab.width).toBeGreaterThanOrEqual(44);
        expect(tab.height).toBeGreaterThanOrEqual(44);
        expect(tab.left).toBeGreaterThanOrEqual(geometry.list.left);
        expect(tab.right).toBeLessThanOrEqual(geometry.list.right + 0.5);
      }
      const [record] = geometry.tabs;
      expect(geometry.pill.left).toBeGreaterThanOrEqual(record.left);
      expect(geometry.pill.right).toBeLessThanOrEqual(record.right);
      expect(geometry.pill.top).toBeGreaterThanOrEqual(
        geometry.icon.bottom - 1,
      );
    });
  }
}

test("System/Player expanded form stretches across its card", async ({
  page,
}) => {
  await open(page, "system-player--expanded", 360);
  // The story's play collapses and re-expands the Player, so read all three
  // boxes in one step and retry until the expanded form is on screen.
  const measure = () =>
    page.evaluate(() => {
      const rect = (el: Element | null | undefined) => {
        const box = el?.getBoundingClientRect();
        return box ? { x: box.x, width: box.width } : null;
      };
      const buttons = [...document.querySelectorAll("button")];
      return {
        card: rect(document.querySelector(".sys-player--expanded")),
        collapse: rect(
          buttons.find(
            (b) => b.getAttribute("aria-label") === "Collapse player",
          ),
        ),
        row: rect(
          buttons.find((b) => b.textContent?.includes("The long way round")),
        ),
      };
    });
  type Boxes = Awaited<ReturnType<typeof measure>>;
  const seen: Boxes[] = [];
  await expect
    .poll(async () => {
      const m = await measure();
      if (m.card && m.collapse && m.row) seen.push(m);
      return seen.length;
    })
    .toBeGreaterThan(0);
  const { card, collapse, row } = seen[0];
  if (!card || !collapse || !row) throw new Error("Player did not render");
  expect(card.x + card.width - (collapse.x + collapse.width)).toBeLessThan(24);
  expect(row.width).toBeGreaterThan(card.width - 48);
});

test("System/Sheet phone footer is a 48 px full-width primary on a fine pointer", async ({
  page,
}) => {
  await open(page, "system-sheet--phone-half", 360);
  const dialog = page.getByRole("dialog", { name: "Mix" });
  await expect(dialog).toBeVisible();
  const done = page.getByRole("button", { name: "Done" });
  const sheet = await dialog.boundingBox();
  const button = await done.boundingBox();
  if (!sheet || !button) throw new Error("Sheet did not render");
  expect(button.height).toBeGreaterThanOrEqual(47.5);
  expect(button.width).toBeGreaterThan(sheet.width - 48);
  expect(button.y).toBeGreaterThan(sheet.y + sheet.height / 2);
});

test("System/Toast holds the toast at rest", async ({ page }) => {
  await page.clock.install();
  await open(page, "system-toast--result", 1280);
  await expect(page.getByText("Cut 3 words")).toBeVisible();
  // Jump the page clock past the 10 s session-undo lifetime instead of waiting.
  await page.clock.fastForward(30_000);
  await expect(page.getByText("Cut 3 words")).toBeVisible();
});

test("System/Menu rows with a shortcut set the icon apart from the label", async ({
  page,
}) => {
  await open(page, "system-menu--more", 1280);
  await page.getByRole("button", { name: "More" }).click();
  const row = page.getByRole("menuitem", { name: /Split/ });
  await expect(row).toBeVisible();
  const gap = await row.evaluate((el) => {
    const icon = el.querySelector("svg")?.getBoundingClientRect();
    const label = el.querySelector(".ui-menu-item-label");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent?.includes("Split")) text = n;
    }
    if (!icon || !label || !text) return null;
    const range = document.createRange();
    range.selectNodeContents(text);
    const box = range.getBoundingClientRect();
    const rowBox = el.getBoundingClientRect();
    return {
      apart: box.left - icon.right,
      iconMid: icon.top + icon.height / 2,
      textMid: box.top + box.height / 2,
      rowMid: rowBox.top + rowBox.height / 2,
    };
  });
  if (!gap) throw new Error("Menu row did not render");
  expect(gap.apart).toBeGreaterThanOrEqual(8);
  expect(Math.abs(gap.iconMid - gap.textMid)).toBeLessThanOrEqual(2);
  expect(Math.abs(gap.iconMid - gap.rowMid)).toBeLessThanOrEqual(2);
  expect(Math.abs(gap.textMid - gap.rowMid)).toBeLessThanOrEqual(2);
});

test("System controls show the 2 px accent focus ring", async ({ page }) => {
  await open(page, "system-cover--empty", 1280);
  await expect(page.locator("#storybook-root button").first()).toBeVisible();
  // Tab can land on the preview body while the story is still mounting, so
  // press it until a button inside the story holds focus.
  await expect(async () => {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active?.closest("#storybook-root") || active.tagName !== "BUTTON") {
        return null;
      }
      const style = getComputedStyle(active);
      return { width: style.outlineWidth, offset: style.outlineOffset };
    });
    expect(ring).toEqual({ width: "2px", offset: "2px" });
  }).toPass();
});

test("System/Player follow pill X has a 44 px hit area at 360", async ({
  page,
}) => {
  await open(page, "system-player--following", 360);
  const x = page.getByRole("button", { name: /^Stop following/ });
  await expect(x).toBeVisible();
  const box = await x.boundingBox();
  if (!box) throw new Error("Pill X did not render");
  const reach = await x.evaluate(
    (el, [dx, dy]) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2 + dx,
        r.top + r.height / 2 + dy,
      );
      return hit === el;
    },
    [20, 0],
  );
  expect(reach).toBe(true);
});

test("System/Marker a chapter's span leaves the lane under it to the marker beneath", async ({
  page,
}) => {
  await open(page, "system-marker--range-under-chapter", 1280);
  const range = page.getByRole("button", { name: /^Comment by Maya/ });
  const chapter = page.getByRole("button", { name: /^Chapter Intro/ });
  await expect(range).toBeVisible();
  const box = await range.boundingBox();
  const chapterBox = await chapter.boundingBox();
  if (!box || !chapterBox) throw new Error("Markers did not render");
  const x = box.x + box.width * 0.65;
  expect(x).toBeGreaterThan(chapterBox.x + chapterBox.width);
  const hit = await page.evaluate(
    ([px, py]) =>
      document.elementFromPoint(px, py)?.closest("button")?.ariaLabel ?? null,
    [x, box.y + box.height / 2],
  );
  expect(hit).toMatch(/^Comment by Maya/);
  await page.mouse.move(x, box.y + box.height / 2);
  await expect(page.getByRole("tooltip")).not.toContainText("Intro");
});

test("System/Seam a coarse text pill leaves the lines around it to the text", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    baseURL: "http://127.0.0.1:6010",
  });
  const page = await context.newPage();
  await page.goto(storyUrl("system-seam--text-pill", { theme: "light" }));
  const pill = page.getByRole("button", { name: "Cut, 2.4 s removed" });
  await expect(pill).toBeVisible();
  const box = await pill.boundingBox();
  if (!box) throw new Error("Pill did not render");
  const hits = await page.evaluate(
    ([x, top, bottom, middle]) => {
      const at = (y: number) =>
        document.elementFromPoint(x, y)?.closest("button") !== null;
      return { above: at(top), below: at(bottom), pill: at(middle) };
    },
    [
      box.x + box.width / 2,
      box.y - 10,
      box.y + box.height + 10,
      box.y + box.height / 2,
    ],
  );
  await context.close();
  expect(hits).toEqual({ above: false, below: false, pill: true });
});

test("System/ScriptPane header is 40 px, the margin 88 px and the avatar 20 px", async ({
  page,
}) => {
  await open(page, "system-scriptpane--turns", 1280);
  const header = page.locator(".sys-script-header");
  await expect(header).toBeVisible();
  expect((await header.boundingBox())?.height).toBe(40);
  expect(
    (await page.locator(".sys-script-margin").first().boundingBox())?.width,
  ).toBe(88);
  expect(
    (await page.locator(".sys-person-avatar").first().boundingBox())?.width,
  ).toBe(20);
});

test("System/ScriptPane header buttons and the Back to playhead pill reach 44 px under a coarse pointer", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    baseURL: "http://127.0.0.1:6010",
  });
  const page = await context.newPage();
  await page.goto(
    storyUrl("system-scriptpane--back-to-playhead", { theme: "light" }),
  );
  const names = [
    "Find in transcript",
    "Show cut text",
    "Follow the playhead",
    "Back to playhead",
  ];
  const reach = [];
  for (const name of names) {
    const target = page.getByRole("button", { name });
    await expect(target).toBeVisible();
    reach.push(
      await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = (x: number, y: number) =>
          document.elementFromPoint(x, y)?.closest("button") === el;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        return {
          width: Math.round(r.width),
          height: Math.round(r.height),
          corners:
            at(cx - 19, cy - 19) &&
            at(cx + 19, cy - 19) &&
            at(cx - 19, cy + 19) &&
            at(cx + 19, cy + 19),
        };
      }),
    );
  }
  await context.close();
  expect(reach.map((r) => r.height)).toEqual([44, 44, 44, 44]);
  expect(reach.map((r) => r.width >= 44)).toEqual([true, true, true, true]);
  expect(reach.map((r) => r.corners)).toEqual([true, true, true, true]);
});

async function coarsePage(
  browser: import("@playwright/test").Browser,
  id: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    ...(viewport ? { viewport } : {}),
    baseURL: "http://127.0.0.1:6010",
  });
  const page = await context.newPage();
  await page.goto(storyUrl(id, { theme: "light" }));
  return { context, page };
}

/** Whether the element at each offset below or above the centre of `target` is `target` itself. */
function hitsAround(
  target: import("@playwright/test").Locator,
  offsets: readonly number[],
) {
  return target.evaluate(
    (el, ys) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return ys.map(
        (dy) => document.elementFromPoint(x, cy + dy)?.closest("button") === el,
      );
    },
    [...offsets],
  );
}

test("System/ScriptPane a cut pill is hit-testable over 44 px under a coarse pointer, and a tap there selects it", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-scriptpane--with-cuts",
  );
  const pill = page.getByRole("button", { name: "Cut, 0.3 s removed" });
  await expect(pill).toBeVisible();
  const box = await pill.boundingBox();
  if (!box) throw new Error("Pill did not render");
  expect(box.height).toBeLessThan(24);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(await hitsAround(pill, [-21, -18, 0, 18, 21])).toEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(await hitsAround(pill, [-26, 26])).toEqual([false, false]);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y + 18);
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Welcome", exact: true }).tap();
  await expect(pill).toHaveAttribute("aria-pressed", "false");
  await page.touchscreen.tap(x, y - 18);
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await context.close();
});

test("System/ScriptPane a word and a suggested run keep the line they sit on under a coarse pointer", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "stages-edit-scriptpane--cuts-and-suggestions",
  );
  const word = page.getByRole("button", { name: "Welcome", exact: true });
  const run = page.getByRole("button", { name: /^Suggested cut: / });
  await expect(word).toBeVisible();
  await expect(run).toBeVisible();
  expect(await hitsAround(word, [-9, 0, 9])).toEqual([true, true, true]);
  expect(await hitsAround(run, [-9, 0, 9])).toEqual([true, true, true]);
  expect(await hitsAround(word, [-30, 30])).toEqual([false, false]);
  await context.close();
});

test("System/ScriptPane the speaker's name and the time are 44 px boxes, hit-testable all over, under a coarse pointer", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-scriptpane--turns",
  );
  for (const name of ["Anneke de Vries, change speaker", "Play from 12:19"]) {
    const target = page.getByRole("button", { name });
    await expect(target).toBeVisible();
    const reach = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = (x: number, y: number) =>
        document.elementFromPoint(x, y)?.closest("button") === el;
      return {
        height: Math.round(r.height),
        width: Math.round(r.width),
        corners:
          at(r.left + 3, r.top + 3) &&
          at(r.right - 3, r.top + 3) &&
          at(r.left + 3, r.bottom - 3) &&
          at(r.right - 3, r.bottom - 3),
      };
    });
    expect([reach.height >= 44, reach.width >= 44, reach.corners]).toEqual([
      true,
      true,
      true,
    ]);
  }
  await context.close();
});

test("System/ScriptPane the selection grips sit on the ends of the selected words and a drag moves an end by word", async ({
  page,
}) => {
  await open(page, "stages-edit-scriptpane--selection-handles", 1280);
  const first = page.getByRole("button", { name: "small (selected)" });
  const last = page.getByRole("button", { name: "can (selected)" });
  const start = page.locator(".sys-handle[data-edge=start]");
  const end = page.locator(".sys-handle[data-edge=end]");
  await expect(start).toBeVisible();
  const [a, b, startBox, endBox, knob] = await Promise.all([
    first.boundingBox(),
    last.boundingBox(),
    start.boundingBox(),
    end.boundingBox(),
    end.locator(".sys-handle-knob").boundingBox(),
  ]);
  if (!a || !b || !startBox || !endBox || !knob) {
    throw new Error("Nothing rendered");
  }
  expect(Math.abs(startBox.x + startBox.width / 2 - a.x)).toBeLessThanOrEqual(
    2,
  );
  expect(
    Math.abs(endBox.x + endBox.width / 2 - (b.x + b.width)),
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(startBox.y - a.y)).toBeLessThanOrEqual(3);
  const target = await page
    .getByRole("button", { name: "sound", exact: true })
    .boundingBox();
  if (!target) throw new Error("No word to drag to");
  // The grip reports where its caret goes, not the finger, so aim the knob
  // at the same offset below the caret that it was grabbed at.
  const grabY = knob.y + knob.height / 2;
  const caretY = endBox.y + endBox.height / 2;
  await page.mouse.move(knob.x + knob.width / 2, grabY);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width - 2,
    target.y + target.height / 2 + (grabY - caretY),
    { steps: 6 },
  );
  await page.mouse.up();
  await expect(page.getByRole("status")).toHaveText(
    "4 words selected: small room can sound",
  );
});

test("System/ScriptPane a grip's region reaches only toward its knob, so the words beside it keep their taps, and a tap in the region lands on the word under it", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "stages-edit-scriptpane--phone-selection-handles",
  );
  const end = page.locator(".sys-handle[data-edge=end]");
  const start = page.locator(".sys-handle[data-edge=start]");
  await expect(end).toBeVisible();
  const probe = (edge: "start" | "end") =>
    page.evaluate((which) => {
      const grip = document.querySelector<HTMLElement>(
        `.sys-handle[data-edge=${which}]`,
      );
      if (!grip) throw new Error("No grip");
      const r = grip.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const mid = r.top + r.height / 2;
      const hit = (px: number, py: number) => {
        const el = document.elementFromPoint(px, py);
        return {
          grip: el?.closest(".sys-handle") === grip,
          word: el?.closest("button")?.textContent ?? null,
        };
      };
      const toward = which === "end" ? 1 : -1;
      const edge = which === "end" ? r.bottom : r.top;
      return {
        width: Math.round(r.width),
        onLine: [hit(x - 20, mid), hit(x, mid), hit(x + 20, mid)].map(
          (h) => h.grip,
        ),
        sideWord: hit(x + 20, mid).word,
        region: [8, 22, 40].map((d) => hit(x, edge + toward * d).grip),
        wide: [
          hit(x - 20, edge + toward * 12).grip,
          hit(x + 20, edge + toward * 12).grip,
        ],
        beyond: hit(x, edge + toward * 50).grip,
        away: hit(x, edge - toward * 12).grip,
      };
    }, edge);
  for (const edge of ["end", "start"] as const) {
    const reach = await probe(edge);
    expect(reach.width).toBe(44);
    expect(reach.onLine).toEqual([false, false, false]);
    expect(reach.sideWord).not.toBeNull();
    expect(reach.region).toEqual([true, true, true]);
    expect(reach.wide).toEqual([true, true]);
    expect(reach.beyond).toBe(false);
    expect(reach.away).toBe(false);
  }
  const box = await start.boundingBox();
  if (!box) throw new Error("No start grip");
  const y = box.y - 12;
  const { x, under } = await page.evaluate(
    ([cx, py]) => {
      const wordAt = (px: number) =>
        document
          .elementsFromPoint(px, py)
          .filter((el) => !el.closest(".sys-handle"))
          .map((el) => el.closest("button"))
          .find((el) => el !== null)?.textContent ?? null;
      for (let dx = -20; dx <= 20; dx += 2) {
        const found = wordAt(cx + dx);
        if (found !== null) return { x: cx + dx, under: found };
      }
      return { x: cx, under: null };
    },
    [box.x + box.width / 2, y],
  );
  expect(under).not.toBeNull();
  await page.touchscreen.tap(x, y);
  // The tap selected that word, so the grips now sit on it alone.
  await expect(page.locator(".sys-handle")).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent))
    .toBe(under);
  await expect(page.getByRole("status")).toHaveText(
    `1 word selected: ${under}`,
  );
  await context.close();
});

test("System/ScriptPane a real touch anywhere on the end knob, top edge to bottom edge, lands on the grip and a touch drag from its centre moves the end", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "stages-edit-scriptpane--phone-selection-handles",
  );
  const knobBox = async () => {
    await expect(page.locator(".sys-handle[data-edge=end]")).toBeVisible();
    const box = await page
      .locator(".sys-handle[data-edge=end] .sys-handle-knob")
      .boundingBox();
    if (!box) throw new Error("No knob");
    return box;
  };
  const pressed = async (fraction: number) => {
    await page.goto(
      storyUrl("stages-edit-scriptpane--phone-selection-handles", {
        theme: "light",
      }),
    );
    const knob = await knobBox();
    await page.evaluate(() => {
      const log: string[] = [];
      Object.assign(window, { downs: log });
      document.addEventListener(
        "pointerdown",
        (event) => log.push((event.target as HTMLElement).className),
        true,
      );
    });
    await page.touchscreen.tap(
      knob.x + knob.width / 2,
      knob.y + knob.height * fraction,
    );
    return page.evaluate(
      () => (window as unknown as { downs: string[] }).downs,
    );
  };
  for (const fraction of [0.05, 0.3, 0.5, 0.7, 0.95]) {
    const downs = await pressed(fraction);
    expect(downs).toHaveLength(1);
    expect(downs[0]).toMatch(/sys-handle/);
  }
  await page.goto(
    storyUrl("stages-edit-scriptpane--phone-selection-handles", {
      theme: "light",
    }),
  );
  const knob = await knobBox();
  const target = await page
    .getByRole("button", { name: "sound", exact: true })
    .boundingBox();
  if (!target) throw new Error("No word to drag to");
  const from = { x: knob.x + knob.width / 2, y: knob.y + knob.height / 2 };
  const grip = await page.locator(".sys-handle[data-edge=end]").boundingBox();
  if (!grip) throw new Error("No grip");
  const caretY = grip.y + grip.height / 2;
  const to = {
    x: target.x + target.width - 2,
    y: target.y + target.height / 2 + (from.y - caretY),
  };
  const cdp = await context.newCDPSession(page);
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    point?: { x: number; y: number },
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: point ? [{ ...point, id: 1 }] : [],
    });
  await touch("touchStart", from);
  for (let step = 1; step <= 8; step += 1) {
    await touch("touchMove", {
      x: from.x + ((to.x - from.x) * step) / 8,
      y: from.y + ((to.y - from.y) * step) / 8,
    });
  }
  await touch("touchEnd");
  await expect(page.getByRole("status")).toHaveText(
    "4 words selected: small room can sound",
  );
  await context.close();
});

test("System/ScriptPane a tap on the word beside a grip selects nothing the grip took", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "stages-edit-scriptpane--phone-selection-handles",
  );
  const end = page.locator(".sys-handle[data-edge=end]");
  await expect(end).toBeVisible();
  const box = await end.boundingBox();
  if (!box) throw new Error("No end grip");
  const x = box.x + box.width / 2 + 20;
  const y = box.y + box.height / 2;
  const word = await page.evaluate(
    ([px, py]) => document.elementFromPoint(px, py)?.textContent ?? null,
    [x, y],
  );
  expect(word).not.toBeNull();
  await page.touchscreen.tap(x, y);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent))
    .toBe(word);
  await context.close();
});

test("System/ScriptPane Up and Down move the caret by line", async ({
  page,
}) => {
  await open(page, "system-scriptpane--reading", 1280);
  const welcome = page.getByRole("button", { name: "Welcome", exact: true });
  await welcome.focus();
  const tops = async () =>
    page.evaluate(
      () => document.activeElement?.getBoundingClientRect().top ?? -1,
    );
  const first = await tops();
  await page.keyboard.press("ArrowDown");
  const second = await tops();
  expect(second).toBeGreaterThan(first + 20);
  await page.keyboard.press("ArrowUp");
  expect(await tops()).toBe(first);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByRole("status")).toHaveText(/^\d\d words selected: /);
});

test("System/Clip hover shows the fade knobs and the edge zones, selected shows the trim tabs, and the label rule holds at 80 and 81 px", async ({
  page,
}) => {
  await open(page, "system-clip--idle", 1280);
  const body = page.getByRole("button", { name: "Maya, take 2" });
  const opacity = (selector: string) =>
    page
      .locator(selector)
      .evaluate((el) => getComputedStyle(el).opacity as string);
  const knob = ".sys-clip-handle[data-handle=fade-in] .sys-clip-grip";
  const tab = ".sys-clip-handle[data-handle=trim-out] .sys-clip-grip";
  await expect(body).toBeVisible();
  expect([await opacity(knob), await opacity(tab)]).toEqual(["0", "0"]);
  await body.hover();
  expect([await opacity(knob), await opacity(tab)]).toEqual(["1", "0"]);
  const zone = await page
    .locator(".sys-clip-handle[data-handle=trim-in]")
    .boundingBox();
  const clip = await page.locator(".sys-clip").boundingBox();
  if (!zone || !clip) throw new Error("Clip did not render");
  expect(zone.width).toBe(8);
  const edge = await page.evaluate(
    ([x, y]) =>
      document
        .elementFromPoint(x, y)
        ?.closest("[data-handle]")
        ?.getAttribute("data-handle"),
    [clip.x + 3, clip.y + clip.height / 2],
  );
  expect(edge).toBe("trim-in");
  await page.goto(storyUrl("system-clip--selected", { theme: "light" }));
  await expect(page.locator(".sys-clip[data-selected]")).toBeVisible();
  expect(await opacity(tab)).toBe("1");
  const tabBox = await page.locator(tab).boundingBox();
  expect([tabBox?.width, tabBox?.height]).toEqual([6, 24]);
  await page.goto(storyUrl("system-clip--label-rule", { theme: "light" }));
  await expect(page.locator(".sys-clip")).toHaveCount(2);
  const widths = await page
    .locator(".sys-clip")
    .evaluateAll((clips) =>
      clips.map((c) => [
        Math.round(c.getBoundingClientRect().width),
        c.querySelector(".sys-clip-label") !== null,
      ]),
    );
  expect(widths).toEqual([
    [80, false],
    [81, true],
  ]);
});

const handleAt = (
  page: import("@playwright/test").Page,
  x: number,
  y: number,
) =>
  page.evaluate(
    ([px, py]) => {
      const hit = document.elementFromPoint(px, py);
      return (
        hit?.closest("[data-handle]")?.getAttribute("data-handle") ??
        (hit?.closest(".sys-clip-body")
          ? `body:${hit.closest(".sys-clip")?.getAttribute("data-clip-id")}`
          : (hit?.className ?? "none"))
      );
    },
    [x, y],
  );

test("System/Clip selected handles are 44 px under a coarse pointer, stay inside the clip, and a real touch lands on them", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, "system-clip--touch");
  await expect(page.locator(".sys-clip[data-selected]")).toBeVisible();
  const clip = await page.locator(".sys-clip").boundingBox();
  if (!clip) throw new Error("Clip did not render");
  const sizes = await page.locator(".sys-clip-handle").evaluateAll((handles) =>
    handles.map((h) => {
      const r = h.getBoundingClientRect();
      return [
        h.getAttribute("data-handle"),
        Math.round(r.left),
        Math.round(r.right),
        Math.round(r.width),
        Math.round(r.height),
      ];
    }),
  );
  const named = (prefix: string) =>
    sizes.filter(([name]) => String(name).startsWith(prefix));
  expect(named("trim").map(([, , , w]) => w)).toEqual([44, 44]);
  expect(named("fade").map(([, , , w, h]) => [w, h])).toEqual([
    [44, 44],
    [44, 44],
  ]);
  for (const [, left, right] of sizes) {
    expect(Number(left)).toBeGreaterThanOrEqual(Math.floor(clip.x));
    expect(Number(right)).toBeLessThanOrEqual(Math.ceil(clip.x + clip.width));
  }
  const fadeOut = await page
    .locator(".sys-clip-handle[data-handle=fade-out]")
    .boundingBox();
  if (!fadeOut) throw new Error("No fade knob");
  await page.evaluate(() => {
    const log: string[] = [];
    Object.assign(window, { downs: log });
    document.addEventListener(
      "pointerdown",
      (event) =>
        log.push(
          (event.target as HTMLElement)
            .closest("[data-handle]")
            ?.getAttribute("data-handle") ?? "none",
        ),
      true,
    );
  });
  for (const [dx, dy] of [
    [-19, 19],
    [19, 19],
    [0, 0],
  ]) {
    await page.touchscreen.tap(
      fadeOut.x + fadeOut.width / 2 + dx,
      fadeOut.y + fadeOut.height / 2 + dy,
    );
  }
  expect(
    await page.evaluate(() => (window as unknown as { downs: string[] }).downs),
  ).toEqual(["fade-out", "fade-out", "fade-out"]);
  await context.close();
});

test("System/Clip trim zones win the clip's edges over the fade knobs, and nothing of a selected clip reaches past its box, under touch and a mouse", async ({
  browser,
  page,
}) => {
  for (const coarse of [true, false]) {
    const view = coarse
      ? await coarsePage(browser, "system-clip--touch")
      : { context: null, page };
    if (!coarse) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(storyUrl("system-clip--selected", { theme: "light" }));
    }
    await expect(view.page.locator(".sys-clip[data-selected]")).toBeVisible();
    const clip = await view.page.locator(".sys-clip").boundingBox();
    if (!clip) throw new Error("Clip did not render");
    const top = clip.y + 4;
    const middle = clip.y + clip.height / 2;
    const inside = coarse ? 5 : 3;
    expect(await handleAt(view.page, clip.x + inside, top)).toBe("trim-in");
    expect(await handleAt(view.page, clip.x + inside, middle)).toBe("trim-in");
    expect(await handleAt(view.page, clip.x + clip.width - inside, top)).toBe(
      "trim-out",
    );
    for (const [x, y] of [
      [clip.x - 3, top],
      [clip.x - 20, top],
      [clip.x + clip.width + 3, top],
      [clip.x + clip.width + 20, top],
      [clip.x + clip.width / 2, clip.y - 3],
      [clip.x + clip.width / 2, clip.y + clip.height + 3],
    ]) {
      expect(await handleAt(view.page, x, y)).not.toMatch(/^(trim|fade)/);
    }
    await view.context?.close();
  }
});

test("System/Clip a tap beside a clip butted against a selected one lands on the neighbour, with a finger and a mouse", async ({
  browser,
  page,
}) => {
  const { context, page: phone } = await coarsePage(
    browser,
    "system-clip--butted",
  );
  const seam = async (target: import("@playwright/test").Page) => {
    const left = await target
      .getByRole("button", { name: "Maya, intro" })
      .boundingBox();
    if (!left) throw new Error("Clip did not render");
    return left.x + left.width;
  };
  const y = (await phone.locator(".sys-clip").first().boundingBox())?.y ?? 0;
  const seamX = await seam(phone);
  for (const inset of [6, 15, 20]) {
    expect(await handleAt(phone, seamX - inset, y + 14)).toBe("body:clip-a");
  }
  await phone.touchscreen.tap(seamX - 15, y + 30);
  await expect(
    phone.getByRole("button", { name: "Maya, intro" }),
  ).toHaveAttribute("aria-pressed", "true");
  await context.close();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `${storyUrl("system-clip--butted", { theme: "light" })}&args=touch:!false`,
  );
  const edge = await seam(page);
  const top = (await page.locator(".sys-clip").first().boundingBox())?.y ?? 0;
  for (const inset of [1, 3, 5]) {
    expect(await handleAt(page, edge - inset, top + 14)).toBe("body:clip-a");
  }
});

test("System/Clip a swipe starting on an unselected clip or a guest's clip pans the lane, and only a selected clip moves under one finger", async ({
  browser,
}) => {
  const touchDrag = async (
    cdp: import("@playwright/test").CDPSession,
    x: number,
    y: number,
    dx: number,
  ) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 10; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * step) / 10, y }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  for (const [id, label] of [
    ["stages-edit-tracks--three-tracks", "unselected clip"],
    ["stages-edit-tracks--read-only-guest", "guest clip"],
  ] as const) {
    const { context, page } = await coarsePage(browser, id);
    const cdp = await context.newCDPSession(page);
    const scroller = page.locator("[role=group][aria-label=Tracks]");
    const clip = await page
      .getByRole("button", { name: "Anneke, answer" })
      .boundingBox();
    if (!clip) throw new Error("Clip did not render");
    expect(await scroller.evaluate((el) => el.scrollLeft), label).toBe(0);
    await touchDrag(cdp, clip.x + 20, clip.y + clip.height / 2, -150);
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollLeft), { message: label })
      .toBeGreaterThan(100);
    await context.close();
  }
  const { context, page } = await coarsePage(browser, "system-clip--trimming");
  const cdp = await context.newCDPSession(page);
  const start = () =>
    page
      .getByRole("slider", { name: /^Trim start/ })
      .getAttribute("aria-valuenow");
  const body = page.locator(".sys-clip-body");
  const touchAction = () =>
    body.evaluate((el) => getComputedStyle(el).touchAction);
  const box = await body.boundingBox();
  if (!box) throw new Error("Clip did not render");
  expect(await touchAction()).toBe("none");
  expect(await start()).toBe("4");
  await touchDrag(cdp, box.x + box.width / 2, box.y + box.height / 2, 80);
  await expect.poll(start).toBe("6");
  await page.goto(
    `${storyUrl("system-clip--trimming", { theme: "light" })}&args=selected:!false`,
  );
  await expect(page.locator(".sys-clip")).toBeVisible();
  expect(await touchAction()).toBe("pan-x pan-y");
  const fresh = await body.boundingBox();
  if (!fresh) throw new Error("Clip did not render");
  await touchDrag(
    cdp,
    fresh.x + fresh.width / 2,
    fresh.y + fresh.height / 2,
    80,
  );
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  expect(await start()).toBe("4");
  expect(
    await page.locator(".sys-clip").getAttribute("data-dragging"),
  ).toBeNull();
  await context.close();
});

test("System/Clip Escape cancels a mouse drag wherever focus is, and the release that follows commits nothing", async ({
  page,
}) => {
  await open(page, "system-clip--trimming", 1280);
  const body = page.locator(".sys-clip-body");
  const start = () =>
    page
      .getByRole("slider", { name: /^Trim start/ })
      .getAttribute("aria-valuenow");
  const box = await body.boundingBox();
  if (!box) throw new Error("Clip did not render");
  expect(await start()).toBe("4");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, {
    steps: 5,
  });
  await expect(page.locator(".sys-clip")).toHaveAttribute(
    "data-dragging",
    "move",
  );
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press("Escape");
  await expect(page.locator(".sys-clip")).not.toHaveAttribute(
    "data-dragging",
    /.*/,
  );
  expect(await start()).toBe("4");
  await page.mouse.up();
  expect(await start()).toBe("4");
});

test("System/Clip draws its selection, handles and muted hatch with borders and outlines under forced colors", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(storyUrl("system-clip--muted", { theme: "light" }));
  const clip = page.locator(".sys-clip");
  await expect(clip).toBeVisible();
  const look = await page.evaluate(() => {
    const style = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(selector);
      return getComputedStyle(el);
    };
    return {
      clipBorder: style(".sys-clip").borderTopWidth,
      mutedEdge: style(".sys-clip-muted").borderInlineStartWidth,
      gripBorder: style(".sys-clip-grip").borderTopWidth,
    };
  });
  expect(look).toEqual({
    clipBorder: "1px",
    mutedEdge: "1px",
    gripBorder: "1px",
  });
  await page.goto(storyUrl("system-clip--selected", { theme: "light" }));
  const outline = await page
    .locator(".sys-clip")
    .evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
});

test("System/TrackHeader is 168, 280 and 56 px wide, shows row two on hover until something is set, and fits its level in the narrow column", async ({
  page,
}) => {
  await open(page, "system-trackheader--default", 1280);
  const header = page.locator(".sys-track");
  const mute = page.getByRole("button", { name: "Mute Maya Okafor" });
  await expect(header).toBeVisible();
  expect((await header.boundingBox())?.width).toBe(168);
  const shown = () =>
    page
      .locator(".sys-track-controls")
      .evaluate((el) => getComputedStyle(el).opacity);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.mouse.move(0, 0);
  expect(await shown()).toBe("0");
  await page.getByRole("button", { name: "Maya Okafor", exact: true }).hover();
  expect(await shown()).toBe("1");
  await expect(mute).toBeVisible();
  const fit = await page.locator(".sys-track-controls").evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    box: Math.round(
      el.querySelector(".sys-scrub-box")?.getBoundingClientRect().height ?? 0,
    ),
  }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  expect(fit.box).toBe(32);
  await page.goto(storyUrl("system-trackheader--default", { theme: "light" }));
  const toggle = await mute.boundingBox();
  expect([toggle?.width, toggle?.height]).toEqual([32, 32]);
  expect((await header.boundingBox())?.height).toBeLessThanOrEqual(72);
  for (const [id, width] of [
    ["system-trackheader--wide", 280],
    ["system-trackheader--phone", 56],
    ["system-trackheader--soloed", 168],
  ] as const) {
    await page.goto(storyUrl(id, { theme: "light" }));
    await expect(header).toBeVisible();
    expect((await header.boundingBox())?.width).toBe(width);
  }
  await expect(
    page.getByRole("button", { name: "Mute Maya Okafor" }),
  ).toBeVisible();
});

test("System/TrackHeader default form keeps the whole signed level inside its field at -12, -60 and 6 dB", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  for (const [db, text] of [
    [-12, "\u221212.0"],
    [-60, "\u221260.0"],
    [6, "6.0"],
  ] as const) {
    await page.goto(
      `${storyUrl("system-trackheader--default", { theme: "light" })}&args=level:${db}`,
    );
    const value = page.locator(".sys-track .sys-scrub-value");
    await expect(value).toHaveText(text);
    const fit = await page
      .locator(".sys-track .sys-scrub-box")
      .evaluate((box) => {
        const range = document.createRange();
        range.selectNodeContents(
          box.querySelector(".sys-scrub-value") as Element,
        );
        const text = range.getBoundingClientRect();
        const field = box.getBoundingClientRect();
        return {
          left: text.left - field.left,
          right: field.right - text.right,
        };
      });
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeGreaterThanOrEqual(0);
  }
});

test("Stages/Edit/Tracks header controls are 44 px, hit-testable all over, and real touches mute and solo under a coarse pointer", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "stages-edit-tracks--three-tracks",
  );
  const mute = page.getByRole("button", { name: "Mute Maya Okafor" });
  const solo = page.getByRole("button", { name: "Solo Maya Okafor" });
  const name = page.getByRole("button", { name: "Maya Okafor", exact: true });
  await expect(mute).toBeVisible();
  const headers = await page
    .locator(".sys-track")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(headers.every((height) => height <= 72)).toBe(true);
  for (const target of [mute, solo, name]) {
    const box = await target.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(await hitsAround(target, [-19, 0, 19])).toEqual([true, true, true]);
  }
  const m = await mute.boundingBox();
  const s = await solo.boundingBox();
  if (!m || !s) throw new Error("Controls did not render");
  await page.touchscreen.tap(m.x + m.width / 2 - 19, m.y + m.height / 2 + 19);
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await page.touchscreen.tap(s.x + s.width / 2 + 19, s.y + s.height / 2 - 19);
  await expect(solo).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Mute Anneke de Vries" }),
  ).toHaveAccessibleDescription(/silent because you soloed another track/);
  await context.close();
});

test("System/TrackHeader controls hidden by their opacity cannot be hit, and a drag from the empty header starts a reorder while one from a control does not", async ({
  page,
}) => {
  await open(page, "system-trackheader--reordering", 1280);
  const header = page.locator(".sys-track");
  const mute = page.getByRole("button", { name: "Mute Maya Okafor" });
  await expect(header).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.mouse.move(0, 0);
  expect(
    await page
      .locator(".sys-track-controls")
      .evaluate((el) => getComputedStyle(el).opacity),
  ).toBe("0");
  const m = await mute.boundingBox();
  if (!m) throw new Error("Mute did not render");
  const hitMute = () =>
    page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x, y)?.closest("button")?.ariaLabel ?? null,
      [m.x + m.width / 2, m.y + m.height / 2],
    );
  expect(await hitMute()).toBeNull();
  await page.evaluate(() => {
    const log: boolean[] = [];
    Object.assign(window, { drags: log });
    document.addEventListener("dragstart", (event) =>
      log.push(event.defaultPrevented),
    );
  });
  const box = await header.boundingBox();
  if (!box) throw new Error("Header did not render");
  await page.mouse.move(box.x + 3, box.y + 3);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 40, { steps: 6 });
  await page.mouse.up();
  expect(await hitMute()).toBe("Mute Maya Okafor");
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.down();
  await page.mouse.move(m.x + m.width / 2 + 30, m.y + m.height / 2 + 40, {
    steps: 6,
  });
  await page.mouse.up();
  expect(
    await page.evaluate(
      () => (window as unknown as { drags: boolean[] }).drags,
    ),
  ).toEqual([false, true]);
});

test("System/TrackHeader the phone select button is a 44 px target and a coarse header fits the shortest lane", async ({
  browser,
}) => {
  const phone = await coarsePage(browser, "system-trackheader--phone");
  const main = await phone.page.locator(".sys-track-main").boundingBox();
  expect([main?.width, main?.height]).toEqual([44, 44]);
  expect(
    await hitsAround(phone.page.locator(".sys-track-main"), [-19, 0, 19]),
  ).toEqual([true, true, true]);
  await phone.context.close();
  for (const [id, expected] of [
    ["system-trackheader--default", 168],
    ["system-trackheader--wide", 280],
  ] as const) {
    const { context, page } = await coarsePage(browser, id);
    const header = await page.locator(".sys-track").boundingBox();
    expect(header?.width).toBe(expected);
    expect(header?.height).toBeLessThanOrEqual(72);
    for (const name of ["Mute Maya Okafor", "Solo Maya Okafor"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect([box?.width, box?.height]).toEqual([44, 44]);
    }
    await context.close();
  }
});

function frames(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
}

/** A one-finger swipe by real touch events; `end` false leaves the finger down. */
async function swipe(
  cdp: import("@playwright/test").CDPSession,
  from: { x: number; y: number },
  by: { dx: number; dy: number },
  steps = 12,
) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [from],
  });
  for (let step = 1; step <= steps; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + (by.dx * step) / steps,
          y: from.y + (by.dy * step) / steps,
        },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

const rulerValue = (page: import("@playwright/test").Page) =>
  page
    .getByRole("slider", { name: "Timeline position" })
    .getAttribute("aria-valuenow")
    .then(Number);

test("System/Ruler is 24 px tall with 11 px mono labels 64 px apart, a 2 px playhead with a 10 px triangle and a 4 px band with 12 px handles", async ({
  page,
}) => {
  await open(page, "system-ruler--with-selection", 1280);
  const ruler = page.locator(".sys-ruler");
  await expect(ruler).toBeVisible();
  expect((await ruler.boundingBox())?.height).toBe(24);
  const { ticks, rulerRight } = await page.evaluate(() => {
    const rulerBox = document.querySelector(".sys-ruler");
    return {
      rulerRight: rulerBox?.getBoundingClientRect().right ?? 0,
      ticks: [...document.querySelectorAll<HTMLElement>(".sys-ruler-tick")].map(
        (el) => {
          const style = getComputedStyle(el);
          const range = document.createRange();
          range.selectNodeContents(el);
          const label = range.getBoundingClientRect();
          return {
            left: el.getBoundingClientRect().left,
            end: el.dataset.align === "end",
            labelLeft: label.left,
            labelRight: label.right,
            size: style.fontSize,
            mono: style.fontFamily.toLowerCase().includes("mono"),
          };
        },
      ),
    };
  });
  expect(ticks.length).toBeGreaterThan(4);
  for (const tick of ticks) {
    expect(tick.size).toBe("11px");
    expect(tick.mono).toBe(true);
  }
  // Ticks are 64 px apart; an end-aligned tick draws its label to the left of
  // its line, so its box is compared by the label (no overlap) instead.
  for (let i = 1; i < ticks.length; i++) {
    const tick = ticks[i];
    const prev = ticks[i - 1];
    if (!tick || !prev) continue;
    if (tick.end) {
      expect(tick.labelLeft).toBeGreaterThanOrEqual(prev.labelRight);
      expect(tick.labelRight).toBeLessThanOrEqual(rulerRight);
    } else {
      expect(tick.left - prev.left).toBeGreaterThanOrEqual(64);
    }
  }
  const look = await page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(selector);
      return el.getBoundingClientRect();
    };
    const triangle = getComputedStyle(
      document.querySelector(".sys-ruler-playhead") as Element,
      "::before",
    );
    return {
      playhead: box(".sys-ruler-playhead").width,
      triangle:
        Number.parseFloat(triangle.borderLeftWidth) +
        Number.parseFloat(triangle.borderRightWidth),
      band: box(".sys-ruler-selection").height,
      bandBottom: box(".sys-ruler-selection").bottom - box(".sys-ruler").bottom,
      handle: box(".sys-ruler-handle[data-edge=start]").width,
      grip: box(".sys-ruler-handle[data-edge=start] .sys-ruler-grip").width,
    };
  });
  expect(look).toEqual({
    playhead: 2,
    triangle: 10,
    band: 4,
    bandBottom: 0,
    handle: 12,
    grip: 12,
  });
});

test("System/Ruler a click seeks, a drag scrubs, and Escape puts the playhead back", async ({
  page,
}) => {
  await open(page, "system-ruler--zoomed", 1280);
  const ruler = page.getByRole("slider", { name: "Timeline position" });
  const box = await ruler.boundingBox();
  if (!box) throw new Error("Ruler did not render");
  const y = box.y + box.height / 2;
  expect(await rulerValue(page)).toBe(608.5);
  await page.mouse.click(box.x + 120, y);
  expect(await rulerValue(page)).toBe(607);
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, y, { steps: 6 });
  await page.mouse.move(box.x + 240, y, { steps: 6 });
  expect(await rulerValue(page)).toBe(610);
  await expect(page.locator(".sys-ruler")).toHaveAttribute(
    "data-scrubbing",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".sys-ruler")).not.toHaveAttribute(
    "data-scrubbing",
    /.*/,
  );
  expect(await rulerValue(page)).toBe(607);
  await page.mouse.up();
  await frames(page);
  expect(await rulerValue(page)).toBe(607);
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, y, { steps: 8 });
  await page.mouse.up();
  expect(await rulerValue(page)).toBe(608.5);
});

test("System/Ruler selection handles resize the selection with a mouse and Escape puts it back", async ({
  page,
}) => {
  await open(page, "system-ruler--with-selection", 1280);
  const end = page.getByRole("slider", { name: "Selection end" });
  const start = page.getByRole("slider", { name: "Selection start" });
  const box = await end.boundingBox();
  if (!box) throw new Error("Handle did not render");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y, { steps: 5 });
  await page.mouse.move(x + 60, y, { steps: 5 });
  await expect(end).toHaveAttribute("aria-valuenow", "617");
  await expect(end).toHaveAttribute("data-dragging", "true");
  await page.keyboard.press("Escape");
  await expect(end).toHaveAttribute("aria-valuenow", "614");
  await page.mouse.up();
  await expect(end).toHaveAttribute("aria-valuenow", "614");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 400, y, { steps: 10 });
  await page.mouse.up();
  await expect(end).toHaveAttribute("aria-valuenow", "608.01");
  await expect(start).toHaveAttribute("aria-valuenow", "608");
});

test("System/Ruler keys move the playhead, walk to the handles and nudge them, and the app keymap hears none of them", async ({
  page,
}) => {
  await open(page, "system-ruler--with-selection", 1280);
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, { heard });
    window.addEventListener("keydown", (event) => {
      if (!["Shift", "Alt", "Control", "Meta"].includes(event.key)) {
        heard.push(event.key);
      }
    });
  });
  await page.getByRole("slider", { name: "Timeline position" }).focus();
  await page.keyboard.press("ArrowRight");
  expect(await rulerValue(page)).toBe(611);
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await rulerValue(page)).toBe(561);
  await page.keyboard.press("Alt+ArrowRight");
  const start = page.getByRole("slider", { name: "Selection start" });
  await expect(start).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(start).toHaveAttribute("aria-valuenow", "608.01");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(start).toHaveAttribute("aria-valuenow", "608.11");
  await page.keyboard.press("Tab");
  const heard = await page.evaluate(
    () => (window as unknown as { heard: string[] }).heard,
  );
  expect(heard.filter((key) => key.startsWith("Arrow"))).toEqual([]);
  expect(heard).toContain("Tab");
});

test("System/Ruler under a coarse pointer has 44 px handles that stay on the ruler, and a real swipe leaves the playhead alone while a tap seeks", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, "system-ruler--phone");
  const cdp = await context.newCDPSession(page);
  const body = page.getByRole("slider", { name: "Timeline position" });
  await expect(body).toBeVisible();
  const ruler = await page.locator(".sys-ruler").boundingBox();
  const bar = await body.boundingBox();
  if (!ruler || !bar) throw new Error("Ruler did not render");
  expect(ruler.height).toBe(24);
  expect(await body.evaluate((el) => getComputedStyle(el).touchAction)).toBe(
    "pan-x pan-y",
  );
  expect(
    await page
      .locator(".sys-ruler-handle")
      .first()
      .evaluate((el) => getComputedStyle(el).touchAction),
  ).toBe("none");
  const handles = await page.locator(".sys-ruler-handle").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return [r.width, r.height, r.top, r.bottom];
    }),
  );
  expect(handles).toEqual([
    [44, 24, ruler.y, ruler.y + 24],
    [44, 24, ruler.y, ruler.y + 24],
  ]);
  const y = bar.y + 12;
  const before = await rulerValue(page);
  await swipe(cdp, { x: bar.x + 40, y }, { dx: 150, dy: 0 });
  await frames(page);
  const swiped = await rulerValue(page);
  expect(swiped).toBe(before);
  await swipe(cdp, { x: bar.x + 330, y: y - 6 }, { dx: 4, dy: 60 });
  await frames(page);
  expect(await rulerValue(page)).toBeCloseTo(swiped, 5);
  const after = await body.boundingBox();
  if (!after) throw new Error("Ruler left the page");
  const tapY = after.y + 12;
  await page.touchscreen.tap(after.x + 300, tapY);
  await expect.poll(() => rulerValue(page)).toBeCloseTo(600 + 300 / 24, 1);
  const start = await page
    .locator(".sys-ruler-handle[data-edge=start]")
    .boundingBox();
  if (!start) throw new Error("No handle");
  await page.touchscreen.tap(start.x + 3, tapY);
  await expect
    .poll(() => rulerValue(page))
    .toBeCloseTo(600 + (start.x + 3 - after.x) / 24, 1);
  await context.close();
});

test("System/Ruler under a coarse pointer a touch drag on a handle resizes the selection, and nothing of it reaches the row below", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, "system-ruler--phone");
  const cdp = await context.newCDPSession(page);
  const end = page.getByRole("slider", { name: "Selection end" });
  const box = await end.boundingBox();
  if (!box) throw new Error("Handle did not render");
  expect(await end.getAttribute("aria-valuenow")).toBe("610");
  const rows = await page.evaluate(
    ([x, top, bottom]) => {
      const at = (y: number) => {
        const el = document.elementFromPoint(x as number, y as number);
        return el?.closest(
          ".sys-ruler-handle, .sys-ruler-body, .sys-markers-track",
        )?.className;
      };
      return {
        above: at((top as number) - 1),
        inside: at((top as number) + 12),
        below: at(bottom as number),
      };
    },
    [box.x + box.width / 2, box.y, box.y + box.height],
  );
  await swipe(
    cdp,
    { x: box.x + box.width / 2, y: box.y + 12 },
    { dx: 48, dy: 0 },
  );
  await frames(page);
  await expect(end).toHaveAttribute("aria-valuenow", "611.5");
  expect(rows.inside).toContain("sys-ruler-handle");
  expect(rows.below).toContain("sys-markers-track");
  expect(rows.above ?? "").not.toContain("sys-ruler-handle");
  await context.close();
});

test("System/Ruler sits directly above the marker lane and each keeps its own pixels", async ({
  page,
}) => {
  await open(page, "system-ruler--above-markers", 1280);
  const ruler = await page.locator(".sys-ruler").boundingBox();
  const lane = await page.locator(".sys-markers").boundingBox();
  const lanes = await page.getByTestId("lanes-below").boundingBox();
  if (!ruler || !lane || !lanes) throw new Error("Stack did not render");
  expect(lane.y).toBe(ruler.y + ruler.height);
  expect(lanes.y).toBe(lane.y + lane.height);
  expect(lane.height).toBe(24);
  const joke = await page
    .getByRole("button", { name: /^Clip idea Best joke/ })
    .boundingBox();
  if (!joke) throw new Error("No bracket");
  const x = joke.x + joke.width / 2;
  const owners = await page.evaluate(
    ([px, a, b, c, d]) =>
      [a, b, c, d].map((y) => {
        const el = document.elementFromPoint(px as number, y as number);
        const owner = el?.closest(
          ".sys-ruler, .sys-markers, [data-testid=lanes-below]",
        );
        return owner?.matches("[data-testid=lanes-below]")
          ? "lanes-below"
          : owner?.className.split(" ")[0];
      }),
    [x, ruler.y + 23, lane.y, lane.y + 23, lanes.y],
  );
  expect(owners).toEqual([
    "sys-ruler",
    "sys-markers",
    "sys-markers",
    "lanes-below",
  ]);
});

test("System/Ruler draws its playhead, band and handles in system colors under forced colors", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(storyUrl("system-ruler--with-selection", { theme: "light" }));
  await expect(page.locator(".sys-ruler-playhead")).toBeVisible();
  const colors = await page.evaluate(() => {
    const color = (selector: string, property: "backgroundColor") => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(selector);
      return getComputedStyle(el)[property];
    };
    const probe = document.createElement("div");
    probe.style.forcedColorAdjust = "none";
    probe.style.backgroundColor = "Highlight";
    document.body.append(probe);
    const highlight = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      highlight,
      playhead: color(".sys-ruler-playhead", "backgroundColor"),
      band: color(".sys-ruler-selection", "backgroundColor"),
      grip: color(".sys-ruler-grip", "backgroundColor"),
      well: color(".sys-ruler", "backgroundColor"),
    };
  });
  expect(colors.playhead).toBe(colors.highlight);
  expect(colors.band).toBe(colors.highlight);
  expect(colors.grip).toBe(colors.highlight);
  expect(colors.playhead).not.toBe(colors.well);
});

test("System/MarkerLane is one 24 px lane with a 12 px flag, a 16 px pin, a 3 px span bar and a 2 px bracket line", async ({
  page,
}) => {
  await open(page, "system-markerlane--all-kinds", 1280);
  const lane = page.locator(".sys-markers");
  await expect(lane).toBeVisible();
  expect((await lane.boundingBox())?.height).toBe(24);
  const size = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      });
  expect(await size(".sys-marker[data-kind=chapter] svg")).toEqual([12, 12]);
  expect(await size(".sys-marker-bubble")).toEqual([16, 16]);
  expect((await size(".sys-marker-bar"))[1]).toBe(3);
  expect((await size(".sys-marker-line"))[1]).toBe(2);
  const buttons = await page
    .locator(".sys-marker-hit")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(buttons).toEqual([24, 24, 24, 24, 24, 24]);
});

test("System/MarkerLane a chapter's title is cut off at the next marker, and a mouse hover names the time", async ({
  page,
}) => {
  await open(page, "system-markerlane--all-kinds", 1280);
  const open1 = page.getByRole("button", { name: /^Chapter Cold open/ });
  const maya = page.getByRole("button", { name: /^Comment by Maya/ });
  const a = await open1.boundingBox();
  const b = await maya.boundingBox();
  if (!a || !b) throw new Error("Markers did not render");
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + 0.5);
  await maya.hover();
  await expect(page.getByRole("tooltip")).toContainText("0:09.0");
});

test("System/MarkerLane under a coarse pointer a marker's touch area is 44 px wide and exactly the lane tall, and never reaches the ruler, the lanes or a neighbour", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-markerlane--touch-targets",
  );
  const lane = await page.locator(".sys-markers").boundingBox();
  const pin = page.getByRole("button", { name: /^Comment by Maya/ });
  const box = await pin.boundingBox();
  if (!lane || !box) throw new Error("Lane did not render");
  const cx = box.x + box.width / 2;
  const probe = (x: number, y: number) =>
    page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px as number, py as number);
        return (
          el?.closest("button")?.getAttribute("aria-label") ??
          (el?.closest(".sys-ruler") ? "ruler" : null) ??
          (el?.closest("[data-testid=lanes-below]") ? "lanes" : null) ??
          el?.className ??
          null
        );
      },
      [x, y],
    );
  const middle = lane.y + 12;
  expect(await probe(cx, middle)).toMatch(/^Comment by Maya/);
  for (const dx of [-21, 21]) {
    expect(await probe(cx + dx, middle)).toMatch(/^Comment by Maya/);
    expect(await probe(cx + dx, lane.y + 1)).toMatch(/^Comment by Maya/);
    expect(await probe(cx + dx, lane.y + 23)).toMatch(/^Comment by Maya/);
  }
  for (const dx of [-23, 23]) {
    expect(await probe(cx + dx, middle)).not.toMatch(/Maya/);
  }
  expect(await probe(cx, lane.y - 1)).toBe("ruler");
  expect(await probe(cx, lane.y + 24)).toBe("lanes");
  await context.close();
});

test("System/MarkerLane under a coarse pointer a neighbour's touch area stops at half the gap, so two never overlap", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-markerlane--phone",
  );
  const lane = await page.locator(".sys-markers").boundingBox();
  if (!lane) throw new Error("Lane did not render");
  const y = lane.y + 12;
  const owners = await page.evaluate(
    ([top, left, width]) => {
      const out: (string | null)[] = [];
      for (
        let x = (left as number) + 1;
        x < (left as number) + (width as number);
        x += 1
      ) {
        const el = document.elementFromPoint(x, top as number);
        out.push(el?.closest("button")?.getAttribute("aria-label") ?? null);
      }
      return out;
    },
    [y, lane.x, lane.width],
  );
  const runs = owners.reduce<string[]>((all, name) => {
    if (name && all.at(-1) !== name) all.push(name);
    return all;
  }, []);
  expect(runs).toEqual([
    "Chapter Cold open, 0:01.0",
    "Comment by Maya, 0:09.0",
    "Comment by Anneke, 0:14.0 to 0:19.5",
    "Chapter Interview, 0:24.0",
    "Clip idea Best joke, approved, 0:30.0 to 0:42.0",
    "Clip idea Tight intro, proposed, 0:46.0 to 0:55.0",
  ]);
  await context.close();
});

test("System/MarkerLane a selected bracket's touch edges stay inside it and a real touch lands on them", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-markerlane--phone",
  );
  const joke = await page
    .getByRole("button", { name: /^Clip idea Best joke/ })
    .boundingBox();
  if (!joke) throw new Error("Bracket did not render");
  const jokeMarker = page.locator(".sys-marker", {
    has: page.getByRole("button", { name: /^Clip idea Best joke/ }),
  });
  const edges = await jokeMarker
    .locator(".sys-marker-edge")
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return [
          el.getAttribute("data-edge"),
          r.left,
          r.right,
          r.width,
          r.height,
        ];
      }),
    );
  expect(edges.map(([name, , , , h]) => [name, h])).toEqual([
    ["start", 24],
    ["end", 24],
  ]);
  for (const [, left, right] of edges) {
    expect(Number(left)).toBeGreaterThanOrEqual(Math.floor(joke.x));
    expect(Number(right)).toBeLessThanOrEqual(Math.ceil(joke.x + joke.width));
  }
  const hits = await page.evaluate(
    ([x0, x1, y]) =>
      [x0, x1].map((x) =>
        document
          .elementFromPoint(x as number, y as number)
          ?.closest("[data-edge]")
          ?.getAttribute("data-edge"),
      ),
    [joke.x + 6, joke.x + joke.width - 6, joke.y + 12],
  );
  expect(hits).toEqual(["start", "end"]);
  const centre = await page.evaluate(
    ([x, y]) =>
      document
        .elementFromPoint(x as number, y as number)
        ?.closest("button")
        ?.getAttribute("aria-label"),
    [joke.x + joke.width / 2, joke.y + 12],
  );
  expect(centre).toMatch(/^Clip idea Best joke/);
  await context.close();
});

test("System/MarkerLane only a selected marker moves under one finger, and a tap selects", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-markerlane--phone",
  );
  const cdp = await context.newCDPSession(page);
  const intro = page.getByRole("button", { name: /^Clip idea Tight intro/ });
  const joke = page.getByRole("button", { name: /^Clip idea Best joke/ });
  const name = (loc: import("@playwright/test").Locator) =>
    loc.getAttribute("aria-label");
  expect(await intro.evaluate((el) => getComputedStyle(el).touchAction)).toBe(
    "auto",
  );
  expect(await joke.evaluate((el) => getComputedStyle(el).touchAction)).toBe(
    "none",
  );
  const first = await name(intro);
  const box = await intro.boundingBox();
  if (!box) throw new Error("Bracket did not render");
  await swipe(
    cdp,
    { x: box.x + box.width / 2, y: box.y + 12 },
    { dx: 30, dy: 0 },
  );
  await frames(page);
  expect(await name(intro)).toBe(first);
  await expect(page.locator(".sys-readout")).toHaveCount(0);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + 12);
  await expect(intro).toHaveAttribute("aria-pressed", "true");
  const jokeBox = await joke.boundingBox();
  if (!jokeBox) throw new Error("Bracket did not render");
  await page.touchscreen.tap(jokeBox.x + jokeBox.width / 2, jokeBox.y + 12);
  await expect(joke).toHaveAttribute("aria-pressed", "true");
  const before = await name(joke);
  await swipe(
    cdp,
    { x: jokeBox.x + jokeBox.width / 2, y: jokeBox.y + 12 },
    { dx: -72, dy: 0 },
  );
  await frames(page);
  expect(before).toMatch(/0:30\.0 to 0:42\.0/);
  expect(await name(joke)).toMatch(/0:20\.0 to 0:32\.0/);
  await context.close();
});

test("System/MarkerLane a mouse drag moves a chapter with a readout chip above the pointer, and Escape puts it back", async ({
  page,
}) => {
  await open(page, "system-markerlane--dragging", 1280);
  const chapter = page.getByRole("button", { name: /^Chapter Interview/ });
  const box = await chapter.boundingBox();
  if (!box) throw new Error("Chapter did not render");
  const x = box.x + 6;
  const y = box.y + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y, { steps: 5 });
  await page.mouse.move(x + 60, y, { steps: 5 });
  const chip = page.locator(".sys-readout");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("+10.00 s");
  await expect(chip).toContainText("0:34.00");
  const chipBox = await chip.boundingBox();
  if (!chipBox) throw new Error("No chip");
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(box.y - 8);
  expect(
    Math.abs(chipBox.x + chipBox.width / 2 - (x + 60)),
  ).toBeLessThanOrEqual(2);
  await expect(chapter).toHaveAttribute("aria-label", /0:34\.0$/);
  await page.keyboard.press("Escape");
  await expect(chip).toHaveCount(0);
  await expect(chapter).toHaveAttribute("aria-label", /0:24\.0$/);
  await page.mouse.up();
  await frames(page);
  await expect(chapter).toHaveAttribute("aria-label", /0:24\.0$/);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 24, y, { steps: 8 });
  await page.mouse.up();
  await expect(chapter).toHaveAttribute("aria-label", /0:28\.0$/);
  await expect(chip).toHaveCount(0);
});

test("System/MarkerLane a double-click on the empty lane adds a chapter and opens its name, and one on a marker does not", async ({
  page,
}) => {
  await open(page, "system-markerlane--all-kinds", 1280);
  const lane = await page.locator(".sys-markers").boundingBox();
  if (!lane) throw new Error("Lane did not render");
  const chapter = await page
    .getByRole("button", { name: /^Chapter Interview/ })
    .boundingBox();
  if (!chapter) throw new Error("Chapter did not render");
  await page.mouse.dblclick(chapter.x + 4, chapter.y + 12);
  await expect(page.getByRole("textbox", { name: "Chapter name" })).toHaveCount(
    0,
  );
  await page.mouse.dblclick(lane.x + 130, lane.y + 12);
  const field = page.getByRole("textbox", { name: "Chapter name" });
  await expect(field).toBeFocused();
  await page.keyboard.type("Q and A");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: /^Chapter Q and A, 0:21\.7/ }),
  ).toBeVisible();
  await expect(field).toHaveCount(0);
});

test("System/MarkerLane the keyboard walks the markers, selects, and nudges a chapter, and the keymap hears no nudge", async ({
  page,
}) => {
  await open(page, "system-markerlane--all-kinds", 1280);
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, { heard });
    window.addEventListener("keydown", (event) => {
      if (!["Shift", "Alt", "Control", "Meta"].includes(event.key)) {
        heard.push(event.key);
      }
    });
  });
  const chapter = page.getByRole("button", { name: /^Chapter Interview/ });
  await page.getByRole("button", { name: /^Chapter Cold open/ }).focus();
  for (let n = 0; n < 3; n++) await page.keyboard.press("Tab");
  await expect(chapter).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(chapter).toHaveAttribute("aria-label", /0:24\.0$/);
  await page.keyboard.press("Enter");
  await expect(chapter).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(chapter).toHaveAttribute("aria-label", /0:24\.1$/);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(chapter).toHaveAttribute("aria-label", /0:25\.1$/);
  await page.keyboard.press("ArrowLeft");
  await expect(chapter).toHaveAttribute("aria-label", /0:25\.0$/);
  const heard = await page.evaluate(
    () => (window as unknown as { heard: string[] }).heard,
  );
  expect(heard.filter((key) => key === "ArrowLeft")).toEqual([]);
  expect(heard.filter((key) => key === "ArrowRight")).toEqual(["ArrowRight"]);
});

test("System/MarkerLane overlapping markers fold into a +N chip that opens a list, and Escape closes it", async ({
  page,
}) => {
  await open(page, "system-markerlane--dense", 1280);
  const chips = page.getByRole("button", { name: /more markers?$/ });
  const chip = chips.first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/^\+\d+$/);
  await chip.click();
  const rows = page.getByRole("menuitem");
  expect(await rows.count()).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(0);
  await chip.click();
  await rows.first().click();
  await expect(rows).toHaveCount(0);
  const lane = await page.locator(".sys-markers").boundingBox();
  const hits = await page.locator(".sys-marker-hit").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return [r.left, r.right];
    }),
  );
  if (!lane) throw new Error("Lane did not render");
  const sorted = [...hits].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]?.[0] ?? 0).toBeGreaterThanOrEqual(
      (sorted[i - 1]?.[1] ?? 0) - 1,
    );
  }
});

test("System/MarkerLane draws a selected marker with an outline and its handles in system colors under forced colors", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(storyUrl("system-markerlane--selected", { theme: "light" }));
  const joke = page.getByRole("button", { name: /^Clip idea Best joke/ });
  await expect(joke).toBeVisible();
  expect(await joke.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "solid",
  );
  const colors = await page.evaluate(() => {
    const grip = document.querySelector(".sys-marker-grip");
    if (!grip) throw new Error("No grip");
    const probe = document.createElement("div");
    probe.style.forcedColorAdjust = "none";
    probe.style.backgroundColor = "Highlight";
    document.body.append(probe);
    const highlight = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [getComputedStyle(grip).backgroundColor, highlight];
  });
  expect(colors[0]).toBe(colors[1]);
});

test("System/MarkerLane and System/Ruler fit a 360 px phone without scrolling sideways", async ({
  page,
}) => {
  for (const id of ["system-markerlane--phone", "system-ruler--phone"]) {
    await open(page, id, 360);
    await expect(page.locator(".sys-ruler")).toBeVisible();
    const fit = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
      ruler: document.querySelector(".sys-ruler")?.getBoundingClientRect()
        .right,
    }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.view);
    expect(fit.ruler).toBeLessThanOrEqual(fit.view);
  }
});

type Page = import("@playwright/test").Page;

const markerBox = (page: Page, name: RegExp) =>
  page
    .locator(".sys-marker", { has: page.getByRole("button", { name }) })
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    });

const tickLeft = (page: Page, label: string) =>
  page
    .locator(".sys-ruler-tick", { hasText: new RegExp(`^${label}$`) })
    .evaluate((el) => el.getBoundingClientRect().left);

/** The `aria-label` of the button, or the edge, under a point. */
const ownerAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px as number, py as number);
      return (
        el?.closest("[data-edge]")?.getAttribute("data-edge") ??
        el?.closest("button")?.getAttribute("aria-label") ??
        null
      );
    },
    [x, y],
  );

test("System/MarkerLane on a lane wider than 1024 px every marker sits at the x the ruler gives its time", async ({
  page,
}) => {
  await open(page, "system-markerlane--wide", 1700);
  const lane = await page.locator(".sys-markers").boundingBox();
  if (!lane) throw new Error("Lane did not render");
  expect(lane.width).toBeGreaterThan(1500);
  const third = await markerBox(page, /^Chapter Third minute/);
  const fourth = await markerBox(page, /^Chapter Fourth minute/);
  const clip = await markerBox(page, /^Clip idea Wide clip/);
  const pin = await page.locator(".sys-marker-bubble").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  });
  expect(third.left).toBeCloseTo(await tickLeft(page, "3:00"), 0);
  expect(fourth.left).toBeCloseTo(await tickLeft(page, "4:00"), 0);
  expect(pin).toBeCloseTo(await tickLeft(page, "3:30"), 0);
  expect(clip.left).toBeCloseTo(await tickLeft(page, "2:00"), 0);
  expect(clip.right).toBeCloseTo(await tickLeft(page, "4:30"), 0);
  expect(fourth.left - lane.x).toBeCloseTo(1440, 0);
});

test("System/MarkerLane a chapter and a comment inside a clip idea or a range comment are drawn on their own and reachable by pointer and keyboard", async ({
  page,
}) => {
  await open(page, "system-markerlane--nested", 1280);
  const lane = await page.locator(".sys-markers").boundingBox();
  if (!lane) throw new Error("Lane did not render");
  const y = lane.y + 12;
  await expect(page.getByRole("button", { name: /more marker/ })).toHaveCount(
    0,
  );
  const chapter = await markerBox(page, /^Chapter Inside chapter/);
  expect(chapter.left - lane.x).toBeCloseTo(400, 0);
  expect(await ownerAt(page, chapter.left + 6, y)).toMatch(
    /^Chapter Inside chapter/,
  );
  expect(await ownerAt(page, lane.x + 300, y)).toMatch(/^Clip idea Long clip/);
  expect(await ownerAt(page, lane.x + 928, y)).toMatch(/^Chapter Inside range/);
  expect(await ownerAt(page, lane.x + 860, y)).toMatch(
    /^Comment by Anneke, 3:30.0 to 4:20.0/,
  );
  const clip = page.getByRole("button", { name: /^Clip idea Long clip/ });
  await clip.focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: /^Chapter Inside chapter/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: /^Chapter Inside chapter/ }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("System/MarkerLane zoomed in, a chapter inside a clip idea whose start has scrolled off to the left is still drawn at its time", async ({
  page,
}) => {
  await open(page, "system-markerlane--nested-zoomed", 1280);
  const lane = await page.locator(".sys-markers").boundingBox();
  if (!lane) throw new Error("Lane did not render");
  await expect(page.getByRole("button", { name: /more marker/ })).toHaveCount(
    0,
  );
  const chapter = await markerBox(page, /^Chapter Inside chapter/);
  expect(chapter.left - lane.x).toBeCloseTo(300, 0);
  expect(await ownerAt(page, chapter.left + 6, lane.y + 12)).toMatch(
    /^Chapter Inside chapter/,
  );
  expect(await ownerAt(page, lane.x + 600, lane.y + 12)).toMatch(
    /^Clip idea Long clip/,
  );
  await page.getByRole("button", { name: /^Chapter Inside chapter/ }).click();
  await expect(
    page.getByRole("button", { name: /^Chapter Inside chapter/ }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("System/MarkerLane a +N chip on a selected bracket's start leaves the start edge 18 px that a pointer reaches, and the chip stays whole", async ({
  page,
}) => {
  await open(page, "system-markerlane--folded-on-range-start", 1280);
  const y = (await page.locator(".sys-markers").boundingBox())!.y + 12;
  const edge = await page
    .locator(".sys-marker-edge[data-edge=start]")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
  expect(edge.width).toBe(18);
  for (const dx of [1, 9, 16]) {
    expect(await ownerAt(page, edge.left + dx, y)).toBe("start");
  }
  const chip = await page
    .getByRole("button", { name: "1 more marker" })
    .boundingBox();
  if (!chip) throw new Error("Chip did not render");
  for (const x of [
    chip.x + 1,
    chip.x + chip.width / 2,
    chip.x + chip.width - 1,
  ]) {
    expect(await ownerAt(page, x, y)).toBe("1 more marker");
  }
});

test("System/Ruler a selection knob dragged out of the window and released below the ruler ends the drag once, and the bare mouse then drags nothing", async ({
  page,
}) => {
  await open(page, "system-ruler--logging-selection-drag", 1280);
  const end = page.getByRole("slider", { name: "Selection end" });
  const box = await end.boundingBox();
  if (!box) throw new Error("Knob did not render");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 200, y, { steps: 5 });
  await page.mouse.move(1278, y, { steps: 5 });
  await expect(end).toHaveCount(0);
  await page.mouse.move(1278, y + 200, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByTestId("events")).toHaveText(
    "start end | end end true",
  );
  const drags = await page.getByTestId("drags").textContent();
  await page.mouse.move(600, y, { steps: 5 });
  await page.mouse.move(300, y, { steps: 5 });
  await frames(page);
  await expect(page.getByTestId("drags")).toHaveText(drags ?? "");
  await expect(page.getByTestId("events")).toHaveText(
    "start end | end end true",
  );
  await expect(page.locator("[data-dragging]")).toHaveCount(0);
});

test("System/MarkerLane after a mouse drag the next Enter on another marker selects it at once", async ({
  page,
}) => {
  await open(page, "system-markerlane--all-kinds", 1280);
  const box = await page
    .getByRole("button", { name: /^Chapter Interview/ })
    .boundingBox();
  if (!box) throw new Error("Chapter did not render");
  await page.mouse.move(box.x + 6, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 46, box.y + 12, { steps: 6 });
  await page.mouse.up();
  const open1 = page.getByRole("button", { name: /^Chapter Cold open/ });
  await open1.focus();
  await page.keyboard.press("Enter");
  await expect(open1).toHaveAttribute("aria-pressed", "true");
});

test("System/MarkerLane after a touch drag the next Enter on another marker selects it at once", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-markerlane--phone",
  );
  const cdp = await context.newCDPSession(page);
  const joke = page.getByRole("button", { name: /^Clip idea Best joke/ });
  const box = await joke.boundingBox();
  if (!box) throw new Error("Bracket did not render");
  await swipe(
    cdp,
    { x: box.x + box.width / 2, y: box.y + 12 },
    { dx: -72, dy: 0 },
  );
  await frames(page);
  await expect(joke).toHaveAttribute("aria-label", /0:20\.0 to 0:32\.0/);
  const open1 = page.getByRole("button", { name: /^Chapter Cold open/ });
  await open1.focus();
  await page.keyboard.press("Enter");
  await expect(open1).toHaveAttribute("aria-pressed", "true");
  await context.close();
});

test("System/MarkerLane under a coarse pointer a selected bracket's edges are 34% of it, up to 44 px, without the touch prop", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-markerlane--selected",
  );
  await expect(page.locator(".sys-markers")).not.toHaveAttribute("data-touch");
  const joke = await page
    .getByRole("button", { name: /^Clip idea Best joke/ })
    .boundingBox();
  const widths = await page
    .locator(".sys-marker[data-selected] .sys-marker-edge")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  if (!joke) throw new Error("Bracket did not render");
  expect(widths).toHaveLength(2);
  for (const width of widths) expect(width).toBeCloseTo(joke.width * 0.34, 1);
  const y = joke.y + 12;
  expect(await ownerAt(page, joke.x + 20, y)).toBe("start");
  expect(await ownerAt(page, joke.x + joke.width - 20, y)).toBe("end");
  expect(await ownerAt(page, joke.x + joke.width / 2, y)).toMatch(
    /^Clip idea Best joke/,
  );
  await context.close();
});

test("System/MarkerLane the name field of an added chapter stays inside the lane when its time is scrolled off to the left", async ({
  page,
}) => {
  await open(page, "system-markerlane--adding-chapter-scrolled-away", 1280);
  const lane = await page.locator(".sys-markers").boundingBox();
  const field = page.getByRole("textbox", { name: "Chapter name" });
  const box = await field.boundingBox();
  if (!lane || !box) throw new Error("Field did not render");
  expect(box.x).toBeGreaterThanOrEqual(lane.x);
  expect(box.x + box.width).toBeLessThanOrEqual(lane.x + lane.width);
  await expect(field).toBeFocused();
  expect(
    await field.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + 10) === el;
    }),
  ).toBe(true);
});

test("System/MarkerLane draws the clip idea's line, the range comment's bar and the proposed hatch in the system text color under forced colors", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(storyUrl("system-markerlane--all-kinds", { theme: "light" }));
  await expect(page.locator(".sys-marker-line").first()).toBeVisible();
  const seen = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.forcedColorAdjust = "none";
    probe.style.backgroundColor = "CanvasText";
    document.body.append(probe);
    const text = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(selector);
      return getComputedStyle(el);
    };
    return {
      text,
      well: style(".sys-markers").backgroundColor,
      line: style(
        ".sys-marker[data-kind=clip]:not([data-proposed]) .sys-marker-line",
      ).backgroundColor,
      bar: style(".sys-marker-bar").backgroundColor,
      hatch: style(".sys-marker[data-proposed] .sys-marker-line")
        .backgroundImage,
    };
  });
  expect(seen.line).toBe(seen.text);
  expect(seen.bar).toBe(seen.text);
  expect(seen.line).not.toBe(seen.well);
  expect(seen.hatch).toContain("repeating-linear-gradient");
  expect(seen.hatch).toContain(seen.text);
});

for (const mode of ["light", "dark", "forced"] as const) {
  test(`System/MarkerLane the selection ring of a selected marker is drawn inside its 24 px lane in ${mode}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({
      colorScheme: mode === "dark" ? "dark" : "light",
      forcedColors: mode === "forced" ? "active" : "none",
      reducedMotion: "reduce",
    });
    await page.goto(
      storyUrl("system-markerlane--selected", {
        theme: mode === "dark" ? "dark" : "light",
      }),
    );
    const joke = page.getByRole("button", { name: /^Clip idea Best joke/ });
    await expect(joke).toHaveAttribute("aria-pressed", "true");
    const ring = await joke.evaluate((el) => {
      const style = getComputedStyle(el);
      const lane = el.closest(".sys-markers")?.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return {
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
        offset: Number.parseFloat(style.outlineOffset),
        above: box.top - (lane?.top ?? 0),
        below: (lane?.bottom ?? 0) - box.bottom,
      };
    });
    expect(ring.style).toBe("solid");
    expect(ring.width).toBeGreaterThan(0);
    expect(ring.offset).toBeLessThanOrEqual(-ring.width);
    expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
    expect(ring.above).toBeGreaterThanOrEqual(0);
    expect(ring.below).toBeGreaterThanOrEqual(0);
  });
}

test("System/Player the collapsed Play button, AppHeader project button and StatusRow toggle measure 44 px on a coarse pointer", async ({
  browser,
}) => {
  const size = async (id: string, name: RegExp | string) => {
    const { context, page } = await coarsePage(browser, id, {
      width: 900,
      height: 800,
    });
    const target = page.getByRole("button", { name });
    await expect(target.first()).toBeVisible();
    const box = await target.first().boundingBox();
    await context.close();
    if (!box) throw new Error(`${id} did not render`);
    return { width: box.width, height: box.height };
  };
  const play = await size("system-player--phone", /^(Play|Pause)/);
  const project = await size("system-appheader--phone", /Episode 14/);
  const toggle = await size("system-statusrow--expandable", /Uploading takes/);
  for (const box of [play, project, toggle]) {
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(play.width).toBeGreaterThanOrEqual(44);
  expect(project.width).toBeGreaterThanOrEqual(44);
});

test("System/AppHeader a failed save leaves the title 120 px from 360 to 570", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-appheader--failed",
  );
  await page.evaluate(() => {
    document.documentElement.dataset.shell = "phone";
  });
  await page.setViewportSize({ width: 360, height: 800 });
  const title = page.locator(".sys-header-project .sys-header-title");
  await expect(title).toBeVisible();
  await expect(page.locator(".sys-header-right")).toBeHidden();
  const shown = await title.evaluate((el) => el.clientWidth);
  const retry = await page
    .getByRole("button", { name: /Retry/ })
    .evaluate((el) => el.getBoundingClientRect().height);
  const wider: number[] = [];
  for (const width of [430, 450, 480, 540, 570]) {
    await page.setViewportSize({ width, height: 900 });
    wider.push(await title.evaluate((el) => el.clientWidth));
  }
  await context.close();
  expect(shown).toBeGreaterThanOrEqual(120);
  expect(retry).toBeGreaterThanOrEqual(44);
  for (const wide of wider) expect(wide).toBeGreaterThanOrEqual(120);
});

test("System/AppHeader a failed save keeps the title 120 px past the phone cut-over, 577 to 640", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "system-appheader--failed-with-tools",
  );
  await page.evaluate(() => {
    document.documentElement.dataset.shell = "phone";
  });
  const title = page.locator(".sys-header-project .sys-header-title");
  const shown: number[] = [];
  for (const width of [577, 600, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".sys-header-right")).toBeVisible();
    shown.push(await title.evaluate((el) => el.clientWidth));
  }
  await context.close();
  for (const width of shown) expect(width).toBeGreaterThanOrEqual(120);
});

for (const shell of ["tablet", "desktop"] as const) {
  test(`System/AppHeader a failed save keeps the right side in the ${shell} shell at 500 px`, async ({
    page,
  }) => {
    await open(page, "system-appheader--failed-with-tools", 500);
    await page.evaluate((value) => {
      document.documentElement.dataset.shell = value;
    }, shell);
    await expect(page.locator(".sys-header-right")).toBeVisible();
    await expect(page.getByRole("button", { name: /Invite/ })).toBeVisible();
  });
}

test("System/AppHeader a failed save keeps Invite and search in the Project menu, and a guest link keeps its search button", async ({
  browser,
}) => {
  const owner = await coarsePage(
    browser,
    "system-appheader--failed-with-tools",
  );
  await owner.page.evaluate(() => {
    document.documentElement.dataset.shell = "phone";
  });
  await owner.page.setViewportSize({ width: 360, height: 800 });
  await expect(
    owner.page.getByRole("button", { name: /Episode 14/ }),
  ).toBeVisible();
  await expect(owner.page.locator(".sys-header-right")).toBeHidden();
  await owner.page.getByRole("button", { name: /Episode 14/ }).click();
  await expect(
    owner.page.getByRole("menuitem", { name: "Invite" }),
  ).toBeVisible();
  await expect(
    owner.page.getByRole("menuitem", { name: /Search commands/ }),
  ).toBeVisible();
  await owner.context.close();
  const guest = await coarsePage(browser, "system-appheader--failed-guest");
  await guest.page.evaluate(() => {
    document.documentElement.dataset.shell = "phone";
  });
  await guest.page.setViewportSize({ width: 360, height: 800 });
  await expect(guest.page.locator(".sys-header-right")).toBeVisible();
  await expect(
    guest.page.getByRole("button", { name: /Palette/ }),
  ).toBeVisible();
  await guest.context.close();
});

test("System/AppHeader a failed save at 600 px keeps people, Invite and search in the header", async ({
  page,
}) => {
  await open(page, "system-appheader--failed-with-tools", 600);
  await page.evaluate(() => {
    document.documentElement.dataset.shell = "phone";
  });
  await expect(page.locator(".sys-header-right")).toBeVisible();
  await expect(page.getByRole("button", { name: /Invite/ })).toBeVisible();
});

test("System/Toast the dock keeps the page gutter at 360", async ({ page }) => {
  await open(page, "system-toast--result", 360);
  const dock = page.locator(".sys-toast-dock");
  await expect(dock).toBeVisible();
  const box = await dock.boundingBox();
  if (!box) throw new Error("Toast dock did not render");
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(360 - (box.x + box.width)).toBeGreaterThanOrEqual(16);
});

test("System/Toast the dock sits 12 px above the bottom edge without a device inset", async ({
  page,
}) => {
  await open(page, "system-toast--result", 360);
  const dock = page.locator(".sys-toast-dock");
  await expect(dock).toBeVisible();
  const bottom = await dock.evaluate(
    (el) => getComputedStyle(el).insetBlockEnd,
  );
  expect(bottom).toBe("12px");
});

for (const [label, rootSize] of [
  ["", "100%"],
  [" at 200% text", "200%"],
] as const) {
  test(`System/CoachTip Above leaves room for the tip and its shadow inside the frame${label}`, async ({
    page,
  }) => {
    await open(page, "system-coachtip--above", 360);
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size;
    }, rootSize);
    const tip = page.getByRole("note");
    await expect(tip).toBeVisible();
    const room = await tip.evaluate((el) => {
      const rem = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const box = el.getBoundingClientRect();
      return {
        top: box.top - 1 * rem,
        start: box.left,
        end: document.documentElement.clientWidth - box.right,
      };
    });
    expect(room.top).toBeGreaterThanOrEqual(0);
    expect(room.start).toBeGreaterThanOrEqual(0);
    expect(room.end).toBeGreaterThanOrEqual(0);
  });
}

type Box = { x: number; y: number; width: number; height: number };

const boxOf = async (
  page: import("@playwright/test").Page,
  selector: string,
  index = 0,
): Promise<Box> => {
  const box = await page.locator(selector).nth(index).boundingBox();
  if (!box) throw new Error(`${selector} did not render`);
  return box;
};

test("System/Lane is 72, 104 and 240 px tall with a 3 px edge in the track colour and a tint behind its clips", async ({
  page,
}) => {
  await open(page, "system-lane--three-tracks", 1280);
  await expect(page.locator(".sys-lane")).toHaveCount(3);
  const lanes = await page.locator(".sys-lane").evaluateAll((els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      const edge = getComputedStyle(el, "::before");
      return {
        height: el.getBoundingClientRect().height,
        edgeWidth: edge.borderInlineStartWidth,
        edgeColor: edge.borderInlineStartColor,
        edgeSide: el.getBoundingClientRect().left,
        trackColor: style.getPropertyValue("--sys-lane-color"),
        background: style.backgroundColor,
      };
    }),
  );
  expect(lanes.map((lane) => lane.height)).toEqual([72, 104, 240]);
  for (const lane of lanes) {
    expect(lane.edgeWidth).toBe("3px");
    expect(lane.edgeColor).not.toBe("rgba(0, 0, 0, 0)");
  }
  // Three track colours give three tints and three edges.
  expect(new Set(lanes.map((lane) => lane.background)).size).toBe(3);
  expect(new Set(lanes.map((lane) => lane.edgeColor)).size).toBe(3);
});

test("System/Lane a clip stands at the x its time gives, and a lane muted in the mix, for you only or by a solo sits on the muted track colour", async ({
  page,
}) => {
  await open(page, "system-lane--muted", 1280);
  const lane = await boxOf(page, ".sys-lane", 0);
  // "Maya, intro" begins at 0.5 s and "Maya, take 2" at 8 s, at 24 px/s.
  const intro = await page
    .getByRole("button", { name: "Maya, intro" })
    .boundingBox();
  const take = await page
    .getByRole("button", { name: "Maya, take 2" })
    .boundingBox();
  expect(Math.abs((intro?.x ?? 0) - (lane.x + 12))).toBeLessThanOrEqual(1);
  expect(Math.abs((take?.x ?? 0) - (lane.x + 192))).toBeLessThanOrEqual(1);
  const backgrounds = await page
    .locator(".sys-lane")
    .evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor),
    );
  const muted = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--color-track-muted)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  expect(backgrounds).toEqual([muted, muted, muted]);
});

test("System/Lane a lane muted for you only reads as muted like its header, whose avatar greys for the same state", async ({
  page,
}) => {
  await open(page, "system-trackheader--muted-for-you", 1280);
  const filter = await page
    .locator(".sys-person-avatar")
    .first()
    .evaluate((el) => getComputedStyle(el).filter);
  expect(filter).toBe("grayscale(1)");
});

test("System/Presence the flag is as wide as FLAG_PX says, at any root font size", async ({
  page,
}) => {
  await open(page, "stages-edit-timeline--three-tracks", 1280);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  const flag = await page.locator(".sys-presence-flag").first().boundingBox();
  expect([flag?.width, flag?.height]).toEqual([16, 16]);
});

test("System/Lane a loading lane draws a 1 px line through its middle", async ({
  page,
}) => {
  await open(page, "system-lane--peaks-loading", 1280);
  const lane = await boxOf(page, ".sys-lane", 0);
  const line = await boxOf(page, ".sys-lane-flat", 0);
  expect(line.width).toBeGreaterThan(300);
  expect(Math.abs(line.y - (lane.y + lane.height / 2))).toBeLessThanOrEqual(1);
  const style = await page
    .locator(".sys-lane-flat")
    .first()
    .evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        width: css.borderBlockStartWidth,
        color: css.borderBlockStartColor,
      };
    });
  expect(style.width).toBe("1px");
  expect(style.color).not.toBe("rgba(0, 0, 0, 0)");
});

test("System/Lane and System/Presence keep their edge, line and outline as borders under forced colors", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    storyUrl("system-presence--remote-selection", { theme: "light" }),
  );
  await expect(page.locator(".sys-presence-line").first()).toBeVisible();
  const measured = await page.evaluate(() => {
    const first = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(selector);
      return el;
    };
    const lane = getComputedStyle(first(".sys-lane"), "::before");
    const line = getComputedStyle(first(".sys-presence-line"));
    const outline = getComputedStyle(first(".sys-presence-sel"));
    return {
      edge: [lane.borderInlineStartWidth, lane.borderInlineStartColor],
      line: [line.borderInlineStartWidth, line.borderInlineStartColor],
      outline: [outline.borderTopWidth, outline.borderTopStyle],
      outlineColor: outline.borderTopColor,
    };
  });
  expect(measured.edge[0]).toBe("3px");
  expect(measured.edge[1]).not.toBe("rgba(0, 0, 0, 0)");
  expect(measured.line[0]).toBe("1px");
  expect(measured.line[1]).not.toBe("rgba(0, 0, 0, 0)");
  expect(measured.outline).toEqual(["1px", "dashed"]);
  expect(measured.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
});

for (const [id, label] of [
  ["stages-edit-timeline--three-tracks", "a whole pixel"],
  ["stages-edit-timeline--deep-zoom", "a fractional pixel"],
] as const) {
  test(`Stages/Edit/Timeline a remote playhead on the ruler's time is within 0.5 px of the ruler's own playhead at ${label}`, async ({
    page,
  }) => {
    await open(page, id, 1280);
    await expect(page.locator(".sys-ruler-playhead")).toBeVisible();
    const ruler = await boxOf(page, ".sys-ruler-playhead");
    const maya = page.locator('.sys-presence-person[data-person="maya"]');
    const line = await maya.locator(".sys-presence-line").boundingBox();
    if (!line) throw new Error("Maya's line did not render");
    const rulerCentre = ruler.x + ruler.width / 2;
    const lineCentre = line.x + line.width / 2;
    expect(line.width).toBe(1);
    expect(ruler.width).toBe(2);
    expect(Math.abs(lineCentre - rulerCentre)).toBeLessThanOrEqual(0.5);
  });
}

test("Stages/Edit/Timeline the header column is 168 px and every part starts at the time column's edge", async ({
  page,
}) => {
  await open(page, "stages-edit-timeline--three-tracks", 1280);
  const header = await boxOf(page, ".sys-track", 0);
  const column = await boxOf(page, '[data-testid="time-column"]');
  expect(header.width).toBe(168);
  expect(Math.abs(column.x - (header.x + 168))).toBeLessThanOrEqual(0.5);
  for (const selector of [".sys-ruler", ".sys-markers", ".sys-lane"]) {
    const part = await boxOf(page, selector);
    expect(part.x, selector).toBe(column.x);
    expect(part.width, selector).toBe(column.width);
  }
  const overlay = await boxOf(page, ".sys-presence");
  expect(overlay.x).toBe(column.x);
  expect(overlay.width).toBe(column.width);
});

test("Stages/Edit/Timeline a clip and a remote selection stand at the x and in the lane the window gives", async ({
  page,
}) => {
  await open(page, "stages-edit-timeline--three-tracks", 1280);
  const column = await boxOf(page, '[data-testid="time-column"]');
  // "Anneke, answer" begins at 6.5 s, at 24 px/s, in the second lane.
  const clip = await page
    .getByRole("button", { name: "Anneke, answer" })
    .boundingBox();
  expect(Math.abs((clip?.x ?? 0) - (column.x + 156))).toBeLessThanOrEqual(1);
  const lanes = [
    await boxOf(page, ".sys-lane", 0),
    await boxOf(page, ".sys-lane", 1),
    await boxOf(page, ".sys-lane", 2),
  ];
  expect(lanes.map((lane) => lane.height)).toEqual([72, 104, 72]);
  const selection = await boxOf(page, ".sys-presence-sel");
  expect(Math.abs(selection.y - lanes[1].y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(selection.height - lanes[1].height)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(selection.x - (column.x + 156))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(selection.width - 240)).toBeLessThanOrEqual(0.5);
  // The first lane starts under the ruler (24) and the marker row (24).
  const ruler = await boxOf(page, ".sys-ruler");
  expect(Math.abs(lanes[0].y - (ruler.y + 48))).toBeLessThanOrEqual(0.5);
});

test("Stages/Edit/Timeline a remote playhead runs from the ruler to the last lane, its 16 px flag sits on the ruler beside it, and neither takes the pointer", async ({
  page,
}) => {
  await open(page, "stages-edit-timeline--three-tracks", 1280);
  const ruler = await boxOf(page, ".sys-ruler");
  const lastLane = await boxOf(page, ".sys-lane", 2);
  const maya = page.locator('.sys-presence-person[data-person="maya"]');
  const line = await maya.locator(".sys-presence-line").boundingBox();
  const flag = await maya.locator(".sys-presence-flag").boundingBox();
  if (!line || !flag) throw new Error("Maya's mark did not render");
  expect(Math.abs(line.y - ruler.y)).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(line.y + line.height - (lastLane.y + lastLane.height)),
  ).toBeLessThanOrEqual(0.5);
  expect([flag.width, flag.height]).toEqual([16, 16]);
  expect(flag.y).toBeGreaterThanOrEqual(ruler.y + 4 - 0.5);
  expect(flag.y + flag.height).toBeLessThanOrEqual(ruler.y + ruler.height);
  expect(flag.x).toBeGreaterThanOrEqual(line.x + line.width);
  // The overlay never takes the pointer: what is under a line is the lane.
  const target = await page.evaluate(
    ([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return {
        insideOverlay: hit?.closest(".sys-presence") !== null,
        tag: hit?.className ?? "",
      };
    },
    [line.x + 0.5, lastLane.y + lastLane.height / 2] as const,
  );
  expect(target.insideOverlay, target.tag).toBe(false);
});

test("Stages/Edit/Timeline on a phone the playhead stays at the middle of the time column, and a flag near the right edge flips left of its line", async ({
  page,
}) => {
  await open(page, "stages-edit-timeline--phone-fixed-playhead", 360);
  const header = await boxOf(page, ".sys-track", 0);
  const column = await boxOf(page, '[data-testid="time-column"]');
  expect(header.width).toBe(56);
  const playhead = await boxOf(page, ".sys-ruler-playhead");
  expect(
    Math.abs(playhead.x + playhead.width / 2 - (column.x + column.width / 2)),
  ).toBeLessThanOrEqual(1);
  const maya = page.locator('.sys-presence-person[data-person="maya"]');
  const line = await maya.locator(".sys-presence-line").boundingBox();
  // Maya is 1 s (24 px) right of the playhead.
  expect(
    Math.abs((line?.x ?? 0) + 0.5 - (playhead.x + 1 + 24)),
  ).toBeLessThanOrEqual(0.5);
  // Anneke is 5.5 s (132 px) right of the playhead, 4 px from the column's right edge: her flag is left of her line, inside the column.
  const anneke = page.locator('.sys-presence-person[data-person="anneke"]');
  await expect(anneke.locator(".sys-presence-flag")).toHaveClass(
    /sys-presence-flag--left/,
  );
  const flag = await anneke.locator(".sys-presence-flag").boundingBox();
  const hers = await anneke.locator(".sys-presence-line").boundingBox();
  expect(flag?.x ?? 0).toBeGreaterThanOrEqual(column.x);
  expect((flag?.x ?? 0) + (flag?.width ?? 0)).toBeLessThanOrEqual(hers?.x ?? 0);
  await expect(maya.locator(".sys-presence-flag")).toHaveClass(
    /sys-presence-flag--right/,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
});

test("System/Presence a remote selection that runs past the window has no edge there", async ({
  page,
}) => {
  await open(page, "system-presence--remote-selection", 360);
  await expect(page.locator(".sys-presence-sel").first()).toBeAttached();
  const edges = await page.locator(".sys-presence-sel").evaluateAll((els) =>
    els.map((el) => ({
      start: el.hasAttribute("data-clip-start"),
      end: el.hasAttribute("data-clip-end"),
      right: getComputedStyle(el).borderInlineEndWidth,
    })),
  );
  expect(edges.length).toBeGreaterThan(0);
  for (const edge of edges) {
    expect(edge.right).toBe(edge.end ? "0px" : "1px");
  }
});

const envPoint = (page: import("@playwright/test").Page, id: string) =>
  page.locator(`.sys-env-point[data-id="${id}"]`);

const centreOf = async (locator: import("@playwright/test").Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Nothing to point at");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("System/Envelope puts 0 dB where the scale says, 2 px of line in the track colour, and a labelled guide there", async ({
  page,
}) => {
  await open(page, "system-envelope--points", 1280);
  await expect(page.locator(".sys-env-point")).toHaveCount(5);
  const lane = await boxOf(page, ".sys-lane", 0);
  expect(lane.height).toBe(72);
  const zero = dbToY(0, 72);
  expect(zero).toBeCloseTo(7.55, 1);
  const guide = await boxOf(page, ".sys-env-zero");
  expect(Math.abs(guide.y - (lane.y + zero))).toBeLessThanOrEqual(1);
  await expect(page.locator(".sys-env-zero")).toHaveText("0 dB");
  // "env-1" is at 0 dB and "env-5" too: their dots are centred on the guide.
  for (const id of ["env-1", "env-5"]) {
    const dot = await centreOf(envPoint(page, id));
    expect(Math.abs(dot.y - (lane.y + zero))).toBeLessThanOrEqual(1);
  }
  const line = await page.locator(".sys-env-line").evaluate((el) => {
    const css = getComputedStyle(el);
    return { width: css.strokeWidth, stroke: css.stroke };
  });
  expect(line.width).toBe("2px");
  expect(line.stroke).not.toBe("none");
  const edge = await page
    .locator(".sys-lane")
    .first()
    .evaluate((el) => getComputedStyle(el, "::before").borderInlineStartColor);
  const rgb = (value: string) => value.replace(/\s+/g, "");
  expect(rgb(line.stroke)).toBe(rgb(edge));
});

test("System/Envelope a point stands at the x its time gives, and the scale's ends are 4 px inside the lane", async ({
  page,
}) => {
  await open(page, "system-envelope--points", 1280);
  const lane = await boxOf(page, ".sys-lane", 0);
  // "env-2" is at 4 s and "env-3" at 7.2 s, at 24 px/s.
  const two = await centreOf(envPoint(page, "env-2"));
  const three = await centreOf(envPoint(page, "env-3"));
  expect(Math.abs(two.x - (lane.x + 96))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(three.x - (lane.x + 172.8))).toBeLessThanOrEqual(0.5);
  expect(dbToY(ENVELOPE_TOP_DB, 72)).toBeCloseTo(4, 6);
  expect(dbToY(-60, 72)).toBeCloseTo(68, 6);
});

test("System/Envelope a drag shows the level and time in a chip, holds the point between its neighbours, and commits on release", async ({
  page,
}) => {
  await open(page, "system-envelope--points", 1280);
  const dot = envPoint(page, "env-2");
  const from = await centreOf(dot);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // A press focuses the point, so its arrows work straight away.
  await expect(dot).toBeFocused();
  await page.mouse.move(from.x + 12, from.y + 5, { steps: 4 });
  await page.mouse.move(from.x + 24, from.y + 10, { steps: 4 });
  const chip = page.locator(".sys-readout");
  // The drag locked to time (24 px across, 10 down): the level stays -6.0 dB.
  await expect(chip).toHaveText("\u22126.0 dB \u00b7 0:05.0");
  const box = await chip.boundingBox();
  const now = await centreOf(dot);
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - now.x)).toBeLessThan(
    2,
  );
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThan(now.y);
  await page.mouse.up();
  await expect(chip).toHaveCount(0);
  await expect(
    page.getByRole("slider", { name: "Envelope point 2" }),
  ).toHaveAttribute("aria-valuetext", "\u22126.0 dB at 0:05.00");
  // The next point is at 7.2 s, 172.8 px from the lane's edge.
  await page.mouse.move(now.x, now.y);
  await page.mouse.down();
  await page.mouse.move(now.x + 400, now.y, { steps: 6 });
  await expect(chip).toHaveText("\u22126.0 dB \u00b7 0:07.2limit");
  await page.mouse.up();
  await expect(
    page.getByRole("slider", { name: "Envelope point 2" }),
  ).toHaveAttribute("aria-valuetext", "\u22126.0 dB at 0:07.20");
  const lane = await boxOf(page, ".sys-lane", 0);
  const stopped = await centreOf(envPoint(page, "env-2"));
  expect(Math.abs(stopped.x - (lane.x + 7.199 * 24))).toBeLessThanOrEqual(0.5);
});

test("System/Envelope a mostly vertical drag changes the level only, and dragging back leaves the point where it began", async ({
  page,
}) => {
  await open(page, "system-envelope--points", 1280);
  const dot = envPoint(page, "env-2");
  const from = await centreOf(dot);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 16, { steps: 4 });
  await expect(page.locator(".sys-readout")).toHaveText(
    "\u221221.9 dB \u00b7 0:04.0",
  );
  await page.mouse.move(from.x + 40, from.y, { steps: 4 });
  await expect(page.locator(".sys-readout")).toHaveText(
    "\u22126.0 dB \u00b7 0:04.0",
  );
  await page.mouse.up();
  await expect(dot).toHaveAttribute(
    "aria-valuetext",
    "\u22126.0 dB at 0:04.00",
  );
});

test("System/Envelope Fade draws the line in gain: halfway through a 0 dB to -60 dB fade is -6 dB, not -30", async ({
  page,
}) => {
  await open(page, "system-envelope--fade", 1280);
  await expect(page.locator(".sys-env-point")).toHaveCount(4);
  const y = await page.evaluate(() => {
    const d = document.querySelector(".sys-env-line")?.getAttribute("d") ?? "";
    const verts = d
      .split(/(?=[ML])/)
      .map((piece) => piece.slice(1).split(" ").map(Number));
    for (let i = 1; i < verts.length; i += 1) {
      const [x0 = 0, y0 = 0] = verts[i - 1] ?? [];
      const [x1 = 0, y1 = 0] = verts[i] ?? [];
      if (120 >= x0 && 120 <= x1 && x1 > x0) {
        return y0 + ((y1 - y0) * (120 - x0)) / (x1 - x0);
      }
    }
    return Number.NaN;
  });
  expect(Math.abs(y - dbToY(-6.02, 72))).toBeLessThan(1);
});

test("System/Envelope Escape ends a drag without committing, and the keymap never hears it", async ({
  page,
}) => {
  await open(page, "system-envelope--points", 1280);
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, { heard });
    window.addEventListener("keydown", (event) => {
      if (!["Shift", "Alt", "Control", "Meta"].includes(event.key)) {
        heard.push(event.key);
      }
    });
  });
  const from = await centreOf(envPoint(page, "env-4"));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y - 6, { steps: 4 });
  await expect(page.locator(".sys-readout")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".sys-readout")).toHaveCount(0);
  await expect(
    page.getByRole("slider", { name: "Envelope point 4" }),
  ).toHaveAttribute("aria-valuetext", "\u221212.0 dB at 0:10.00");
  expect(
    await page.evaluate(() => (window as never as { heard: string[] }).heard),
  ).toEqual([]);
});

test("System/Envelope Wired: each Shift+Right adds 100 ms when the host feeds the nudge back, and the hit attributes are on the dot and the strip", async ({
  page,
}) => {
  await open(page, "system-envelope--wired", 1280);
  const dot = envPoint(page, "env-2");
  await expect(dot).toHaveAttribute("data-hit-kind", "envelope-point");
  await expect(page.locator(".sys-env-band")).toHaveAttribute(
    "data-hit-surface",
    "envelope",
  );
  // The story's play function has already pressed it three times (4.30 s).
  await expect(dot).toHaveAttribute(
    "aria-valuetext",
    "\u22126.0 dB at 0:04.30",
  );
  await dot.focus();
  for (let press = 1; press <= 10; press += 1) {
    await page.keyboard.press("Shift+ArrowRight");
  }
  await expect(dot).toHaveAttribute(
    "aria-valuetext",
    "\u22126.0 dB at 0:05.30",
  );
  await expect(dot).toHaveAttribute("data-hit-detail", "5.30 s -6.00 dB");
});

test("System/Envelope the add strip along the line is 12 px, a click on it adds a point, and a clip away from the line is not covered", async ({
  page,
}) => {
  await open(page, "system-envelope--points", 1280);
  const lane = await boxOf(page, ".sys-lane", 0);
  const zero = dbToY(0, 72);
  // After the last point (13 s) the line runs flat at 0 dB.
  const x = lane.x + 13 * 24 + 40;
  const owners = await page.evaluate(
    ([px, py]) =>
      [-8, -5, 0, 5, 8].map((dy) => {
        const el = document.elementFromPoint(px, py + dy);
        return el?.classList.contains("sys-env-band") ?? false;
      }),
    [x, lane.y + zero] as const,
  );
  expect(owners).toEqual([false, true, true, true, false]);
  const clip = await page
    .getByRole("button", { name: "Maya, take 2" })
    .boundingBox();
  const insideClip = await page.evaluate(
    ([px, py]) =>
      document.elementFromPoint(px, py)?.closest(".sys-env") !== null,
    [(clip?.x ?? 0) + 20, lane.y + 50] as const,
  );
  expect(insideClip).toBe(false);
  await page.mouse.click(x, lane.y + zero + 3);
  await expect(page.locator(".sys-env-point")).toHaveCount(6);
  await expect(page.getByRole("status")).toContainText("Added envelope point");
});

test("System/Envelope under a coarse pointer a point is hit over 44 px, the add strip is 24 px, and the lane does not scroll sideways", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, "system-envelope--phone");
  const dot = envPoint(page, "env-4");
  await expect(dot).toBeVisible();
  const box = await dot.boundingBox();
  expect([box?.width, box?.height]).toEqual([44, 44]);
  const centre = await centreOf(dot);
  const hits = await page.evaluate(
    ([cx, cy]) =>
      [
        [-21, 0],
        [21, 0],
        [0, -21],
        [0, 21],
        [-15, -15],
        [15, 15],
      ].map(
        ([dx, dy]) =>
          document
            .elementFromPoint(cx + dx, cy + dy)
            ?.closest(".sys-env-point")
            ?.getAttribute("data-id") ?? null,
      ),
    [centre.x, centre.y] as const,
  );
  expect(hits).toEqual(Array(6).fill("env-4"));
  const lane = await boxOf(page, ".sys-lane", 0);
  expect(lane.height).toBe(104);
  const x = lane.x + 13 * 24 + 20;
  const zero = lane.y + dbToY(0, 104);
  const strip = await page.evaluate(
    ([px, py]) =>
      [-14, -11, 11, 14].map(
        (dy) =>
          document
            .elementFromPoint(px, py + dy)
            ?.classList.contains("sys-env-band") ?? false,
      ),
    [x, zero] as const,
  );
  // 11 px below the line is inside the strip; above it is the ruler.
  expect(strip.slice(2)).toEqual([true, false]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(393);
  await context.close();
});

test("System/Envelope under a coarse pointer a swipe that starts on the line scrolls the page, one that starts on a point does not, and a tap on the line adds a point", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, "system-envelope--phone");
  await expect(page.locator(".sys-env-svg")).toHaveCSS(
    "touch-action",
    "pan-x pan-y",
  );
  const dot = envPoint(page, "env-4");
  await expect(dot).toHaveCSS("touch-action", "none");
  // Something to scroll: the story fits the phone, so the body becomes a scroller 1600 px wide.
  await page.evaluate(() => {
    const wide = document.createElement("div");
    wide.style.cssText =
      "position:absolute;inset-block-start:0;inset-inline-start:0;inline-size:1600px;block-size:1px";
    document.body.append(wide);
    document.documentElement.style.overflow = "hidden";
    document.body.style.cssText +=
      ";position:relative;inline-size:393px;block-size:100vh;overflow-x:auto;overflow-y:hidden";
  });
  const lane = await boxOf(page, ".sys-lane", 0);
  // A tap on the line, halfway between points 4 (10 s, -12 dB) and 5 (13 s, 0 dB), adds a point: the line is there at the gain's mean.
  await page.touchscreen.tap(
    lane.x + 11.5 * 24,
    lane.y + dbToY(gainToDb((dbToGain(-12) + 1) / 2), 104),
  );
  await expect(page.locator(".sys-env-point")).toHaveCount(6);
  // Halfway between points 1 (1 s, 0 dB) and 2 (4 s, -6 dB), clear of both hit areas.
  const stripX = lane.x + 2.5 * 24;
  const stripY = lane.y + dbToY(gainToDb((dbToGain(-6) + 1) / 2), 104);
  const cdp = await context.newCDPSession(page);
  const swipe = async (x: number, y: number, dx: number) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * step) / 10, y }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  const centre = await centreOf(dot);
  await swipe(centre.x, centre.y, -150);
  // A scroll the swipe started would have landed within a few frames.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        let frames = 0;
        const tick = () =>
          ++frames < 12 ? requestAnimationFrame(tick) : done();
        requestAnimationFrame(tick);
      }),
  );
  expect(await page.evaluate(() => document.body.scrollLeft)).toBe(0);
  await swipe(stripX, stripY, -150);
  await expect
    .poll(() => page.evaluate(() => document.body.scrollLeft))
    .toBeGreaterThan(50);
  await context.close();
});

test("System/Envelope a point and the line stay visible under forced colors, and the selected point has a ring", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    storyUrl("system-envelope--point-selected", { theme: "light" }),
  );
  await expect(page.locator(".sys-env-point")).toHaveCount(5);
  const measured = await page.evaluate(() => {
    const first = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(selector);
      return el;
    };
    const line = getComputedStyle(first(".sys-env-line"));
    const dot = getComputedStyle(first(".sys-env-dot"));
    const ring = getComputedStyle(first("[data-selected] .sys-env-dot"));
    return {
      stroke: [line.stroke, line.strokeWidth],
      dot: dot.backgroundColor,
      ring: [ring.outlineStyle, ring.outlineWidth, ring.outlineColor],
      ringBg: ring.backgroundColor,
    };
  });
  expect(measured.stroke[0]).not.toBe("none");
  expect(measured.stroke[1]).toBe("2px");
  expect(measured.dot).not.toBe("rgba(0, 0, 0, 0)");
  expect(measured.ring[0]).toBe("solid");
  expect(measured.ring[1]).toBe("2px");
  expect(measured.ring[2]).not.toBe(measured.ringBg);
});

test("System/Envelope the keymap never hears the keys a focused point handles, and a removed point is gone", async ({
  page,
}) => {
  await open(page, "system-envelope--point-selected", 1280);
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, { heard });
    window.addEventListener("keydown", (event) => {
      if (!["Shift", "Alt", "Control", "Meta"].includes(event.key)) {
        heard.push(event.key);
      }
    });
  });
  const three = page.getByRole("slider", { name: "Envelope point 3" });
  await three.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(three).toHaveAttribute(
    "aria-valuetext",
    "\u22127.5 dB at 0:07.21",
  );
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    page.getByRole("slider", { name: "Envelope point 4" }),
  ).toBeFocused();
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".sys-env-point")).toHaveCount(4);
  expect(
    await page.evaluate(() => (window as never as { heard: string[] }).heard),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => (window as never as { heard: string[] }).heard),
  ).toEqual(["Escape"]);
});

test("System/Envelope read-only: a point is selected but not dragged, nudged or removed, and the line adds nothing", async ({
  page,
}) => {
  await open(page, "system-envelope--read-only", 1280);
  const two = page.getByRole("slider", { name: "Envelope point 2" });
  await expect(two).toHaveAttribute("aria-readonly", "true");
  const dots = await page
    .locator(".sys-env-dot")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  // 2.5 px radius, and 7 px for the selected one.
  expect(dots).toEqual([5, 14, 5, 5, 5]);
  const from = await centreOf(two);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 10, { steps: 4 });
  await expect(page.locator(".sys-readout")).toHaveCount(0);
  await page.mouse.up();
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, { heard });
    window.addEventListener("keydown", (event) => {
      if (!["Shift", "Alt", "Control", "Meta"].includes(event.key)) {
        heard.push(event.key);
      }
    });
  });
  await two.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Alt+ArrowRight");
  await two.focus();
  await page.keyboard.press("Backspace");
  // A guest's plain arrows reach the keymap; Alt with an arrow and Backspace do not.
  expect(
    await page.evaluate(() => (window as never as { heard: string[] }).heard),
  ).toEqual(["ArrowRight", "ArrowUp"]);
  await expect(page.locator(".sys-env-point")).toHaveCount(5);
  await expect(two).toHaveAttribute(
    "aria-valuetext",
    "\u22126.0 dB at 0:04.00",
  );
  const lane = await boxOf(page, ".sys-lane", 0);
  await page.mouse.click(lane.x + 13 * 24 + 40, lane.y + dbToY(0, 72));
  await expect(page.locator(".sys-env-point")).toHaveCount(5);
  await page.getByRole("slider", { name: "Envelope point 4" }).click();
  await expect(
    page.getByRole("slider", { name: "Envelope point 4" }),
  ).toHaveAttribute("aria-current", "true");
});

test("System/Envelope a 240 px lane stretches the scale: 0 dB, the ends and a dot sit where the height says", async ({
  page,
}) => {
  await open(page, "system-envelope--tall", 1280);
  const lane = await boxOf(page, ".sys-lane", 0);
  expect(lane.height).toBe(240);
  const guide = await boxOf(page, ".sys-env-zero");
  expect(Math.abs(guide.y - (lane.y + dbToY(0, 240)))).toBeLessThanOrEqual(1);
  // "env-2" is at -6 dB.
  const dot = await centreOf(envPoint(page, "env-2"));
  expect(Math.abs(dot.y - (lane.y + dbToY(-6, 240)))).toBeLessThanOrEqual(1);
  expect(dbToY(ENVELOPE_TOP_DB, 240)).toBeCloseTo(4, 6);
  expect(dbToY(-60, 240)).toBeCloseTo(236, 6);
});

test("Stages/Edit/Timeline WithEnvelope: Escape puts a dragged point back, and Backspace removes the selected one", async ({
  page,
}) => {
  await open(page, "stages-edit-timeline--with-envelope", 1280);
  const four = page.getByRole("slider", { name: "Envelope point 4" });
  const before = await four.getAttribute("aria-valuetext");
  const from = await centreOf(envPoint(page, "env-4"));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y - 6, { steps: 4 });
  await expect(page.locator(".sys-readout")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(four).toHaveAttribute("aria-valuetext", before ?? "");
  const three = page.getByRole("slider", { name: "Envelope point 3" });
  await three.click();
  await expect(three).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".sys-env-point")).toHaveCount(4);
});

test("Stages/Edit/Timeline an envelope point stands at the x its time gives in the time column, in Maya's 72 px lane, with 0 dB on its guide", async ({
  page,
}) => {
  await open(page, "stages-edit-timeline--with-envelope", 1280);
  await expect(page.locator(".sys-env-point")).toHaveCount(5);
  const column = await boxOf(page, '[data-testid="time-column"]');
  const lane = await boxOf(page, ".sys-lane", 0);
  const envelope = await boxOf(page, ".sys-env");
  expect([envelope.x, envelope.y, envelope.height]).toEqual([
    column.x,
    lane.y,
    72,
  ]);
  // "env-4" is at 10 s, at 24 px/s, and -12 dB.
  const dot = await centreOf(envPoint(page, "env-4"));
  expect(Math.abs(dot.x - (column.x + 240))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(dot.y - (lane.y + dbToY(-12, 72)))).toBeLessThanOrEqual(1);
  // A clip in another lane, and the presence overlay, are not covered by it.
  const other = await page
    .getByRole("button", { name: "Anneke, answer" })
    .boundingBox();
  const owner = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest(".sys-env") !== null,
    [(other?.x ?? 0) + 20, (other?.y ?? 0) + 20] as const,
  );
  expect(owner).toBe(false);
});
