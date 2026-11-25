import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { expectFeedback } from "./feedback";
import { expectNoHorizontalScroll, expectTouchTargets } from "./modelsMock";
import { openPhoneTimeline } from "./phoneTimeline";
import { setRootFontSize } from "./rootFontSize";
import {
  expectActionsInBody,
  expectActionsPinned,
  expectResizes,
} from "./segmentSheet";
import { openProject, openToolsIfFolded } from "./stageNav";
import { setTheme, type Theme, withAppearance } from "./theme";

const CELLS = [
  {
    name: "390x844",
    width: 390,
    height: 844,
    fontPx: null,
    resize: true,
    detent: "half",
    cramped: false,
  },
  {
    name: "320x740",
    width: 320,
    height: 740,
    fontPx: null,
    resize: true,
    detent: "half",
    cramped: false,
  },
  {
    name: "320x568-200pct",
    width: 320,
    height: 568,
    fontPx: 32,
    resize: false,
    detent: "full",
    cramped: true,
  },
] as const;

const LIBRARY = [
  {
    id: "intro-9f3a",
    name: "Cold open",
    kind: "intro",
    version: 1,
    versions: [1],
    clips: [{ audio: "intro.flac", offset_sec: 0, duration_sec: 22 }],
  },
  {
    id: "bed-5c1d",
    name: "Warm bed",
    kind: "other",
    role: "music",
    duck_under_dialogue: true,
    version: 1,
    versions: [1],
    clips: [{ audio: "bed.flac", offset_sec: 0, duration_sec: 90 }],
  },
  {
    id: "outro-77de",
    version: 2,
    damaged: true,
    problem: "Version 2 has no readable audio: clips/outro.flac is missing.",
    code: "segment_media_invalid",
  },
];

const PREVIEW = {
  dry_run: true,
  segment_id: "intro-9f3a",
  segment_version: 1,
  at: 0,
  duration_sec: 22,
  timeline_duration_before_sec: 60,
  timeline_duration_after_sec: 82,
  clips_moved: 3,
  clips_added: 1,
  clips_from_segment: 1,
  chapters_moved: [],
  chapter_added: null,
  comments_moved: [],
  pending_edits_moved: 0,
  tracks_added: [],
  tracks: {},
};

const APPLIED = {
  operation: "insert_segment",
  affected_tracks: [],
  clip_count: 1,
  timeline_duration_sec: 82,
  segment_id: "intro-9f3a",
  segment_version: 1,
  at: 0,
  duration_sec: 22,
  tracks: {},
};

type Mocked = { previews: string[]; commands: Record<string, unknown>[] };

async function mockInsert(page: Page): Promise<Mocked> {
  const mocked: Mocked = { previews: [], commands: [] };
  await page.route(
    (url) => url.pathname === "/api/segments",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: LIBRARY });
    },
  );
  await page.route(
    (url) => /^\/api\/segments\/[^/]+\/insert-preview$/.test(url.pathname),
    async (route) => {
      mocked.previews.push(new URL(route.request().url()).search);
      const own =
        new URL(route.request().url()).searchParams.get("placement") ===
        "own_lane";
      await route.fulfill({
        json: own
          ? {
              ...PREVIEW,
              segment_id: "bed-5c1d",
              clips_moved: 0,
              timeline_duration_after_sec: 60,
              tracks_added: ["trk_bed"],
              placement: "own_lane",
            }
          : PREVIEW,
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/document/command",
    async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.type !== "InsertSegment") {
        await route.fallback();
        return;
      }
      mocked.commands.push(body);
      await route.fulfill({
        json: {
          history_head_id: "hist_e2e_insert",
          command: { payload: { result: APPLIED } },
        },
      });
    },
  );
  return mocked;
}

async function openCard(
  page: Page,
  theme: Theme,
  size: { width: number; height: number } | null,
) {
  await openProject(page, e2eProjectPath);
  if (size) await page.setViewportSize(size);
  await setTheme(page, theme);
  await openPhoneTimeline(page);
  return openInsert(page);
}

