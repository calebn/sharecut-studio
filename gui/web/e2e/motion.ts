import type { Locator } from "@playwright/test";

/**
 * Resolve once the element's running animations finish, e.g. a menu's
 * drop-in: geometry measured mid-translate carries float noise.
 */
export async function settleAnimations(locator: Locator): Promise<void> {
  await locator.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
}
