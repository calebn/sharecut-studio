import { expect, type Page } from "@playwright/test";

/**
 * One app announcement: the shell's single polite live region speaks it, and
 * the app toast (no live role of its own) shows it. Plain `getByText` matches
 * both, so assert each where it lives.
 */
export async function expectFeedback(
  page: Page,
  message: string | RegExp,
  options: { superseded?: boolean } = {},
): Promise<void> {
  // The region holds one message: a Needs attention announcement that lands
  // right after replaces it, so `superseded` leaves the toast as the proof.
  if (!options.superseded)
    await expect(
      page.getByRole("status").filter({ hasText: message }),
    ).toHaveCount(1);
  await expect(
    page.locator(".ui-toast-region--app .ui-toast-message").filter({
      hasText: message,
    }),
  ).toBeVisible();
}
