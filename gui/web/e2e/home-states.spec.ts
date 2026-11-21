import { expect, type Page, test } from "@playwright/test";
import { ERROR_CODE_HEADER } from "../src/utils/apiError";
import { dismissSetupCard, expectHome, homeRecordTile, openHome } from "./home";
import { expectNoHorizontalScroll, mockBootstrap } from "./modelsMock";
import { setRootFontSize } from "./rootFontSize";

const EPISODE = "/tmp/sharecut-e2e-home-states/rosa/episode.sharecut";

const NO_FOLDER = "Type or paste the folder of the episode, then choose Open.";

const RECENT = {
  path: EPISODE,
  name: "Rosa and Maya",
  opened_at: "2026-10-27T10:00:00Z",
  edited_at: "2026-10-27T10:00:00Z",
  duration_sec: 3130,
  stage: "review",
  chip: { text: "Review 6", state: "needs-you" },
  peaks: [],
  folder_missing: false,
};

async function mockRecents(page: Page, projects: object[]): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/projects/recent",
    (route) => route.fulfill({ json: { projects } }),
  );
}

test.describe("Home states", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("the audio tools guide link holds the 44px touch floor", async ({
    page,
  }) => {
    await mockBootstrap(page, { ffmpeg: "missing" });
    await mockRecents(page, []);
    await openHome(page, { dismissSetup: false });
    const link = page.getByRole("link", {
      name: "Setup guide for the audio tools",
    });
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    expect(box.width).toBeGreaterThanOrEqual(43.5);
    await expectNoHorizontalScroll(page);
  });

  test("opening a card marks it busy and moves nothing", async ({ page }) => {
    await mockBootstrap(page);
    await mockRecents(page, [RECENT]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/project/open",
      async (route) => {
        await held;
        await route.fulfill({ status: 500, json: { detail: "held" } });
      },
    );
    try {
      await openHome(page);
      const card = page.getByRole("button", { name: /^Rosa and Maya/ });
      await expect(card).toBeVisible();
      const before = (await card.boundingBox())!;
      await card.click();
      await expect(
        page.getByRole("status").getByText("Opening…"),
      ).toBeVisible();
      await expect(card).toHaveAttribute("aria-busy", "true");
      const after = (await card.boundingBox())!;
      expect(after.y).toBe(before.y);
      expect(after.height).toBe(before.height);
    } finally {
      release();
    }
    await expect(
      page.getByRole("button", { name: /^Rosa and Maya/ }),
    ).not.toHaveAttribute("aria-busy", "true");
  });
});

test.describe("Home first card ring", () => {
  test("the accent ring follows focus, not the first card", async ({
    page,
  }) => {
    await mockBootstrap(page);
    await mockRecents(page, [
      { ...RECENT, path: `${EPISODE}.moved`, folder_missing: true },
      RECENT,
    ]);
    await openHome(page);
    const cards = page.locator(".sys-project");
    await expect(cards).toHaveCount(2);
    const outline = (index: number) =>
      cards.nth(index).evaluate((el) => getComputedStyle(el).outlineStyle);
    await expect.poll(() => outline(1)).toBe("solid");
    expect(await outline(0)).toBe("none");
    await homeRecordTile(page).focus();
    await expect.poll(() => outline(1)).toBe("none");
    expect(await outline(0)).toBe("none");
  });
});

