import { expect, type Page, type Request, test } from "@playwright/test";
import { assertDisposableE2eProject, e2eProjectPath } from "../e2e/env";

const STATE_LOAD_TIMEOUT_MS = 30_000;

async function proveHungLoadRecovers(page: Page): Promise<void> {
  test.setTimeout(120_000);
  assertDisposableE2eProject(e2eProjectPath);
  const stateRequests: Request[] = [];
  let answering = false;
  await page.route("**/api/document/state*", async (route) => {
    stateRequests.push(route.request());
    if (answering) await route.continue();
  });
  await page.clock.install();
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect.poll(() => stateRequests.length).toBeGreaterThan(0);
  await page.clock.runFor(STATE_LOAD_TIMEOUT_MS + 1_000);

  const banner = page.getByRole("alert");
  await expect(banner).toContainText(
    "Could not load transcript and history. The server didn't answer.",
  );
  const attempts = stateRequests.length;

  answering = true;
  await banner.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => stateRequests.length).toBe(attempts + 1);
  await expect(banner).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
}

test("a document state load the server never answers shows a banner whose retry recovers", async ({
  page,
}) => {
  await proveHungLoadRecovers(page);
});

test.describe("on a touch phone", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 393, height: 852 },
  });

  test("the banner sits in view, not under the fixed shell, and its retry recovers", async ({
    page,
  }) => {
    await proveHungLoadRecovers(page);
  });
});
