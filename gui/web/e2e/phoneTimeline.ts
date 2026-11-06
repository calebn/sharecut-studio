import { expect, type Page } from "@playwright/test";
import { phone } from "./stageNav";

/** Switch the phone shell to Timeline and wait for the loaded arrange view. */
export async function openPhoneTimeline(page: Page): Promise<void> {
  await phone.showTimeline(page);
  // While the project loads, the skeleton draws busy header rows (no chips)
  // in the same place; wait for the loaded ones.
  await expect(
    page.locator('.timeline-scroll .track-headers:not([aria-busy="true"])'),
  ).toBeVisible();
}

/**
 * Raises each phone Inspector sheet this page opens to `detent`, as a person
 * would with the grip's End key: the sheet opens at half, so `half` changes
 * nothing, and `full` presses End once on every new sheet.
 */
export async function rememberInspectorDetent(
  page: Page,
  detent: "half" | "full",
): Promise<void> {
  if (detent === "half") return;
  await page.addInitScript(() => {
    const raise = (grip: Element) => {
      if (grip.hasAttribute("data-e2e-raised")) return;
      grip.setAttribute("data-e2e-raised", "");
      grip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    };
    new MutationObserver(() => {
      for (const grip of document.querySelectorAll(
        '.sys-inspector--phone [role="slider"]',
      ))
        raise(grip);
    }).observe(document, { childList: true, subtree: true });
  });
}
