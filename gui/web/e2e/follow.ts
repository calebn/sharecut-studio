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

const FOLLOW_PILL_TRANSITION_TIMEOUT_MS = 1_000;

export function followPill(page: Page): Locator {
  return page.locator(".avatar-header .avatar-follow");
}

export function followDetail(page: Page): Locator {
  return page.locator(".sys-player-pill").filter({ hasText: /^Following / });
}

/** Wait for React to render the pill after a synchronous follow command. */
export async function waitForFollowPill(follower: Page): Promise<boolean> {
  try {
    await followPill(follower).waitFor({
      state: "visible",
      timeout: FOLLOW_PILL_TRANSITION_TIMEOUT_MS,
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

export function peopleFaces(page: Page): Locator {
  return page.locator(".avatar-header .avatar-face:visible");
}

export function peopleButton(page: Page): Locator {
  return peopleFaces(page).first();
}

function personMenu(page: Page): Locator {
  return page.getByRole("menu").filter({
    has: page.getByRole("menuitem", { name: /^(Follow|Stop following)$/ }),
  });
}

export async function openPeopleMenu(
  page: Page,
  face: Locator = peopleButton(page),
): Promise<Locator> {
  const menu = personMenu(page);
  if (await menu.isVisible()) return menu;
  await expect(face).toBeVisible({ timeout: 15_000 });
  await face.click();
  await expect(menu).toBeVisible();
  return menu;
}

export type FollowCandidate = () => Promise<Locator>;

export async function followCandidates(page: Page): Promise<FollowCandidate[]> {
  await expect(peopleButton(page)).toBeVisible({ timeout: 15_000 });
  const out: FollowCandidate[] = [];
  const faces = await peopleFaces(page).count();
  for (let i = 0; i < faces; i++) {
    out.push(async () => {
      const menu = await openPeopleMenu(page, peopleFaces(page).nth(i));
      return menu.getByRole("menuitem", { name: "Follow", exact: true });
    });
  }
  const chips = page.locator(".avatar-header .avatar-more:visible");
  const chipCount = await chips.count();
  for (let c = 0; c < chipCount; c++) {
    await chips.nth(c).click();
    const groups = await page
      .getByRole("menu", { name: "More people" })
      .getByRole("group")
      .count();
    await page.keyboard.press("Escape");
    for (let g = 0; g < groups; g++) {
      out.push(async () => {
        await chips.nth(c).click();
        return page
          .getByRole("menu", { name: "More people" })
          .getByRole("group")
          .nth(g)
          .getByRole("menuitem", { name: "Follow", exact: true });
      });
    }
  }
  return out;
}

/** Follow each peer in turn until one shows the Following pill. */
export async function followUntilPillVisible(follower: Page): Promise<void> {
  const candidates = await followCandidates(follower);
  for (const open of candidates) {
    const row = await open();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await clickHTMLElement(row);
    if (await waitForFollowPill(follower)) {
      return;
    }
  }
  throw new Error("no Follow peer showed a pill");
}
