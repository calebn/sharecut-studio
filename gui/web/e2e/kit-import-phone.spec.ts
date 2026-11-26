import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { kitFile, kitJsonOf, segmentFile, storedZip } from "./bundleFiles";
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
import { withAppearance } from "./theme";

const CELLS = [
  { name: "390x844", width: 390, height: 844, fontPx: null },
  { name: "320x568-200pct", width: 320, height: 568, fontPx: 32 },
] as const;

type Row = Record<string, unknown>;

const COLD_OPEN: Row = {
  id: "cold-open-1a2b3c4d",
  name: "Cold open",
  kind: "intro",
  version: 1,
  versions: [1],
  clips: [{ audio: "intro.flac", offset_sec: 0, duration_sec: 12.4 }],
};

const TOKEN = "e".repeat(32);

const SHOW_KIT: Row = {
  id: "show-kit-1a2b3c4d",
  name: "Show Kit",
  version: 1,
  versions: [1],
  entries: 3,
  missing: 0,
  usable: true,
  problem: null,
};

const SEGMENTS = [
  { name: "Cold open", kind: "intro", seconds: 12 },
  { name: "Sponsor read", kind: "sponsor", seconds: 31 },
  { name: "Sign off", kind: "outro", seconds: 20 },
];

type Mock = {
  kits: Row[];
  segments: Row[];
  kitLists: number;
  uploads: { bytes: Buffer; type: string | undefined }[];
  segmentUploads: number;
  commits: string[];
  cancels: string[];
  /** Answers each commit in turn; an empty queue adds the kit. */
  failures: { status: number; code: string; body: Row }[];
};

async function mockLibraries(page: Page, kits: Row[] = []): Promise<Mock> {
  const mock: Mock = {
    kits: [...kits],
    segments: [COLD_OPEN],
    kitLists: 0,
    uploads: [],
    segmentUploads: 0,
    commits: [],
    cancels: [],
    failures: [],
  };
  await page.route(
    (url) => url.pathname === "/api/segments",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: mock.segments });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/segments/import/preview",
    async (route) => {
      mock.segmentUploads += 1;
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
    (url) => url.pathname.startsWith("/api/segments/import/"),
    async (route) => {
      if (route.request().method() === "DELETE") {
        mock.cancels.push(`segment:${route.request().url().split("/").pop()}`);
        await route.fulfill({ json: { cancelled: TOKEN } });
        return;
      }
      await route.fallback();
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/kits"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.pathname === "/api/kits" && method === "GET") {
        mock.kitLists += 1;
        await route.fulfill({ json: mock.kits });
        return;
      }
      if (url.pathname === "/api/kits/import/preview") {
        const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
        mock.uploads.push({ bytes, type: request.headers()["content-type"] });
        const found = kitJsonOf(bytes);
        if (!found) {
          await route.fulfill({
            status: 422,
            headers: { "X-Sharecut-Error-Code": "kit_bundle_invalid" },
            json: { detail: "This file is not a kit bundle." },
          });
          return;
        }
        const entries = (found.entries as Row[]).map((entry, position) => ({
          position,
          name: SEGMENTS[position]?.name ?? `Segment ${position + 1}`,
          kind: SEGMENTS[position]?.kind ?? "other",
          duration_sec: SEGMENTS[position]?.seconds ?? 10,
          at: entry.at,
          note:
            position === 1
              ? "Move to after the first break if the episode is short."
              : null,
          outcome: position === 0 ? "unchanged" : "added",
          version: 1,
        }));
        const same = mock.kits.some((row) => row.name === found.name);
        const fresh = same
          ? []
          : entries.filter((entry) => entry.outcome !== "unchanged");
        await route.fulfill({
          json: {
            token: TOKEN,
            name: found.name,
            kit_id: "show-kit-1a2b3c4d",
            outcome: same ? "unchanged" : "added",
            version: 1,
            entry_count: entries.length,
            counts: {
              added: fresh.length,
              new_version: 0,
              unchanged: entries.length - fresh.length,
            },
            entries: same
              ? entries.map((entry) => ({ ...entry, outcome: "unchanged" }))
              : entries,
          },
        });
        return;
      }
      if (url.pathname === "/api/kits/import" && method === "POST") {
        mock.commits.push(request.postData() ?? "");
        const failure = mock.failures.shift();
        if (failure) {
          await route.fulfill({
            status: failure.status,
            headers: { "X-Sharecut-Error-Code": failure.code },
            json: failure.body,
          });
          return;
        }
        mock.kits.push(SHOW_KIT);
        mock.segments.push(
          { ...COLD_OPEN, id: "sponsor-read-2", name: "Sponsor read" },
          { ...COLD_OPEN, id: "sign-off-3", name: "Sign off" },
        );
        await route.fulfill({
          json: {
            kit: { status: "added", id: "show-kit-1a2b3c4d", version: 1 },
            segments: [
              { status: "unchanged", id: COLD_OPEN.id, version: 1 },
              { status: "added", id: "sponsor-read-2", version: 1 },
              { status: "added", id: "sign-off-3", version: 1 },
            ],
          },
        });
        return;
      }
      const staged = url.pathname.match(/^\/api\/kits\/import\/([0-9a-f]+)$/);
      if (staged && method === "DELETE") {
        mock.cancels.push(`kit:${staged[1]}`);
        await route.fulfill({ json: { cancelled: staged[1] } });
        return;
      }
      await route.fallback();
    },
  );
  return mock;
}

