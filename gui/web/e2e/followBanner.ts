import type { Page } from "@playwright/test";

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
