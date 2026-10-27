import { devices, expect, test } from "@playwright/test";
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
) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
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
  await expect(page.locator(".sys-handle")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent))
    .toBe(under);
  await expect(start).toHaveCount(0);
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
  await page.waitForTimeout(300);
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
