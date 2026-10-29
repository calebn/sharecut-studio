import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";
import { deliverPage, goToStage, openProject } from "./stageNav";

test.use({
  hasTouch: true,
  isMobile: true,
  permissions: ["clipboard-read", "clipboard-write"],
});

function share(page: Page): Locator {
  return deliverPage(page).getByRole("region", { name: "Share" });
}

async function openShare(page: Page, projectPath: string): Promise<Locator> {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, projectPath);
  await goToStage(page, "deliver");
  const section = share(page);
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  await expect(section.getByText("Looking for your links…")).toBeHidden();
  return section;
}

/** The box is inside the 390 px width, scrolled into view first. */
async function expectWithinWidth(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 0.5);
}

function expectTouchHeight(height: number, layoutHeight: number): void {
  expect(layoutHeight).toBeGreaterThanOrEqual(44);
  // Translated DOM rectangles can report 43.999996px for a 44px layout box.
  expect(height).toBeGreaterThanOrEqual(44 - 0.001);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
}

test("phone 390x844: Share follows Episode file in the one column, with 44 px controls", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await createReviewShare(page, projectPath, "editor");
    const section = await openShare(page, projectPath);
    const titles = await deliverPage(page)
      .getByRole("heading", { level: 2 })
      .allTextContents();
    expect(titles.indexOf("Share")).toBeGreaterThan(
      titles.indexOf("Episode file"),
    );

    const controls = section.locator(
      ".ui-segmented button, .dv-chips button, .dv-primary button, .dv-share-actions button, .sys-link button",
    );
    const sizes = await controls.evaluateAll((els) =>
      els.map((el) => ({
        height: el.getBoundingClientRect().height,
        layoutHeight: el instanceof HTMLElement ? el.offsetHeight : 0,
      })),
    );
    // Three roles, MCP and Freeze, Create review link, Create record links,
    // and one row's Copy and Stop sharing.
    expect(sizes.length).toBeGreaterThanOrEqual(9);
    for (const size of sizes) expectTouchHeight(size.height, size.layoutHeight);

    await expectNoHorizontalScroll(page);
    await expectPageAxeClean(page, ".dv-stage");
  });
});

test("phone 390x844: Create makes the link, a row's Copy and Stop sharing fit, and the confirm fits", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    const section = await openShare(page, projectPath);
    await section.getByRole("button", { name: "Editor" }).click();
    await section
      .getByRole("button", { name: "Allow AI assistants (MCP)" })
      .click();
    await section.getByRole("button", { name: "Create review link" }).click();
    await expect(
      section.getByRole("button", { name: "Copied Editor link" }),
    ).toBeVisible();
    for (const name of ["Copied Editor link", "Copy MCP URL", "Stop sharing"]) {
      await expectWithinWidth(section.getByRole("button", { name }));
    }
    await expectWithinWidth(section.getByText(/AI assistants allowed/));

    await section.getByRole("button", { name: "Stop sharing" }).click();
    const confirm = section.getByRole("group", {
      name: "Stop sharing this Editor link? Anyone using it loses access.",
    });
    await expectWithinWidth(confirm);
    for (const name of ["Keep link", "Stop sharing"]) {
      const button = confirm.getByRole("button", { name });
      await expectWithinWidth(button);
      const size = await button.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        layoutHeight: el instanceof HTMLElement ? el.offsetHeight : 0,
      }));
      expectTouchHeight(size.height, size.layoutHeight);
    }
    await expectNoHorizontalScroll(page);
    await expectPageAxeClean(page, ".dv-stage");
    await confirm.getByRole("button", { name: "Stop sharing" }).click();
    await expect(section.getByText("No review links yet.")).toBeVisible();
  });
});

test("phone 390x844: a stale mix shows its notice and Refresh mix inside the width", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    const section = await openShare(page, projectPath);
    let refuse = true;
    await page.route("**/api/shares", async (route) => {
      if (route.request().method() === "POST" && refuse) {
        await route.fulfill({
          status: 409,
          headers: { "X-Sharecut-Error-Code": "stale_mix" },
          json: { detail: "premix.wav is stale" },
        });
        return;
      }
      await route.fallback();
    });
    await section.getByRole("button", { name: "Create review link" }).click();
    const notice = section.getByRole("alert");
    await expectWithinWidth(notice);
    const refresh = section.getByRole("button", { name: "Refresh mix" });
    await expectWithinWidth(refresh);
    const size = await refresh.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      layoutHeight: el instanceof HTMLElement ? el.offsetHeight : 0,
    }));
    expectTouchHeight(size.height, size.layoutHeight);
    refuse = false;
    await refresh.click();
    await expect(
      section.getByRole("button", { name: /Commenter link$/ }),
    ).toBeVisible({ timeout: 60_000 });
  });
});

test("phone 390x844: every online sharing state fits the width", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await createReviewShare(page, projectPath, "viewer");
    let state = "offline";
    await page.route("**/api/tunnel/status", (route) =>
      route.fulfill({
        json: {
          state,
          reason: null,
          reason_kind: "auth",
          relay_host: "relay.example.test",
          public_base_url: "https://share.example.test",
          share_count: 1,
          retry_at: state === "reconnecting" ? Date.now() / 1000 + 30 : null,
        },
      }),
    );
    const section = await openShare(page, projectPath);
    const headline = section.locator(".share-tunnel-headline");
    await expect(headline).toContainText("Not reachable online");
    await expectWithinWidth(headline);
    await section.getByText("How to fix").click();
    await expectWithinWidth(
      section.getByRole("link", { name: /Online sharing guide/ }),
    );
    for (const [next, text] of [
      ["reconnecting", /^Reconnecting…/],
      ["off", "Online sharing is off"],
      ["online", "Guests can open your links"],
    ] as const) {
      state = next;
      await expect(headline).toContainText(text, { timeout: 15_000 });
      await expectWithinWidth(headline);
    }
    await expectNoHorizontalScroll(page);
  });
});
