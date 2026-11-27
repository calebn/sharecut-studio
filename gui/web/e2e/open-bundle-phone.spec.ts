import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { kitFile, segmentFile } from "./bundleFiles";
import { e2eProjectPath } from "./env";
import { expectFeedback } from "./feedback";
import { openHome } from "./home";
import {
  expectNoHorizontalScroll,
  expectTouchTargets,
  mockBootstrap,
  prepare,
  shot,
} from "./modelsMock";
import { setRootFontSize } from "./rootFontSize";
import { openProject } from "./stageNav";
import { withAppearance } from "./theme";

const CELLS = [
  { name: "390x844", width: 390, height: 844, fontPx: null },
  { name: "320x568-200pct", width: 320, height: 568, fontPx: 32 },
] as const;

type Row = Record<string, unknown>;

const TOKEN = "e".repeat(32);
const SEGMENT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KIT_ID = "1f8fad5b-d9cb-469f-a165-70867728950e";

const COLD_OPEN: Row = {
  id: "cold-open-1a2b3c4d",
  name: "Cold open",
  kind: "intro",
  version: 1,
  versions: [1],
  clips: [{ audio: "intro.flac", offset_sec: 0, duration_sec: 12.4 }],
};
const WARM_BED: Row = {
  ...COLD_OPEN,
  id: "warm-bed-5e6f7a8b",
  name: "Warm bed",
};

type Mock = {
  segments: Row[];
  gets: string[];
  deletes: string[];
  cancels: string[];
  commits: string[];
  gone: Set<string>;
};

