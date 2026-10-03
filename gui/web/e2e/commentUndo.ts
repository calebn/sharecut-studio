import fs from "node:fs";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import { setTheme, type Theme } from "./theme";

async function expectReachableToast(panel: Locator): Promise<void> {
  await expect(async () => {
    const geometry = await panel.evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const visible = {
        left: Math.max(0, panel.left + element.clientLeft),
        top: Math.max(0, panel.top + element.clientTop),
        right: Math.min(
          innerWidth,
          panel.left + element.clientLeft + element.clientWidth,
        ),
        bottom: Math.min(
          innerHeight,
          panel.top + element.clientTop + element.clientHeight,
        ),
      };
      return [
        ...element.querySelectorAll(".undo-toast, .undo-toast button"),
      ].map((control) => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          name: control.textContent,
          fits:
            rect.left >= visible.left - 1 &&
            rect.right <= visible.right + 1 &&
            rect.top >= visible.top - 1 &&
            rect.bottom <= visible.bottom + 1,
          reachable: hit !== null && control.contains(hit),
        };
      });
    });
    expect(geometry).toHaveLength(3);
    for (const control of geometry) {
      expect(control.fits, JSON.stringify(control)).toBe(true);
      expect(control.reachable, JSON.stringify(control)).toBe(true);
    }
  }).toPass();
}

export async function exerciseCommentUndo(
  page: Page,
  theme: Theme,
  info: TestInfo,
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    for (let index = 0; index < 20; index += 1) {
      await postDocumentCommand(
        page,
        `undo-row-${index}`,
        "AddComment",
        {
          body: `Undo regression row ${index}`,
          author: "Host reviewer",
          timeline_start: index,
          timeline_end: null,
          track_ids: [],
          action_texts: [],
        },
        projectPath,
      );
    }
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    const phone = (page.viewportSize()?.width ?? 0) < 720;
    await expect(
      page.locator(`.daw-shell--${phone ? "phone" : "desktop"}`),
    ).toBeVisible();
    if (phone) {
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More", exact: true })
        .click();
      await page
        .locator(".mobile-more-list")
        .getByRole("button", { name: "Comments", exact: true })
        .click();
    } else {
      await page
        .getByLabel("Editor panels")
        .getByRole("button", { name: "Comments", exact: true })
        .click();
    }
    const panel = page.locator(".comments-panel");
    await expect(panel).toBeVisible();
    await setTheme(page, theme);
    const card = panel
      .locator(".comment-card")
      .filter({ hasText: "Undo regression row 0" });
    const toast = panel.locator(".undo-toast");
    const undo = toast.getByRole("button", { name: "Undo", exact: true });
    const savedResolved = () => {
      const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
      return project.review.comments.find(
        (comment: { body: string }) => comment.body === "Undo regression row 0",
      ).resolved;
    };

    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(toast).toContainText("Resolved comment at");
    await expect(undo).toBeEnabled();
    await undo.focus();
    await expect(undo).toBeFocused();
    await expectReachableToast(panel);
    await expect.poll(savedResolved).toBe(true);
    await page.keyboard.press("Enter");
    await expect(toast).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: "Resolve", exact: true }),
    ).toBeVisible();
    await expect(panel).toBeFocused();
    await expect(
      page
        .locator('.daw-shell .sr-only[role="status"]')
        .filter({ hasText: "Comment reopened" }),
    ).toHaveText("Comment reopened");
    await expect.poll(savedResolved).toBe(false);

    await panel.getByRole("button", { name: "All", exact: true }).click();
    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(undo).toBeEnabled();
    await undo.focus();
    await expect(undo).toBeFocused();
    const ancestors = await panel.evaluateHandle((element) => {
      const elements: Element[] = [];
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      )
        elements.push(current);
      return elements;
    });
    const observe = () =>
      ancestors.evaluate((elements) => ({
        offsets: elements.map((element) => ({
          top: element.scrollTop,
          left: element.scrollLeft,
        })),
        windowX: window.scrollX,
        windowY: window.scrollY,
      }));
    const range = await panel.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    expect(range).toBeGreaterThan(800);
    const observations = [];
    for (const fraction of [0.3, 0.65]) {
      const offset = Math.floor(range * fraction);
      await panel.evaluate((element, offset) => {
        element.scrollTop = offset;
      }, offset);
      await expect
        .poll(() => panel.evaluate((element) => element.scrollTop))
        .toBe(offset);
      await expectReachableToast(panel);
      observations.push(await observe());
    }
    expect(
      observations[1].offsets[0].top - observations[0].offsets[0].top,
    ).toBeGreaterThan(200);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        ),
      )
      .toBe(theme);
    await expectPageAxeClean(page, ".comments-panel");
    await page.screenshot({
      path: info.outputPath("comment-undo.png"),
      fullPage: true,
    });
    await toast.getByRole("button", { name: "Dismiss", exact: true }).focus();
    const beforeDismiss = await observe();
    await page.keyboard.press("Enter");
    await expect(toast).toHaveCount(0);
    await expect(panel).toBeFocused();
    const afterDismiss = await observe();
    expect(afterDismiss.offsets).toHaveLength(beforeDismiss.offsets.length);
    for (let index = 0; index < beforeDismiss.offsets.length; index += 1) {
      expect(
        Math.abs(
          afterDismiss.offsets[index].top - beforeDismiss.offsets[index].top,
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          afterDismiss.offsets[index].left - beforeDismiss.offsets[index].left,
        ),
      ).toBeLessThanOrEqual(1);
    }
    expect(afterDismiss.windowX).toBe(beforeDismiss.windowX);
    expect(afterDismiss.windowY).toBe(beforeDismiss.windowY);
    const scrollPath = info.outputPath("scroll-observations.json");
    fs.writeFileSync(
      scrollPath,
      `${JSON.stringify({ observations, beforeDismiss, afterDismiss })}\n`,
    );
    await info.attach("scroll-observations", {
      path: scrollPath,
      contentType: "application/json",
    });
    await ancestors.dispose();

    await card.getByRole("button", { name: /^Reopen/ }).click();
    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(undo).toBeEnabled();
    await undo.focus();
    await expect(undo).toBeFocused();
    let release!: () => void;
    let arrived = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/document/command?**", async (route) => {
      const command = route.request().postDataJSON();
      if (
        command.type === "ResolveComment" &&
        command.payload.resolved === false
      ) {
        arrived = true;
        await pending;
      }
      await route.continue();
    });
    try {
      await page.keyboard.press("Enter");
      await expect.poll(() => arrived).toBe(true);
      await expect(undo).toBeDisabled();
    } finally {
      release();
    }
    await expect(toast).toHaveCount(0);
    await expect(panel).toBeFocused();
    await expect(
      card.getByRole("button", { name: "Resolve", exact: true }),
    ).toBeVisible();
    await expect.poll(savedResolved).toBe(false);
    await expect(
      page
        .locator('.daw-shell .sr-only[role="status"]')
        .filter({ hasText: "Comment reopened" }),
    ).toHaveText("Comment reopened");
    await page.unrouteAll({ behavior: "wait" });
  });
}