async function openInsert(page: Page) {
  const insert = page
    .getByRole("group", { name: "Edit actions" })
    .getByRole("button", { name: "Insert segment", exact: true });
  await openToolsIfFolded(page, insert);
  const onBar = await insert.waitFor({ state: "visible", timeout: 1500 }).then(
    () => true,
    () => false,
  );
  if (onBar) {
    await insert.tap();
  } else {
    await page
      .getByRole("group", { name: "Edit actions" })
      .getByRole("button", { name: "More", exact: true })
      .tap();
    await page
      .getByRole("menuitem", { name: "Insert segment", exact: true })
      .tap();
  }
  const sheet = page.getByRole("dialog", { name: "Insert segment" });
  await expect(sheet).toBeVisible();
  return sheet;
}

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`insert segment iphone ${cell.name}`, () => {
    test.use({
      viewport: { width: cell.width, height: cell.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });
    if (cell.resize) test.use({ viewport: { width: 1280, height: 800 } });

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
    });

    test("the sheet has 44 px controls, never scrolls sideways, previews and inserts with a toast", async ({
      page,
    }) => {
      const mocked = await mockInsert(page);
      const size = cell.resize
        ? { width: cell.width, height: cell.height }
        : null;
      const sheet = await openCard(page, theme, size);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      const option = sheet.getByRole("radio", { name: /Cold open/ });
      await expect(option).toBeVisible();
      await expect(
        sheet.getByRole("radio", { name: /outro-77de/ }),
      ).toBeDisabled();
      await expect(
        sheet.getByRole("button", { name: "Insert" }),
      ).toBeDisabled();
      await option.check({ force: true });
      await expect(sheet.getByText("Adds 0:22 at 0:00.")).toBeVisible();
      await expect(
        sheet.getByRole("combobox", { name: "Position" }),
      ).toHaveValue("start");
      await expectTouchTargets(sheet);
      const row = await option
        .locator("xpath=ancestor::label[1]")
        .boundingBox();
      expect(row?.height ?? 0).toBeGreaterThanOrEqual(43);
      await expectNoHorizontalScroll(page);
      expect(mocked.previews.at(-1)).toContain("at=start");
      await sheet.getByRole("button", { name: "Insert" }).tap();
      await expect(sheet).toHaveCount(0);
      await expectFeedback(page, "Inserted Cold open: 0:22 at 0:00");
      expect(mocked.commands).toHaveLength(1);
      expect(mocked.commands[0]).toMatchObject({
        type: "InsertSegment",
        payload: { segment_id: "intro-9f3a", at: "start", version: 1 },
      });
      expect(mocked.commands[0]?.payload).not.toHaveProperty("placement");
    });

    test("a music segment can play over the episode, with 44 px choice rows", async ({
      page,
    }) => {
      const mocked = await mockInsert(page);
      const size = cell.resize
        ? { width: cell.width, height: cell.height }
        : null;
      const sheet = await openCard(page, theme, size);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await sheet
        .getByRole("radio", { name: /Warm bed/ })
        .check({ force: true });
      const rest = sheet.getByRole("radio", { name: /Move the rest later/ });
      const over = sheet.getByRole("radio", { name: /Play over the episode/ });
      await expect(rest).toBeChecked();
      await over.check({ force: true });
      await expect(
        sheet.getByText("Adds 0:22 at 0:00 on a new track."),
      ).toBeVisible();
      await expect(
        sheet.getByText("Nothing already in the episode moves."),
      ).toBeVisible();
      expect(mocked.previews.at(-1)).toContain("placement=own_lane");
      for (const radio of [rest, over]) {
        const box = await radio
          .locator("xpath=ancestor::label[1]")
          .boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(43);
      }
      await expectTouchTargets(sheet);
      await expectNoHorizontalScroll(page);
      await sheet.getByRole("button", { name: "Insert" }).tap();
      await expect(sheet).toHaveCount(0);
      expect(mocked.commands).toHaveLength(1);
      expect(mocked.commands[0]).toMatchObject({
        type: "InsertSegment",
        payload: {
          segment_id: "bed-5c1d",
          version: 1,
          placement: "own_lane",
        },
      });
    });

    test("keeps Cancel and Insert pinned, and Expand and Collapse resize the sheet", async ({
      page,
    }) => {
      await mockInsert(page);
      const size = cell.resize
        ? { width: cell.width, height: cell.height }
        : null;
      const sheet = await openCard(page, theme, size);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await expect(sheet).toHaveClass(
        new RegExp(`bottom-sheet--${cell.detent}`),
      );
      const names = ["Cancel", "Insert"] as const;
      const scroll = sheet.locator(".sys-sheet-scroll");
      if (!cell.cramped)
        expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
      expect(
        await scroll.evaluate((el) => el.clientHeight),
      ).toBeGreaterThanOrEqual(64);
      if (cell.cramped) await expectActionsInBody(sheet, names);
      else await expectActionsPinned(sheet, names);
      await expectResizes(sheet, names, cell.cramped ? "body" : "footer");
      await expectNoHorizontalScroll(page);
    });

    test("Cancel closes the sheet and every open starts at the default height", async ({
      page,
    }) => {
      await mockInsert(page);
      const size = cell.resize
        ? { width: cell.width, height: cell.height }
        : null;
      const sheet = await openCard(page, theme, size);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await sheet.getByRole("button", { name: "Cancel", exact: true }).tap();
      await expect(sheet).toHaveCount(0);
      const again = await openInsert(page);
      await expect(again).toHaveClass(
        new RegExp(`bottom-sheet--${cell.detent}`),
      );
      await again
        .getByRole("button", {
          name:
            cell.detent === "half"
              ? "Expand to full height"
              : "Collapse to strip",
          exact: true,
        })
        .tap();
      await expect(again).not.toHaveClass(
        new RegExp(`bottom-sheet--${cell.detent}`),
      );
      await again.getByRole("button", { name: "Close", exact: true }).tap();
      await expect(again).toHaveCount(0);
      const third = await openInsert(page);
      await expect(third).toHaveClass(
        new RegExp(`bottom-sheet--${cell.detent}`),
      );
    });
  });
}
