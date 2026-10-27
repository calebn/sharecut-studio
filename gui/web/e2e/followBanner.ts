import {
  type Browser,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { clickHTMLElement } from "./domClick";
import { e2eProjectPath } from "./env";
import { openHostShare } from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

const FOLLOW_BANNER_TRANSITION_TIMEOUT_MS = 1_000;

/** Wait for React to render the banner after a synchronous follow command. */
export async function waitForFollowBanner(follower: Page): Promise<boolean> {
  try {
    await follower.locator(".follow-banner").waitFor({
      state: "visible",
      timeout: FOLLOW_BANNER_TRANSITION_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return false;
    }
    throw error;
  }
}

export async function withTwoHostPages<T>(
  browser: Browser,
  viewport: { width: number; height: number },
  run: (pageA: Page, pageB: Page) => Promise<T>,
): Promise<T> {
  const projectPath = e2eProjectPath;
  return withTwoBrowserPages(
    browser,
    { viewport },
    { viewport },
    async (pageA, pageB) => {
      await openHostShare(pageA, projectPath);
      await openHostShare(pageB, projectPath);
      return run(pageA, pageB);
    },
  );
}

/** The header's People button; peers show once their presence arrives. */
export function peopleButton(page: Page) {
  return page.getByRole("button", { name: /^People here/ });
}

/** Open the header's People menu (Follow and Go to) and return it. */
export async function openPeopleMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", { name: "People" });
  if (await menu.isVisible()) return menu;
  const trigger = peopleButton(page);
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Follow each peer in turn until one shows the Following banner. */
export async function followUntilBannerVisible(follower: Page): Promise<void> {
  const rows = () =>
    follower
      .getByRole("menu", { name: "People" })
      .getByRole("menuitem", { name: /· Follow$/ });
  await openPeopleMenu(follower);
  await expect(rows().first()).toBeVisible({ timeout: 15_000 });
  const n = await rows().count();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      await openPeopleMenu(follower);
    }
    await clickHTMLElement(rows().nth(i));
    if (await waitForFollowBanner(follower)) {
      return;
    }
  }
  throw new Error("no Follow peer showed a banner");
}
