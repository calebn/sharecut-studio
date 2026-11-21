import { expect, type Locator, type Page, test } from "@playwright/test";
import { dismissSetupCard, expectHome, homeRecordTile, openHome } from "./home";
import { expectNoHorizontalScroll, mockBootstrap } from "./modelsMock";
import { setRootFontSize } from "./rootFontSize";

const EPISODE = "/tmp/sharecut-e2e-home-states/rosa/episode.sharecut";

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

async function expectFitsVisualViewport(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      (window.visualViewport?.width ?? window.innerWidth),
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectLabelWhole(label: Locator): Promise<void> {
  const [scroll, client] = await label.evaluate((el) => [
    el.scrollWidth,
    el.clientWidth,
  ]);
  expect(scroll).toBeLessThanOrEqual(client);
}

const EMPTY_HOME_SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "iPad", width: 820, height: 1180 },
];

for (const size of EMPTY_HOME_SIZES) {
  test.describe(`Empty Home on a ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      isMobile: true,
      hasTouch: true,
    });

    test("the tiles start in the first screen and the page does not scroll sideways", async ({
      page,
    }) => {
      await mockBootstrap(page);
      await mockRecents(page, []);
      await openHome(page);
      const import_ = page.locator(".sys-home .sys-start--import");
      const record = homeRecordTile(page);
      for (const tile of [import_, record]) {
        const box = (await tile.boundingBox())!;
        expect(box.y).toBeLessThan(300);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      }
      await expect(
        page.getByText("Your episodes will appear here."),
      ).toBeVisible();
      await expect(page.getByText(/Drop a file anywhere/)).toBeHidden();
      await expectNoHorizontalScroll(page);
    });
  });
}

for (const width of [390, 360]) {
  test.describe(`Empty Home at ${width}px wide`, () => {
    test.use({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
    });

    test("both tiles stay inside the page with whole labels at a 32px root", async ({
      page,
    }) => {
      await mockBootstrap(page);
      await mockRecents(page, []);
      await openHome(page);
      await setRootFontSize(page, 32);
      await expectFitsVisualViewport(page);
      for (const tile of [
        page.locator(".sys-home .sys-start--import"),
        homeRecordTile(page),
      ]) {
        const box = (await tile.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await expectLabelWhole(tile.locator(".sys-start-title"));
      }
    });
  });
}

test.describe("Home with many recents on a phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("a focused last Recent row is not hidden under the bottom bar", async ({
    page,
  }) => {
    await mockBootstrap(page);
    await mockRecents(
      page,
      Array.from({ length: 8 }, (_, i) => ({
        ...RECENT,
        path: `${EPISODE}.${i}`,
        name: `Episode ${i}`,
      })),
    );
    await openHome(page);
    const last = page.getByRole("button", { name: /^Episode 7/ });
    await last.focus();
    await expect
      .poll(async () => {
        const box = (await last.boundingBox())!;
        const bar = (await page.locator(".sys-home-bar").boundingBox())!;
        return box.y + box.height <= bar.y;
      })
      .toBe(true);
  });
});

test.describe("Home while the Recent list loads on a phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("an empty result never shows the tiles at the bottom first", async ({
    page,
  }) => {
    await mockBootstrap(page);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/projects/recent",
      async (route) => {
        await held;
        await route.fulfill({ json: { projects: [] } });
      },
    );
    await dismissSetupCard(page);
    await page.goto("/?home=1");
    await expect(
      page.getByRole("heading", { level: 1, name: "ShareCut" }),
    ).toBeVisible();
    await page.evaluate(() => {
      const seen: number[] = [];
      (window as unknown as { __tileTops: number[] }).__tileTops = seen;
      const sample = () => {
        const tile = document.querySelector(".sys-home .sys-start--import");
        if (tile) seen.push(tile.getBoundingClientRect().top);
      };
      new MutationObserver(sample).observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
    await expect(page.locator(".sys-home .sys-start--import")).toHaveCount(0);
    release();
    await expect(page.locator(".sys-home .sys-start--import")).toBeVisible();
    await page.waitForTimeout(300);
    const tops = await page.evaluate(
      () => (window as unknown as { __tileTops: number[] }).__tileTops,
    );
    expect(tops.length).toBeGreaterThan(0);
    for (const top of tops) expect(top).toBeLessThan(300);
  });
});
