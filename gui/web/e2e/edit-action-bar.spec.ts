import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import {
  armRange,
  goToStage,
  inspectSelection,
  openPanel,
  openProject,
  phone,
} from "./stageNav";
import { projectJson, touch, watchCommands } from "./touchTimeline";
import { trackHeaderButton } from "./trackHeader";

const selectionBar = (page: Page) =>
  page.getByRole("group", { name: "Selection actions" });
const dockBar = (page: Page) =>
  page.getByRole("group", { name: "Edit actions" });
const inspector = (page: Page) =>
  page.getByRole("dialog", { name: "Inspector", exact: true });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-action-bar-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function clipCount(page: Page): Promise<number> {
  const body = await projectJson(page, projectPath);
  return Object.values(body.clips.tracks).reduce(
    (sum, clips) => sum + clips.length,
    0,
  );
}

/** Playhead to `sec` (whole seconds): Home, then one-second nudges. */
async function seekTo(page: Page, sec: number): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press("Home");
  for (let i = 0; i < sec; i++) await page.keyboard.press("ArrowRight");
}

async function openEdit(page: Page): Promise<void> {
  await openProject(page, projectPath);
  await goToStage(page, "edit");
}

async function selectFirstClip(page: Page): Promise<Locator> {
  const clip = page.locator(".clip-hit").first();
  await clip.click();
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  return clip;
}

async function selectRange(page: Page, from: string, to: string) {
  await armRange(page);
  const fields = page.getByRole("region", { name: "Range fields" });
  await fields.getByRole("spinbutton", { name: "In", exact: true }).fill(from);
  await fields.getByRole("spinbutton", { name: "Out", exact: true }).fill(to);
  await fields
    .getByRole("checkbox", { name: "reference", exact: true })
    .check();
  await fields
    .getByRole("button", { name: "Select range", exact: true })
    .click();
}

