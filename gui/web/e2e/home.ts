import { expect, type Page } from "@playwright/test";

/**
 * Specs that start at Home go through these helpers, so a change to Home's
 * chrome is one edit here. Home is `/?home=1` (it never unpins a project).
 */

/** The tab flag that keeps the first-run Setup card away ("Not now" lasts for the tab). */
export const SETUP_DISMISSED_KEY = "sharecut.setup.notNow";

/** Dismiss the Setup card before the page loads, so Home shows only episodes and tiles. */
export async function dismissSetupCard(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    window.sessionStorage.setItem(key, "1");
  }, SETUP_DISMISSED_KEY);
}

export async function openHome(
  page: Page,
  options: { dismissSetup?: boolean } = {},
): Promise<void> {
  if (options.dismissSetup ?? true) await dismissSetupCard(page);
  await page.goto("/?home=1");
  await expectHome(page);
}

/** Home is showing: the ShareCut heading over the Import audio and Record tiles. */
export async function expectHome(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { level: 1, name: "ShareCut" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Import audio/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Record/ })).toBeVisible();
}

export async function chooseHomeMenuItem(
  page: Page,
  name: string,
): Promise<void> {
  await page.getByRole("button", { name: "ShareCut", exact: true }).click();
  await page.getByRole("menuitem", { name }).click();
}

/**
 * Start a new empty episode from Home's Record tile in `workspaceDir`, named
 * `name`. The tile asks the server for its default folder; the route here swaps in
 * the spec's disposable one so nothing lands in the person's own ShareCut folder.
 */
export async function createEpisodeFromHome(
  page: Page,
  options: { name: string; workspaceDir: string },
): Promise<void> {
  await page.route("**/api/project/create", (route) =>
    route.continue({
      postData: JSON.stringify({
        workspace_dir: options.workspaceDir,
        name: options.name,
      }),
    }),
  );
  await page.getByRole("button", { name: /^Record/ }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("project"))
    .not.toBeNull();
}