test.describe("Home at a large root font", () => {
  test.use({
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
  });

  test("the phone layout does not scroll sideways at a 32px root", async ({
    page,
  }) => {
    await mockBootstrap(page);
    await mockRecents(page, [RECENT]);
    await openHome(page);
    const row = ["ShareCut app menu", "Record"].map((name) =>
      page.getByRole("button", { name, exact: name !== "Record" }).first(),
    );
    const heights = () =>
      Promise.all(
        row.map(async (button) => (await button.boundingBox())!.height),
      );
    const normal = await heights();
    await setRootFontSize(page, 32);
    await expect
      .poll(async () =>
        (await heights()).every((height, i) => height > normal[i]! * 1.5),
      )
      .toBe(true);
    await expectNoHorizontalScroll(page);
    for (const name of ["ShareCut app menu", "Record"]) {
      const box = (await page
        .getByRole("button", { name, exact: name !== "Record" })
        .first()
        .boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(360);
    }
  });
});

test("a Recent card named Recording does not make Home's Record tile ambiguous", async ({
  page,
}) => {
  await mockBootstrap(page);
  await mockRecents(page, [
    { ...RECENT, path: `${EPISODE}.recording`, name: "Recording identity QA" },
  ]);
  await page.route("**/api/project/create", (route) =>
    route.fulfill({ status: 500, body: "{}" }),
  );
  await dismissSetupCard(page);
  await page.goto("/?home=1");
  await expect(
    page.getByRole("button", { name: "Recording identity QA" }),
  ).toBeVisible();
  await expectHome(page);
  const created = page.waitForRequest("**/api/project/create");
  await homeRecordTile(page).click();
  await created;
});

async function openOtherPanel(page: Page) {
  await mockBootstrap(page);
  await mockRecents(page, [RECENT, { ...RECENT, path: `${EPISODE}.2` }]);
  await page.route(
    (url) => url.pathname === "/api/project/pick",
    (route) => route.fulfill({ json: { unavailable: true } }),
  );
  await page.route(
    (url) => url.pathname === "/api/project/open",
    (route) =>
      route.fulfill({
        status: 400,
        headers: { [ERROR_CODE_HEADER]: "project_path_invalid" },
        json: { detail: "expected episode.sharecut" },
      }),
  );
  await openHome(page);
  await page.getByRole("button", { name: "Open other…" }).click();
  const field = page.getByRole("textbox", { name: "Folder of the episode" });
  await expect(field).toBeFocused();
  return field;
}

const VIEWPORTS = [
  { name: "phone 390 touch", width: 390, height: 844, touch: true },
  { name: "iPad 820 touch", width: 820, height: 1180, touch: true },
  { name: "laptop 1280", width: 1280, height: 800, touch: false },
] as const;

for (const viewport of VIEWPORTS) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`Open other panel, ${viewport.name}, ${theme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.touch,
        hasTouch: viewport.touch,
        colorScheme: theme,
      });

      test("the panel and its wrapped error sit above the first Recent card", async ({
        page,
      }) => {
        const field = await openOtherPanel(page);
        await field.fill("/ws/not-an-episode");
        await field.press("Enter");
        const alert = page.getByRole("alert");
        await expect(alert).toContainText(
          "That folder has no ShareCut episode",
        );
        const panel = (await page
          .getByRole("form", { name: "Open another episode" })
          .boundingBox())!;
        const card = (await page
          .locator("[data-project-open]")
          .first()
          .boundingBox())!;
        expect(card.y).toBeGreaterThanOrEqual(panel.y + panel.height);
        expect(panel.x).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width);
        await expectNoHorizontalScroll(page);
      });

      test("an empty or spaces-only submit says what is missing", async ({
        page,
      }) => {
        const field = await openOtherPanel(page);
        let opens = 0;
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/api/project/open") opens++;
        });
        await field.press("Enter");
        await expect(page.getByRole("alert")).toHaveText(NO_FOLDER);
        await field.fill("   ");
        await field.press("Enter");
        await expect(page.getByRole("alert")).toHaveText(NO_FOLDER);
        await expect(page.getByRole("alert")).not.toContainText("no ShareCut");
        expect(opens).toBe(0);
        await field.press("Escape");
        await expect(
          page.getByRole("button", { name: "Open other…" }),
        ).toBeFocused();
      });
    });
  }
}

test.describe("Open other panel at a large root font", () => {
  for (const width of [390, 360]) {
    test.describe(`${width}px wide, 32px root`, () => {
      test.use({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      });

      test("the panel fits the viewport, Open stays visible and the cards sit below it", async ({
        page,
      }) => {
        const field = await openOtherPanel(page);
        await setRootFontSize(page, 32);
        await field.fill("/ws/not-an-episode");
        await field.press("Enter");
        await expect(page.getByRole("alert")).toContainText("no ShareCut");
        const panel = (await page
          .getByRole("form", { name: "Open another episode" })
          .boundingBox())!;
        const open = (await page
          .getByRole("form", { name: "Open another episode" })
          .getByRole("button", { name: "Open", exact: true })
          .boundingBox())!;
        const card = (await page
          .locator("[data-project-open]")
          .first()
          .boundingBox())!;
        expect(panel.x).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width).toBeLessThanOrEqual(width);
        expect(open.x).toBeGreaterThanOrEqual(panel.x);
        expect(open.x + open.width).toBeLessThanOrEqual(panel.x + panel.width);
        expect(card.y).toBeGreaterThanOrEqual(panel.y + panel.height);
        await expectNoHorizontalScroll(page);
      });
    });
  }
});

test("opening the panel leaves the Open other trigger where it was", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockBootstrap(page);
  await mockRecents(page, [RECENT]);
  await page.route(
    (url) => url.pathname === "/api/project/pick",
    (route) => route.fulfill({ json: { unavailable: true } }),
  );
  await openHome(page);
  const trigger = page.getByRole("button", { name: "Open other…" });
  const before = (await trigger.boundingBox())!;
  await trigger.click();
  await expect(
    page.getByRole("form", { name: "Open another episode" }),
  ).toBeVisible();
  const after = (await trigger.boundingBox())!;
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
});
