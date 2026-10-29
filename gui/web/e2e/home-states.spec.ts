import { expect, type Page, test } from "@playwright/test";
import { openHome } from "./home";
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
    await page.getByRole("button", { name: /^Record/ }).focus();
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
    const row = ["Help", "More", "Record"].map((name) =>
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
    for (const name of ["Help", "More", "Record"]) {
      const box = (await page
        .getByRole("button", { name, exact: name !== "Record" })
        .first()
        .boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(360);
    }
  });
});
