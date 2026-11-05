import {
  expect,
  type Page,
  type Request,
  type Route,
  test,
} from "@playwright/test";
import { assertDisposableE2eProject, e2eProjectPath } from "../e2e/env";
import { openProject } from "../e2e/stageNav";

const STATE_LOAD_TIMEOUT_MS = 30_000;

const TOUCH_TARGET_PX = 44;

async function proveHungLoadRecovers(
  page: Page,
  options: { touchTarget?: boolean } = {},
): Promise<void> {
  test.setTimeout(120_000);
  assertDisposableE2eProject(e2eProjectPath);
  const stateRequests: Request[] = [];
  let answering = false;
  let held: Route | null = null;
  await page.route("**/api/document/state*", async (route) => {
    stateRequests.push(route.request());
    if (!answering) return;
    // The retry waits here so the busy button can be inspected.
    if (!held) held = route;
    else await route.continue();
  });
  await page.clock.install();
  await openProject(page, e2eProjectPath);
  await expect.poll(() => stateRequests.length).toBeGreaterThan(0);
  await page.clock.runFor(STATE_LOAD_TIMEOUT_MS + 1_000);

  const cover = page.getByRole("alert");
  await expect(cover).toContainText("Could not load the project");
  await expect(cover).toContainText("The server didn't answer.");
  await expect(cover).toBeInViewport();
  const attempts = stateRequests.length;

  const retry = cover.getByRole("button", { name: "Try again" });
  if (options.touchTarget) {
    const box = await retry.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    expect(box?.height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
  }

  answering = true;
  await retry.click();
  await expect.poll(() => stateRequests.length).toBe(attempts + 1);
  // The same button stays, busy and focused, while the retry is in flight.
  await expect(retry).toHaveAttribute("aria-busy", "true");
  await expect(retry).toBeFocused();
  await (held as Route | null)?.continue();
  await expect(cover).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
}

test("a document state load the server never answers shows the project failure cover whose Try again recovers", async ({
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

  test("the failure cover sits in view, not under the fixed shell, and its Try again recovers", async ({
    page,
  }) => {
    await proveHungLoadRecovers(page, { touchTarget: true });
  });
});