async function expectInsideViewport(scope: Locator): Promise<void> {
  const width = await scope.page().evaluate(() => window.innerWidth);
  for (const control of await scope.getByRole("button").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
}

async function chooseFile(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: "application/zip", buffer });
}

/** The sheet slides and resizes in; wait until two samples agree before measuring it. */
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

async function dropFiles(
  page: Page,
  files: { name: string; bytes: number[] }[],
): Promise<void> {
  await page.evaluate((list) => {
    const transfer = new DataTransfer();
    for (const { name, bytes } of list)
      transfer.items.add(new File([new Uint8Array(bytes)], name));
    for (const type of ["dragover", "drop"]) {
      document.body.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, files);
}

const kitSheet = (page: Page) =>
  page.getByRole("dialog", { name: "Import a kit" });
const segmentSheet = (page: Page) =>
  page.getByRole("dialog", { name: "Import a segment" });

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`kit import phone ${cell.name}`, () => {
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

    async function home(page: Page, kits: Row[] = []) {
      const mock = await mockLibraries(page, kits);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      const section = page.getByRole("region", { name: "Segment library" });
      await expect(section).toBeVisible();
      return { mock, section };
    }

    test("a chosen kit file previews its entries in order, adds, and reads both lists again", async ({
      page,
    }) => {
      const { mock, section } = await home(page);
      // The Kits section is left out of Home while the library is empty; Import is still there.
      await expect(page.getByRole("region", { name: "Kits" })).toHaveCount(0);
      const file = kitFile("Show Kit", SEGMENTS);

      await chooseFile(page, "show-kit.sharecutkit", file);

      const sheet = kitSheet(page);
      await expect(sheet).toBeVisible();
      await expect(
        sheet.getByRole("heading", { name: "Show Kit" }),
      ).toBeVisible();
      await expect(sheet).toContainText("Adds Show Kit");
      await expect(sheet).toContainText("3 segments: 2 new, 1 already there");
      const rows = sheet
        .getByRole("list", { name: "Kit entries" })
        .getByRole("listitem");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("Cold open");
      await expect(rows.nth(0)).toContainText("Already there");
      await expect(rows.nth(1)).toContainText("Sponsor read");
      await expect(rows.nth(1)).toContainText("Sponsor");
      await expect(rows.nth(1)).toContainText("0:31");
      await expect(rows.nth(1)).toContainText("At start");
      await expect(rows.nth(1)).toContainText("Move to after the first break");
      await expect(rows.nth(1)).toContainText("New");
      await expect(rows.nth(2)).toContainText("At end");
      await expect(sheet.getByRole("button", { name: /play/i })).toHaveCount(0);
      expect(mock.uploads).toHaveLength(1);
      expect(mock.uploads[0].type).toBe("application/octet-stream");
      expect(mock.uploads[0].bytes.equals(file)).toBe(true);
      await expect(
        sheet.getByRole("button", { name: "Add to library" }),
      ).toBeFocused();
      await expectTouchTargets(sheet);
      await expectInsideViewport(sheet);
      await expectNoHorizontalScroll(page);
      await settled(sheet);
      await expectSurfaceAxeClean(page, '[role="dialog"]');
      await shot(page, cell.name, theme, "kit-import-preview");

      // The list scrolls inside the sheet, so the last entry can be reached.
      await rows.nth(2).scrollIntoViewIfNeeded();
      await expect(rows.nth(2)).toBeVisible();

      await sheet.getByRole("button", { name: "Add to library" }).click();
      await expect(sheet).toHaveCount(0);
      expect(mock.commits).toEqual([JSON.stringify({ token: TOKEN })]);
      await expectFeedback(
        page,
        "Added Show Kit to your library, with 2 new segments",
      );
      const kits = page.getByRole("region", { name: "Kits" });
      await expect(kits).toBeVisible();
      await expect(
        kits.getByRole("list", { name: "Saved kits" }).getByRole("listitem"),
      ).toHaveCount(1);
      await expect(
        section
          .getByRole("list", { name: "Segment library" })
          .getByRole("listitem"),
      ).toHaveCount(3);
      await expect(
        page.getByRole("button", { name: "Import", exact: true }),
      ).toBeFocused();
      await expectTouchTargets(section);
      await expectNoHorizontalScroll(page);
    });

    test("a kit that is already in the library has Close only and adds nothing", async ({
      page,
    }) => {
      const { mock } = await home(page, [SHOW_KIT]);
      await chooseFile(
        page,
        "show-kit.sharecutkit",
        kitFile("Show Kit", SEGMENTS),
      );
      const sheet = kitSheet(page);
      await expect(sheet).toContainText("Already in your library");
      const actions = sheet.locator(".sys-segment-actions");
      await expect(actions.getByRole("button")).toHaveCount(1);
      await expect(
        actions.getByRole("button", { name: "Close" }),
      ).toBeFocused();
      await expect(
        sheet.getByRole("button", { name: "Add to library" }),
      ).toHaveCount(0);
      await expectTouchTargets(sheet);
      await actions.getByRole("button", { name: "Close" }).click();
      await expect(sheet).toHaveCount(0);
      expect(mock.commits).toEqual([]);
      expect(mock.cancels).toEqual([`kit:${TOKEN}`]);
    });

    test("a busy library keeps the file, says how many landed, and Add again finishes with the same token", async ({
      page,
    }) => {
      const { mock } = await home(page);
      mock.failures.push({
        status: 409,
        code: "kit_busy",
        body: {
          detail: "The library is being changed by another program.",
          segments_added: [
            { status: "added", id: "sponsor-read-2", version: 1 },
          ],
          segments_total: 2,
        },
      });
      await chooseFile(
        page,
        "show-kit.sharecutkit",
        kitFile("Show Kit", SEGMENTS),
      );
      const sheet = kitSheet(page);
      await sheet.getByRole("button", { name: "Add to library" }).click();
      await expect(sheet.getByRole("alert")).toContainText(
        "The library is being changed by another program. Added 1 of 2 segments. Choose Add to library to finish.",
      );
      await expect(sheet).toBeVisible();
      expect(mock.cancels).toEqual([]);
      await expectTouchTargets(sheet);
      await expectInsideViewport(sheet);
      await expectNoHorizontalScroll(page);
      await settled(sheet);
      await expectSurfaceAxeClean(page, '[role="dialog"]');
      await shot(page, cell.name, theme, "kit-import-retry");
      const lists = mock.kitLists;

      await sheet.getByRole("button", { name: "Add to library" }).click();
      await expect(sheet).toHaveCount(0);
      expect(mock.commits).toEqual([
        JSON.stringify({ token: TOKEN }),
        JSON.stringify({ token: TOKEN }),
      ]);
      await expectFeedback(page, /Added Show Kit to your library/);
      expect(mock.kitLists).toBeGreaterThan(lists);
    });

    test("a file the service refuses shows its message and adds nothing", async ({
      page,
    }) => {
      const { mock } = await home(page);
      await chooseFile(page, "notes.sharecutkit", Buffer.from("not a zip"));
      const sheet = kitSheet(page);
      await expect(sheet.getByRole("alert")).toHaveText(
        "This file is not a kit bundle.",
      );
      await expect(
        sheet.getByRole("button", { name: "Add to library" }),
      ).toHaveCount(0);
      await expectTouchTargets(sheet);
      await expectNoHorizontalScroll(page);
      await settled(sheet);
      await expectSurfaceAxeClean(page, '[role="dialog"]');
      await shot(page, cell.name, theme, "kit-import-refused");
      await sheet
        .locator(".sys-segment-actions")
        .getByRole("button", { name: "Close" })
        .click();
      await expect(sheet).toHaveCount(0);
      expect(mock.commits).toEqual([]);
    });

    test("Cancel removes the waiting kit file", async ({ page }) => {
      const { mock } = await home(page);
      await chooseFile(
        page,
        "show-kit.sharecutkit",
        kitFile("Show Kit", SEGMENTS),
      );
      await kitSheet(page).getByRole("button", { name: "Cancel" }).click();
      await expect(kitSheet(page)).toHaveCount(0);
      expect(mock.cancels).toEqual([`kit:${TOKEN}`]);
      expect(mock.commits).toEqual([]);
    });

    test("the toast of the last add is gone, so the next preview's buttons can be reached", async ({
      page,
    }) => {
      await home(page);
      await chooseFile(
        page,
        "show-kit.sharecutkit",
        kitFile("Show Kit", SEGMENTS),
      );
      await kitSheet(page)
        .getByRole("button", { name: "Add to library" })
        .click();
      await expectFeedback(
        page,
        "Added Show Kit to your library, with 2 new segments",
      );

      await chooseFile(
        page,
        "other-kit.sharecutkit",
        kitFile("Other Kit", SEGMENTS),
      );
      const sheet = kitSheet(page);
      await expect(sheet).toContainText("Adds Other Kit");
      const add = sheet.getByRole("button", { name: "Add to library" });
      await expect(add).toBeVisible();
      await expect(
        page.locator(".ui-toast-region--app .ui-toast-message"),
      ).toHaveCount(0);
      await settled(sheet);
      for (const name of ["Add to library", "Cancel"]) {
        const button = sheet.getByRole("button", { name });
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        const covered = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit === null || !element.contains(hit);
        });
        expect(covered, `${name} is not covered`).toBe(false);
      }
    });

    test("a kit file dropped anywhere on Home opens the kit preview, a segment file the segment one", async ({
      page,
    }) => {
      const { mock } = await home(page);
      await dropFiles(page, [
        {
          name: "show-kit.sharecutkit",
          bytes: [...kitFile("Show Kit", SEGMENTS)],
        },
      ]);
      await expect(kitSheet(page)).toContainText("Adds Show Kit");
      expect(mock.uploads).toHaveLength(1);
      expect(mock.segmentUploads).toBe(0);
      await kitSheet(page).getByRole("button", { name: "Cancel" }).click();
      await expect(kitSheet(page)).toHaveCount(0);

      await dropFiles(page, [
        {
          name: "warm-bed.sharecutseg",
          bytes: [...segmentFile("Warm bed")],
        },
      ]);
      await expect(segmentSheet(page)).toContainText("Adds Warm bed");
      expect(mock.segmentUploads).toBe(1);
      expect(mock.uploads).toHaveLength(1);
    });

    test("a zip with a phone's own name is told apart by what is inside it", async ({
      page,
    }) => {
      const { mock } = await home(page);
      await dropFiles(page, [
        {
          name: "show-kit (1).zip",
          bytes: [...kitFile("Show Kit", SEGMENTS)],
        },
      ]);
      await expect(kitSheet(page)).toContainText("Adds Show Kit");
      expect(mock.uploads).toHaveLength(1);
      await kitSheet(page).getByRole("button", { name: "Cancel" }).click();
      await expect(kitSheet(page)).toHaveCount(0);

      await dropFiles(page, [
        {
          name: "notes.zip",
          bytes: [...storedZip({ "notes.txt": Buffer.from("hello") })],
        },
      ]);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(mock.uploads).toHaveLength(1);
      expect(mock.segmentUploads).toBe(0);
    });
  });
}