async function mockInbox(page: Page): Promise<Mock> {
  const mock: Mock = {
    segments: [COLD_OPEN],
    gets: [],
    deletes: [],
    cancels: [],
    commits: [],
    gone: new Set(),
  };
  const bytes: Record<string, Buffer> = {
    [SEGMENT_ID]: segmentFile("Warm bed"),
    [KIT_ID]: kitFile("Show Kit", [
      { name: "Cold open", kind: "intro", seconds: 12 },
      { name: "Sign off", kind: "outro", seconds: 20 },
    ]),
  };
  await page.route(
    (url) => url.pathname.startsWith("/api/import/inbox/"),
    async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      if (route.request().method() === "DELETE") {
        mock.deletes.push(id);
        await route.fulfill({ json: { removed: id } });
        return;
      }
      mock.gets.push(id);
      if (mock.gone.has(id) || !bytes[id]) {
        await route.fulfill({
          status: 404,
          headers: { "X-Sharecut-Error-Code": "import_inbox_unknown" },
          json: {
            detail:
              "That file can't be found. Open it from the share sheet again.",
          },
        });
        return;
      }
      await route.fulfill({
        body: bytes[id],
        contentType: "application/octet-stream",
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/segments",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: mock.segments });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/kits",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: [] });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/segments/import/preview",
    async (route) => {
      await route.fulfill({
        json: {
          token: TOKEN,
          name: "Warm bed",
          kind: "intro",
          duration_sec: 22,
          clip_count: 1,
          outcome: "added",
          version: 1,
          existing_id: null,
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/segments/import",
    async (route) => {
      mock.commits.push(route.request().postData() ?? "");
      mock.segments.push(WARM_BED);
      await route.fulfill({
        json: { status: "added", id: WARM_BED.id, version: 1 },
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/segments/import/"),
    async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      mock.cancels.push(`segment:${route.request().url().split("/").pop()}`);
      await route.fulfill({ json: { cancelled: TOKEN } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/kits/import/preview",
    async (route) => {
      await route.fulfill({
        json: {
          token: TOKEN,
          name: "Show Kit",
          kit_id: "show-kit-1a2b3c4d",
          outcome: "added",
          version: 1,
          entry_count: 2,
          counts: { added: 2, new_version: 0, unchanged: 0 },
          entries: [
            {
              position: 0,
              name: "Cold open",
              kind: "intro",
              duration_sec: 12,
              at: "start",
              note: null,
              outcome: "added",
              version: 1,
            },
            {
              position: 1,
              name: "Sign off",
              kind: "outro",
              duration_sec: 20,
              at: "end",
              note: null,
              outcome: "added",
              version: 1,
            },
          ],
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/kits/import/"),
    async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      mock.cancels.push(`kit:${route.request().url().split("/").pop()}`);
      await route.fulfill({ json: { cancelled: TOKEN } });
    },
  );
  return mock;
}

const NAMES: Record<string, string> = {
  [SEGMENT_ID]: "warm-bed.sharecutseg",
  [KIT_ID]: "show-kit.sharecutkit",
};

async function fakeApp(page: Page, queued: string[] = []): Promise<void> {
  await page.addInitScript(
    ({ ids, names }) => {
      const target = window as unknown as Record<string, unknown>;
      target.isTauri = true;
      target.__sharecutOpenBundleQueue = ids.map((id) => ({
        id,
        name: names[id],
        size: 1000,
      }));
    },
    { ids: queued, names: NAMES },
  );
}

/** The native host pushing a file while the page runs, after the text size is set. */
async function deliver(page: Page, id: string): Promise<void> {
  await page.evaluate(
    ({ id, name }) => {
      const target = window as unknown as Record<string, unknown[]>;
      target.__sharecutOpenBundleQueue.push({ id, name, size: 1000 });
      window.dispatchEvent(new CustomEvent("sharecut:open-bundle"));
    },
    { id, name: NAMES[id] },
  );
}

async function settled(scope: Locator): Promise<void> {
  let last = "";
  await expect
    .poll(async () => {
      const box = JSON.stringify(await scope.boundingBox());
      const same = box === last;
      last = box;
      return same;
    })
    .toBe(true);
}

async function expectReachable(sheet: Locator, names: string[]): Promise<void> {
  await settled(sheet);
  for (const name of names) {
    const button = sheet.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect
      .poll(
        () =>
          button.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return hit !== null && element.contains(hit);
          }),
        { message: `${name} is not covered` },
      )
      .toBe(true);
  }
}

const segmentSheet = (page: Page) =>
  page.getByRole("dialog", { name: "Import a segment" });
const kitSheet = (page: Page) =>
  page.getByRole("dialog", { name: "Import a kit" });

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`open in ShareCut phone ${cell.name}`, () => {
    test.use({
      viewport: { width: cell.width, height: cell.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
      await prepare(page, theme, true);
      await mockBootstrap(page);
    });

    test("a segment received while Home shows opens the sheet, drops the inbox copy and refreshes Home's list on Add", async ({
      page,
    }) => {
      const mock = await mockInbox(page);
      await fakeApp(page);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await deliver(page, SEGMENT_ID);
      const list = page
        .getByRole("region", { name: "Segment library" })
        .getByRole("list", { name: "Segment library" })
        .getByRole("listitem");
      await expect(list).toHaveCount(1);

      const sheet = segmentSheet(page);
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("Adds Warm bed");
      expect(mock.gets).toEqual([SEGMENT_ID]);
      await expect.poll(() => mock.deletes).toEqual([SEGMENT_ID]);
      expect(new URL(page.url()).searchParams.get("home")).toBe("1");
      await expectTouchTargets(sheet);
      await expectNoHorizontalScroll(page);
      await expectReachable(sheet, ["Add to library", "Cancel"]);
      await expectSurfaceAxeClean(page, '[role="dialog"]');
      await shot(page, cell.name, theme, "open-bundle-home");

      await sheet.getByRole("button", { name: "Add to library" }).click();
      await expect(sheet).toHaveCount(0);
      expect(mock.commits).toEqual([JSON.stringify({ token: TOKEN })]);
      await expectFeedback(page, /Added Warm bed/);
      await expect(list).toHaveCount(2);
    });

    test("Cancel on a received segment removes the staged file", async ({
      page,
    }) => {
      const mock = await mockInbox(page);
      await fakeApp(page);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await deliver(page, SEGMENT_ID);
      const sheet = segmentSheet(page);
      await expect(sheet).toBeVisible();
      await expectReachable(sheet, ["Add to library", "Cancel"]);
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).toHaveCount(0);
      expect(mock.cancels).toEqual([`segment:${TOKEN}`]);
      expect(mock.commits).toEqual([]);
    });

    test("a kit received with an episode open shows over the editor and leaves the URL alone", async ({
      page,
    }) => {
      const mock = await mockInbox(page);
      await fakeApp(page);
      await openProject(page, e2eProjectPath);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await deliver(page, KIT_ID);
      const before = page.url();
      const sheet = kitSheet(page);
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("Adds Show Kit");
      expect(mock.gets).toEqual([KIT_ID]);
      await expect.poll(() => mock.deletes).toEqual([KIT_ID]);
      await expectTouchTargets(sheet);
      await expectNoHorizontalScroll(page);
      await expectReachable(sheet, ["Add to library", "Cancel"]);
      await shot(page, cell.name, theme, "open-bundle-episode");

      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      expect(mock.cancels).toEqual([`kit:${TOKEN}`]);
      expect(page.url()).toBe(before);
      await expect(page.getByRole("main")).toBeVisible();
    });

    test("a file the app no longer holds says it can't be found and opens no sheet", async ({
      page,
    }) => {
      const mock = await mockInbox(page);
      mock.gone.add(SEGMENT_ID);
      await fakeApp(page, [SEGMENT_ID]);
      await openHome(page);
      await expectFeedback(
        page,
        "That file can't be found. Open it from the share sheet again.",
      );
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(mock.deletes).toEqual([]);
    });
  });
}

test("a file queued before the page loaded opens its sheet at launch", async ({
  page,
}) => {
  await prepare(page, "dark", true);
  await mockBootstrap(page);
  const mock = await mockInbox(page);
  await fakeApp(page, [SEGMENT_ID]);
  await openHome(page);
  await expect(segmentSheet(page)).toContainText("Adds Warm bed");
  await expect.poll(() => mock.deletes).toEqual([SEGMENT_ID]);
});

test("a plain browser reads nothing from the queue", async ({ page }) => {
  await prepare(page, "dark", true);
  await mockBootstrap(page);
  const mock = await mockInbox(page);
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__sharecutOpenBundleQueue = [
      { id, name: "warm-bed.sharecutseg", size: 1000 },
    ];
  }, SEGMENT_ID);
  await openHome(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mock.gets).toEqual([]);
});
