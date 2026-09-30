import { expect, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import { withBrowserPages } from "./twoBrowserPages";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 320]) {
    test(`guest review supports comments and replies at ${width} in ${theme}`, async ({
      browser,
    }) => {
      await withShareableProject(async (projectPath) => {
        await withBrowserPages(
          browser,
          [
            {},
            {
              viewport: { width, height: 900 },
              colorScheme: theme,
              reducedMotion: "reduce",
            },
          ],
          async ([host, guest]) => {
            await host.goto(`/?project=${encodeURIComponent(projectPath)}`);
            const created = await host.request.post("/api/shares", {
              data: { path: projectPath, role: "commenter" },
            });
            expect(created.ok(), await created.text()).toBeTruthy();
            const { share } = (await created.json()) as {
              share: { token: string };
            };
            await guest.goto(`/r/${share.token}`);
            await expect(guest.locator(".review-shell")).toBeVisible();
            await expect(guest.locator(".daw-shell")).toHaveCount(0);
            await expect(guest.locator("audio")).toBeVisible();
            await expect
              .poll(() =>
                guest
                  .locator("audio")
                  .evaluate((audio: HTMLAudioElement) => audio.readyState),
              )
              .toBeGreaterThan(0);
            if (width === 320) {
              await guest
                .getByLabel("Your name", { exact: true })
                .evaluate((input: HTMLInputElement) => {
                  input.size = 40;
                });
              await guest
                .getByLabel("Comment", { exact: true })
                .evaluate((textarea: HTMLTextAreaElement) => {
                  textarea.cols = 40;
                });
            }
            await guest
              .getByLabel("Your name", { exact: true })
              .fill("Guest reviewer");
            const body = `Review feedback at ${width} in ${theme}`;
            await guest.getByLabel("Comment", { exact: true }).fill(body);
            await guest
              .getByRole("button", { name: "Post comment", exact: true })
              .click();
            const comment = guest
              .locator(".comments-list > li")
              .filter({ hasText: body });
            await expect(comment).toBeVisible();
            await comment.getByPlaceholder("Reply…").fill("This is the reply.");
            await comment
              .getByRole("button", { name: "Reply", exact: true })
              .click();
            await expect(
              comment.getByText("This is the reply.", { exact: true }),
            ).toBeVisible();
            await guest
              .getByRole("checkbox", { name: "Open comments only" })
              .check();
            await expect(comment).toBeVisible();
            await expect
              .poll(() =>
                guest.evaluate(() => document.documentElement.scrollWidth),
              )
              .toBeLessThanOrEqual(width);
            const readingBounds = await guest
              .locator(".cover-center")
              .evaluate((element) => {
                const { left, right } = element.getBoundingClientRect();
                return { left, right };
              });
            expect(readingBounds.left).toBeGreaterThanOrEqual(0);
            expect(readingBounds.right).toBeLessThanOrEqual(width);
            await expectReadingSurfaceAxeClean(guest);
            await guest.screenshot({
              path: test.info().outputPath("review.png"),
              fullPage: true,
            });
          },
        );
      });
    });
  }
}
