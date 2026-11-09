import { expect, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withAppearance } from "./theme";
import { withBrowserPages } from "./twoBrowserPages";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

for (const { cell: viewport, theme, reducedMotion } of withAppearance(
  VIEWPORTS,
)) {
  test(`an editor guest can see and dismiss the first-visit role hint at ${viewport.width}x${viewport.height}`, async ({
    browser,
  }, testInfo) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          {
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: theme,
            reducedMotion: reducedMotion ? "reduce" : "no-preference",
            hasTouch: viewport.width < 900,
            isMobile: viewport.width < 900,
          },
        ],
        async ([host, guest]) => {
          await openHostShare(host!, projectPath);
          const token = await createReviewShare(host!, projectPath, "editor");
          await openGuestShare(guest!, token);

          const hint = guest!.getByRole("note");
          const trigger = guest!.getByRole("button", {
            name: "Explain Editor role",
          });
          const close = hint.getByRole("button", { name: "Dismiss hint" });
          await expect(trigger).toBeVisible();
          await expect(hint).toBeVisible();
          await expect(guest!.locator(".clip-block").first()).toBeVisible();
          await expect(
            guest!.locator(".sys-markers-track").first(),
          ).toBeVisible();

          const hitEvidence = await hint.evaluate((note) => {
            const text = note.querySelector<HTMLElement>(":scope > span");
            const closeButton = note.querySelector<HTMLElement>(
              'button[aria-label="Dismiss hint"]',
            );
            if (!text || !closeButton) {
              throw new Error("role hint text or dismiss button is missing");
            }
            const textRect = text.getBoundingClientRect();
            const closeRect = closeButton.getBoundingClientRect();
            const points = [0.15, 0.5, 0.85].map((fraction) => ({
              name: `text-${fraction}`,
              x: textRect.left + textRect.width * fraction,
              y: textRect.top + textRect.height / 2,
            }));
            points.push({
              name: "dismiss-center",
              x: closeRect.left + closeRect.width / 2,
              y: closeRect.top + closeRect.height / 2,
            });
            return points.map(({ name, x, y }) => {
              const hit = document.elementFromPoint(x, y);
              return {
                name,
                x,
                y,
                hit: hit
                  ? {
                      tag: hit.tagName,
                      className:
                        typeof hit.className === "string" ? hit.className : "",
                      ariaLabel: hit.getAttribute("aria-label"),
                      withinHint: note.contains(hit),
                    }
                  : null,
              };
            });
          });
          const screenshotPath = testInfo.outputPath(
            `editor-role-hint-${viewport.name}.png`,
          );
          await guest!.screenshot({
            path: screenshotPath,
            animations: "disabled",
          });
          await testInfo.attach(`editor-role-hint-${viewport.name}.png`, {
            path: screenshotPath,
            contentType: "image/png",
          });
          testInfo.annotations.push({
            type: "role-hint-hit-targets",
            description: JSON.stringify(hitEvidence),
          });
          expect(
            hitEvidence.map((point) => point.hit?.withinHint ?? false),
            JSON.stringify(hitEvidence, null, 2),
          ).toEqual([true, true, true, true]);

          await close.click();
          await expect(hint).toHaveCount(0);
          await expect(trigger).toBeFocused();
          await trigger.click();
          const explanation = guest!.getByRole("dialog", {
            name: "Editor role",
          });
          await expect(explanation).toBeVisible();
          await expect(explanation).toContainText(
            "You can edit and comment. The host decides what ships.",
          );
          await guest!.keyboard.press("Escape");
          await expect(explanation).toHaveCount(0);

          await trigger.click();
          await expect(explanation).toBeVisible();
          await guest!.locator(".stage-frame--guest").click({
            position: { x: 12, y: 12 },
          });
          await expect(explanation).toHaveCount(0);
        },
      );
    });
  });
}
