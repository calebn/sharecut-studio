import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { expectFeedback } from "./feedback";
import { expectNoHorizontalScroll, expectTouchTargets } from "./modelsMock";
import { setRootFontSize } from "./rootFontSize";
import { openProject } from "./stageNav";
import { setTheme, withAppearance } from "./theme";

const CELLS = [
  { name: "390x844", width: 390, height: 844, fontPx: null },
  { name: "320x740", width: 320, height: 740, fontPx: null },
  { name: "320x568-200pct", width: 320, height: 568, fontPx: 32 },
] as const;

const OFFER = {
  offer: true,
  reason: "offer",
  unusable: [],
  kits: [
    {
      id: "show-kit-1a2b3c4d",
      name: "Show Kit",
      version: 2,
      entries: [
        { segment_id: "intro-9f3a", version: 1, at: "start", note: null },
        { segment_id: "outro-77de", version: 1, at: "end", note: null },
      ],
    },
  ],
};

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
    id: "outro-77de",
    name: "Sign off",
    kind: "outro",
    version: 1,
    versions: [1],
    clips: [{ audio: "outro.flac", offset_sec: 0, duration_sec: 12 }],
  },
];

const REPORT = {
  kit_id: OFFER.kits[0]?.id,
  kit_version: 2,
  timeline_duration_before_sec: 60,
  timeline_duration_after_sec: 94,
  dry_run: false,
  entries: [
    { position: 1, history_head_id: "hist_e2e_kit_1" },
    { position: 2, history_head_id: "hist_e2e_kit_2" },
  ],
  undo_steps: 2,
};

type Mocked = {
  applies: Record<string, unknown>[];
  undos: Record<string, unknown>[];
  offers: number;
};

async function mockKit(page: Page): Promise<Mocked> {
  const mocked: Mocked = { applies: [], undos: [], offers: 0 };
  let applied = false;
  await page.route(
    (url) => url.pathname === "/api/kits/offer",
    async (route) => {
      mocked.offers += 1;
      await route.fulfill({
        json: applied
          ? {
              offer: false,
              reason: "already_has_segments",
              kits: [],
              unusable: [],
            }
          : OFFER,
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/segments",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: LIBRARY });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/kits/apply",
    async (route) => {
      mocked.applies.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      applied = true;
      await route.fulfill({ json: REPORT });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/document/command",
    async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.type !== "UndoHistory") return route.fallback();
      mocked.undos.push(body);
      const heads = ["hist_e2e_kit_1", "hist_e2e_kit_0"];
      await route.fulfill({
        json: { history_head_id: heads[mocked.undos.length - 1] },
      });
    },
  );
  return mocked;
}

const notice = (page: Page) =>
  page
    .getByRole("status")
    .filter({ hasText: "Add your show's intro and outro?" });

async function open(
  page: Page,
  cell: (typeof CELLS)[number],
  theme: "light" | "dark",
) {
  await openProject(page, e2eProjectPath);
  await page.setViewportSize({ width: cell.width, height: cell.height });
  await setTheme(page, theme);
  if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
}

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`kit offer iphone ${cell.name}`, () => {
    test.use({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
    });

    test("offers the kit with 44 px buttons and no sideways scroll, adds it on the tap, and Undo takes both back", async ({
      page,
    }) => {
      const mocked = await mockKit(page);
      await open(page, cell, theme);
      await expect(notice(page)).toBeVisible();
      await expect(notice(page)).toContainText(
        "Cold open at start, Sign off at end",
      );
      await expectTouchTargets(notice(page));
      await expectNoHorizontalScroll(page);
      expect(mocked.applies).toHaveLength(0);

      await notice(page).getByRole("button", { name: "Add them" }).tap();
      await expectFeedback(
        page,
        "Added Cold open and Sign off. Undo takes back both.",
        { superseded: true },
      );
      expect(mocked.applies).toEqual([
        {
          path: e2eProjectPath,
          kit_id: OFFER.kits[0]?.id,
          kit_version: 2,
          client_id: expect.any(String),
        },
      ]);
      await expect(notice(page)).toHaveCount(0);
      await expectNoHorizontalScroll(page);

      const undo = page
        .locator(".ui-toast-region--app")
        .getByRole("button", { name: "Undo", exact: true });
      await expectTouchTargets(page.locator(".ui-toast-region--app"));
      await undo.tap();
      await expectFeedback(page, "Took back your intro and outro.", {
        superseded: true,
      });
      expect(
        mocked.undos.map(
          (body) =>
            (body.payload as { expected_head_id?: string }).expected_head_id,
        ),
      ).toEqual(["hist_e2e_kit_2", "hist_e2e_kit_1"]);
    });

    test("Not now hides it and it stays hidden after a reload", async ({
      page,
    }) => {
      const mocked = await mockKit(page);
      await open(page, cell, theme);
      await notice(page).getByRole("button", { name: "Not now" }).tap();
      await expect(notice(page)).toHaveCount(0);
      expect(mocked.applies).toHaveLength(0);
      await page.reload();
      await expect.poll(() => mocked.offers).toBeGreaterThan(1);
      await expect(notice(page)).toHaveCount(0);
    });
  });
}