async function expectInside(page: Page, box: Locator): Promise<void> {
  const rect = await box.boundingBox();
  const view = page.viewportSize();
  expect(rect).not.toBeNull();
  if (!rect || !view) return;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(view.width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(view.height);
}

for (const size of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "narrow desktop", width: 1024, height: 768 },
  { name: "tablet", width: 820, height: 1180 },
]) {
  test.describe(`Action bar placement at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("floats beside a selected clip, inside the viewport, and opens no Inspector by itself", async ({
      page,
    }) => {
      await openEdit(page);
      await selectFirstClip(page);
      const bar = selectionBar(page);
      await expect(bar).toBeVisible();
      await expectInside(page, bar);
      await expect(inspector(page)).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("stays inside the viewport for the clip on the last lane", async ({
      page,
    }) => {
      await openEdit(page);
      await page.locator(".clip-hit").last().click();
      const bar = selectionBar(page);
      await expect(bar).toBeVisible();
      await expectInside(page, bar);
    });
  });
}

test.describe("Split", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the Split verb cuts the selected clip at the playhead in one step", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await seekTo(page, 10);
    const before = await clipCount(page);
    const sent = watchCommands(page);
    await selectionBar(page)
      .getByRole("button", { name: /^Split/ })
      .click();
    await expect.poll(() => clipCount(page)).toBeGreaterThan(before);
    expect(sent.filter((c) => c.type === "SplitAtTime")).toHaveLength(1);
  });

  test("S does the same, and says why when the playhead is off the clip", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await seekTo(page, 20);
    const before = await clipCount(page);
    await page.keyboard.press("s");
    await expect.poll(() => clipCount(page)).toBeGreaterThan(before);
    await page.locator(".clip-hit").first().click();
    await seekTo(page, 50);
    const settled = await clipCount(page);
    await page.keyboard.press("s");
    await expect(
      page.getByRole("status").filter({ hasText: /playhead/i }),
    ).toHaveCount(1);
    expect(await clipCount(page)).toBe(settled);
  });

  test("Shift+S is Solo, so it does not split", async ({ page }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await seekTo(page, 10);
    const before = await clipCount(page);
    await page.keyboard.press("Shift+S");
    expect(await clipCount(page)).toBe(before);
  });

  test("a range splits at both of its edges in one history step", async ({
    page,
  }) => {
    await openEdit(page);
    await selectRange(page, "10", "20");
    const before = await clipCount(page);
    const sent = watchCommands(page);
    await selectionBar(page)
      .getByRole("button", { name: /^Split/ })
      .click();
    await expect.poll(() => clipCount(page)).toBe(before + 2);
    expect(sent.filter((c) => c.type === "SplitAtTime")).toHaveLength(1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => clipCount(page)).toBe(before);
  });

  test("selected words split at both edges and one Undo restores the saved clips", async ({
    page,
  }) => {
    await openEdit(page);
    await openPanel(page, "transcript");
    const words = page.locator(
      '.sys-script-body .sys-script-word[data-word-key^="reference:"]',
    );
    await words.nth(2).click();
    await words.nth(3).click({ modifiers: ["Shift"] });
    await expect(words.nth(2)).toHaveAttribute("data-selected");
    await expect(words.nth(3)).toHaveAttribute("data-selected");
    const before = await projectJson(page, projectPath);
    const beforeCount = await clipCount(page);
    const sent = watchCommands(page);
    await selectionBar(page)
      .getByRole("button", { name: /^Split/ })
      .click();
    await expect.poll(() => clipCount(page)).toBe(beforeCount + 2);
    expect(sent.filter((command) => command.type === "SplitAtTime")).toEqual([
      {
        type: "SplitAtTime",
        payload: {
          at_time: 2.79,
          extra_at_times: [3.56],
          track_ids: ["reference"],
          reason: null,
        },
      },
    ]);
    const split = await projectJson(page, projectPath);
    expect(
      split.clips.tracks.reference?.map((clip) => clip.timeline_start),
    ).toEqual([0, 2.79, 3.56]);
    expect(split.clips.tracks.guest).toEqual(before.clips.tracks.guest);
    await expect(page.locator(".clip-hit")).toHaveCount(beforeCount + 2);
    await page.screenshot({
      path: "playwright-report/words-actionbar/words-split-saved.png",
    });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await openPanel(page, "transcript");
    expect(await clipCount(page)).toBe(beforeCount + 2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => clipCount(page)).toBe(beforeCount);
    const undone = await projectJson(page, projectPath);
    expect(undone.clips.tracks).toEqual(before.clips.tracks);
  });

  test("Alt-click on a clip still splits there", async ({ page }) => {
    await openEdit(page);
    const before = await clipCount(page);
    await page
      .locator(".clip-hit")
      .first()
      .click({ modifiers: ["Alt"] });
    await expect.poll(() => clipCount(page)).toBeGreaterThan(before);
  });
});

test("the words More menu restores ignored words after mixed-selection Mute, with saved Undo", async ({
  page,
}) => {
  await openEdit(page);
  await openPanel(page, "transcript");
  const words = page.locator(
    '.sys-script-body .sys-script-word[data-word-key^="reference:"]',
  );
  const bar = selectionBar(page);
  await words.nth(2).click();
  await bar.getByRole("button", { name: /^More/ }).click();
  await page.getByRole("menuitem", { name: "Mute", exact: true }).click();
  await expect(words.nth(2)).toHaveAttribute("data-state", "muted");
  await words.nth(3).click({ modifiers: ["Shift"] });
  await bar.getByRole("button", { name: /^More/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "Restore ignored words", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Mute", exact: true }).click();
  await expect(words.nth(2)).toHaveAttribute("data-state", "muted");
  await expect(words.nth(3)).toHaveAttribute("data-state", "muted");
  await bar.getByRole("button", { name: /^More/ }).click();
  const sent = watchCommands(page);
  await page.screenshot({
    path: "playwright-report/words-actionbar/words-restore-more.png",
  });
  await page
    .getByRole("menuitem", { name: "Restore ignored words", exact: true })
    .click();
  await expect(words.nth(2)).not.toHaveAttribute("data-state", "muted");
  await expect(words.nth(3)).not.toHaveAttribute("data-state", "muted");
  const restore = sent.filter(
    (command) => command.type === "SetTranscriptWordsIgnored",
  );
  expect(restore).toHaveLength(1);
  expect(restore[0]?.payload).toMatchObject({
    track_id: "reference",
    start_word_index: 2,
    end_word_index: 3,
    ignored: false,
  });
  await page.screenshot({
    path: "playwright-report/words-actionbar/words-restore-saved.png",
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  await openPanel(page, "transcript");
  await expect(words.nth(2)).not.toHaveAttribute("data-state", "muted");
  await expect(words.nth(3)).not.toHaveAttribute("data-state", "muted");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(words.nth(2)).toHaveAttribute("data-state", "muted");
  await expect(words.nth(3)).toHaveAttribute("data-state", "muted");
});

test.describe("Cut", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Backspace cuts the selected clip, and Undo brings it back", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    const before = await clipCount(page);
    await page.keyboard.press("Backspace");
    await expect.poll(() => clipCount(page)).toBeLessThan(before);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => clipCount(page)).toBe(before);
  });

  test("Backspace cuts a selected range", async ({ page }) => {
    await openEdit(page);
    await selectRange(page, "10", "20");
    const before = await clipCount(page);
    await page.locator("body").press("Backspace");
    await expect.poll(() => clipCount(page)).not.toBe(before);
  });

  test("the Cut button cuts a selected range and Undo restores it", async ({
    page,
  }) => {
    await openEdit(page);
    await selectRange(page, "10", "20");
    const before = await clipCount(page);
    await selectionBar(page)
      .getByRole("button", { name: "Cut", exact: true })
      .click();
    await expect.poll(() => clipCount(page)).not.toBe(before);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => clipCount(page)).toBe(before);
  });

  test("Backspace cuts selected words", async ({ page }) => {
    await openEdit(page);
    await openPanel(page, "transcript");
    const words = page.locator(
      '.sys-script-body .sys-script-word[data-word-key^="reference:"]',
    );
    await words.nth(2).click();
    await words.nth(3).click({ modifiers: ["Shift"] });
    await expect(words.nth(3)).toHaveAttribute("data-selected");
    const before = await clipCount(page);
    await page.keyboard.press("Backspace");
    await expect.poll(() => clipCount(page)).not.toBe(before);
  });
});

test.describe("Hear", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Shift+Space on a focused bar button hears the selection and does not press the button", async ({
    page,
  }) => {
    await openEdit(page);
    await selectRange(page, "10", "12");
    const split = selectionBar(page).getByRole("button", { name: /^Split/ });
    await split.focus();
    const before = await clipCount(page);
    await page.keyboard.press("Shift+Space");
    expect(await clipCount(page)).toBe(before);
    await expect(split).toBeFocused();
  });

  test("Shift+Space on a focused clip hears the clip and keeps the selection", async ({
    page,
  }) => {
    await openEdit(page);
    const clip = await selectFirstClip(page);
    await clip.focus();
    await page.keyboard.press("Shift+Space");
    await expect(clip).toHaveAttribute("aria-pressed", "true");
  });

  test("Shift+Space on a focused word chip hears the word and keeps it selected", async ({
    page,
  }) => {
    await openEdit(page);
    await openPanel(page, "transcript");
    const word = page
      .locator('.sys-script-body .sys-script-word[data-word-key^="reference:"]')
      .nth(2);
    await word.click();
    await word.focus();
    await page.keyboard.press("Shift+Space");
    await expect(word).toHaveAttribute("data-selected");
  });
});

test.describe("Inspect", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("selecting alone opens nothing; the Inspect verb opens the Inspector and Esc closes it", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await expect(inspector(page)).toHaveCount(0);
    await inspectSelection(page);
    await expect(inspector(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspector(page)).toHaveCount(0);
    await expect(page.locator(".clip-hit").first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("I opens the Inspector for the selection", async ({ page }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await page.locator("body").press("i");
    await expect(inspector(page)).toBeVisible();
  });

  test("a double-click on a clip opens it", async ({ page }) => {
    await openEdit(page);
    await page.locator(".clip-hit").first().dblclick();
    await expect(inspector(page)).toBeVisible();
  });

  test("the Close button and a new selection both shut it", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await inspectSelection(page);
    await inspector(page).getByRole("button", { name: "Close" }).click();
    await expect(inspector(page)).toHaveCount(0);
    await inspectSelection(page);
    await expect(inspector(page)).toBeVisible();
    // The card floats over the lanes; the clip's left edge is clear of it.
    await page
      .locator(".clip-hit")
      .last()
      .click({ position: { x: 20, y: 10 } });
    await expect(inspector(page)).toHaveCount(0);
  });

  test("Esc steps back one layer at a time: Inspector, then selection", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await inspectSelection(page);
    await page.keyboard.press("Escape");
    await expect(inspector(page)).toHaveCount(0);
    await expect(selectionBar(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(selectionBar(page)).toHaveCount(0);
  });
});

test.describe("Create menu", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test("a long press on empty lane space opens the menu with Split here first", async ({
    page,
  }) => {
    await openEdit(page);
    const lane = page.locator('.lane-row[data-track-id="reference"]');
    await selectFirstClip(page);
    await seekTo(page, 30);
    await page.keyboard.press("s");
    await expect.poll(() => clipCount(page)).toBe(3);
    await lane.locator(".clip-hit").last().click();
    await page.keyboard.press("Backspace");
    await expect.poll(() => clipCount(page)).toBe(2);
    const box = await lane.boundingBox();
    if (!box) throw new Error("no lane");
    const cdp = await page.context().newCDPSession(page);
    const at = { x: box.x + box.width * 0.85, y: box.y + box.height / 2 };
    const before = await clipCount(page);
    await touch(cdp, "touchStart", [at]);
    const menu = page.getByRole("menu", { name: /^Create at / });
    await expect(menu).toBeVisible();
    await touch(cdp, "touchEnd");
    await expect(menu.getByRole("menuitem").first()).toHaveText(/Split here/);
    await menu.getByRole("menuitem", { name: /Split here/ }).click();
    await expect.poll(() => clipCount(page)).toBeGreaterThan(before);
  });
});

test.describe("Phone dock", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("selected words keep Split reachable and Fix text in More, with a visible Undo", async ({
    page,
  }) => {
    await openEdit(page);
    await openPanel(page, "transcript");
    const word = page.locator('.sys-script-word[data-word-key="reference::3"]');
    await word.tap();
    await expect(word).toHaveAttribute("data-selected");
    const dock = dockBar(page);
    await expect(dock.getByRole("button", { name: /^Fix text/ })).toBeVisible();
    await expect(
      dock.getByRole("button", { name: "Keep", exact: true }),
    ).toHaveCount(0);
    await dock.getByRole("button", { name: /^More/ }).tap();
    await expect(
      page.getByRole("menuitem", { name: "Re-record", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "playwright-report/words-actionbar/phone-live-more.png",
    });
    await dock.getByRole("button", { name: /^More/ }).tap();
    const before = await clipCount(page);
    const sent = watchCommands(page);
    await dock.getByRole("button", { name: /^Split/ }).tap();
    await expect.poll(() => clipCount(page)).toBe(before + 2);
    const split = sent.filter((command) => command.type === "SplitAtTime");
    expect(split).toHaveLength(1);
    expect(split[0]?.payload).toMatchObject({
      at_time: 2.97,
      extra_at_times: [3.56],
      track_ids: ["reference"],
    });
    await page.screenshot({
      path: "playwright-report/words-actionbar/phone-dock-split.png",
    });
    await page
      .locator(".ui-toast")
      .filter({ hasText: "Split at" })
      .getByRole("button", { name: "Undo", exact: true })
      .tap();
    await expect.poll(() => clipCount(page)).toBe(before);
    await word.tap();
    await dock.getByRole("button", { name: "Inspect", exact: true }).tap();
    const sheet = inspector(page);
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Suppress", exact: true }).tap();
    await expect(word).toHaveAttribute("data-state", "muted");
    const suppression = sent.filter(
      (command) => command.type === "SetTranscriptWordSuppressed",
    );
    expect(suppression).toHaveLength(1);
    expect(suppression[0]?.payload).toMatchObject({
      track_id: "reference",
      word_index: 3,
      suppressed: true,
      expected_text: "delighted",
    });
    await sheet.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(sheet).toBeHidden();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await openPanel(page, "transcript");
    await expect(word).toHaveAttribute("data-state", "muted");
    await word.tap();
    await expect(
      dock.getByRole("button", { name: "Keep", exact: true }),
    ).toBeVisible();
    await expect(dock.getByRole("button", { name: /^Fix text/ })).toHaveCount(
      0,
    );
    await dock.getByRole("button", { name: /^More/ }).tap();
    await expect(
      page.getByRole("menuitem", { name: "Fix text", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "playwright-report/words-actionbar/phone-suppressed-more.png",
    });
  });

  test("docks the bar above the Player with 44 px targets that a touch reaches", async ({
    page,
  }) => {
    await openProject(page, projectPath);
    await phone.showTimeline(page);
    const dock = dockBar(page);
    await expect(dock).toBeVisible();
    const player = page.getByRole("group", { name: "Player" });
    const dockBox = await dock.boundingBox();
    const playerBox = await player.boundingBox();
    expect(dockBox && playerBox).toBeTruthy();
    if (!dockBox || !playerBox) return;
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(playerBox.y + 1);
    for (const button of await dock.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      const hit = await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return top === el || el.contains(top);
      });
      expect(hit).toBe(true);
    }
  });

  test("Split from the dock cuts at the playhead, and Inspect on a selected clip opens the sheet", async ({
    page,
  }) => {
    await openProject(page, projectPath);
    await phone.showTimeline(page);
    await seekTo(page, 10);
    const before = await clipCount(page);
    await dockBar(page)
      .getByRole("button", { name: /^Split/ })
      .tap();
    await expect.poll(() => clipCount(page)).toBeGreaterThan(before);
    await page.locator(".clip-hit").first().tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await inspectSelection(page);
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

test.describe("Keys and focus", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("C opens the Review composer, focused, so typing a comment fires no shortcut", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    const sent = watchCommands(page);
    await page.locator("body").press("c");
    const composer = page.locator(".rv-compose").getByRole("textbox", {
      name: "Comment",
      exact: true,
    });
    await expect(composer).toBeFocused();
    await page.keyboard.type("my");
    await expect(composer).toHaveValue("my");
    expect(sent.filter((c) => c.type === "EditSelectedRange")).toHaveLength(0);
  });

  test("M outside the Edit stage never mutes the hidden Edit selection", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await goToStage(page, "review");
    const sent = watchCommands(page);
    await page.locator("body").press("m");
    await expect(
      page.getByRole("status").filter({ hasText: /Range mute/ }),
    ).toHaveCount(0);
    expect(sent.filter((c) => c.type === "EditSelectedRange")).toHaveLength(0);
  });

  test("Close hands focus back to the Inspect button", async ({ page }) => {
    await openEdit(page);
    await selectFirstClip(page);
    await inspectSelection(page);
    await inspector(page).getByRole("button", { name: "Close" }).click();
    await expect(inspector(page)).toHaveCount(0);
    await expect(
      selectionBar(page).getByRole("button", { name: "Inspect", exact: true }),
    ).toBeFocused();
  });

  test("a track header says it is selected while its Inspector is open", async ({
    page,
  }) => {
    // System/TrackHeader's select button reports aria-pressed (selected), not
    // aria-expanded; the Inspector it opens is announced by its own region.
    await openEdit(page);
    const header = trackHeaderButton(page, "reference");
    await expect(header).toHaveAttribute("aria-pressed", "false");
    await header.focus();
    await page.keyboard.press("Enter");
    await expect(inspector(page)).toBeVisible();
    await expect(header).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("Action bar follows and stays clear", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("moves under the next clip when the selection moves to another lane", async ({
    page,
  }) => {
    await openEdit(page);
    await selectFirstClip(page);
    const bar = selectionBar(page);
    await expect(bar).toBeVisible();
    const last = page.locator(".clip-hit").last();
    await last.click();
    await expect(last).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => {
        const [clip, box] = await Promise.all([
          last.boundingBox(),
          bar.boundingBox(),
        ]);
        return clip && box ? box.y - (clip.y + clip.height) : null;
      })
      .toBeGreaterThanOrEqual(-1);
    await expect
      .poll(async () => {
        const [clip, box] = await Promise.all([
          last.boundingBox(),
          bar.boundingBox(),
        ]);
        return clip && box ? box.y - (clip.y + clip.height) : null;
      })
      .toBeLessThan(40);
  });

  test("hangs above a selected word so the next lines stay clickable", async ({
    page,
  }) => {
    await openEdit(page);
    await openPanel(page, "transcript");
    const words = page.locator(
      '.sys-script-body .sys-script-word[data-word-key^="reference:"]',
    );
    await words.nth(2).click();
    const bar = selectionBar(page);
    await expect(bar).toBeVisible();
    const word = await words.nth(2).boundingBox();
    await expect
      .poll(async () => (await bar.boundingBox())?.y ?? Number.NaN)
      .toBeLessThanOrEqual((word?.y ?? 0) + 1);
    const count = await words.count();
    let later = -1;
    for (let i = 3; i < count; i++) {
      const box = await words.nth(i).boundingBox();
      if (box && word && box.y > word.y + word.height) {
        later = i;
        break;
      }
    }
    expect(later).toBeGreaterThan(2);
    await words.nth(later).click({ modifiers: ["Shift"] });
    await expect(words.nth(later)).toHaveAttribute("data-selected");
  });
});
