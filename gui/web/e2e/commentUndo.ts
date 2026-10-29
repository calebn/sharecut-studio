import fs from "node:fs";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import { openPanel, openProject } from "./stageNav";
import { setTheme, type Theme } from "./theme";

/** The app toast and both its buttons sit inside the viewport and take the pointer. */
async function expectReachableToast(page: Page): Promise<void> {
  await expect(async () => {
    const geometry = await page.evaluate(() => {
      const controls = [
        ...document.querySelectorAll(
          ".ui-toast-region--app .ui-toast, .ui-toast-region--app .ui-toast button",
        ),
      ];
      return controls.map((control) => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          name: control.textContent,
          fits:
            rect.left >= -1 &&
            rect.right <= innerWidth + 1 &&
            rect.top >= -1 &&
            rect.bottom <= innerHeight + 1,
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
    await openProject(page, projectPath);
    const phone = (page.viewportSize()?.width ?? 0) < 720;
    await expect(
      page.locator(`.stage-frame--${phone ? "phone" : "desktop"}`),
    ).toBeVisible();
    await openPanel(page, "comments");
    const panel = page.locator(".rv-stage");
    await expect(panel).toBeVisible();
    await setTheme(page, theme);
    // A phone keeps the queue in a sheet behind the "n of m" button.
    if (phone) await panel.getByRole("button", { name: / of \d+$/ }).click();
    await page
      .locator('.sys-queue-row[data-kind="comment"]')
      .filter({ hasText: "Undo regression row 0" })
      .getByRole("button")
      .click();
    // The card shows the selected comment; resolving moves it on to the next.
    const card = panel
      .locator("article.sys-decision")
      .filter({ hasText: "Undo regression row 0" });
    const toast = page.locator(".ui-toast-region--app .ui-toast");
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
    await expectReachableToast(page);
    await expect.poll(savedResolved).toBe(true);
    await page.keyboard.press("Enter");
    await expect(toast).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: "Resolve", exact: true }),
    ).toBeVisible();
    await expect(panel).toBeFocused();
    await expect(
      page
        .locator('.stage-frame .sr-only[role="status"]')
        .filter({ hasText: "Comment reopened" }),
    ).toHaveText("Comment reopened");
    await expect.poll(savedResolved).toBe(false);

    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(undo).toBeEnabled();
    await undo.focus();
    await expect(undo).toBeFocused();
    // The queue and card scroll together in the stage body on a desktop and in the host's panel on a phone.
    const scroller = await panel.evaluateHandle((element) => {
      const scrolls = (node: Element) =>
        node.scrollHeight - node.clientHeight > 200 &&
        ["auto", "scroll"].includes(getComputedStyle(node).overflowY);
      let current: Element | null = element.querySelector(".rv-main");
      if (current && scrolls(current)) return current;
      for (current = element; current; current = current.parentElement)
        if (scrolls(current)) return current;
      return element;
    });
    const ancestors = await panel.evaluateHandle((element) => {
      const elements: Element[] = [];
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      )
        elements.push(current);
      return [...elements, ...element.querySelectorAll(".rv-main")];
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
    const range = await scroller.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    // A phone's card is short (the queue is in a sheet), so it has nothing to scroll.
    if (!phone) expect(range).toBeGreaterThan(200);
    const observations: Awaited<ReturnType<typeof observe>>[] = [];
    for (const fraction of range > 200 ? [0.3, 0.65] : []) {
      const offset = Math.floor(range * fraction);
      await scroller.evaluate((element, offset) => {
        element.scrollTop = offset;
      }, offset);
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollTop))
        .toBe(offset);
      await expectReachableToast(page);
      observations.push(await observe());
    }
    if (observations.length === 2)
      expect(
        Math.max(
          ...observations[1].offsets.map(
            (o, i) => o.top - observations[0].offsets[i].top,
          ),
        ),
      ).toBeGreaterThan(100);
    await expectReachableToast(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        ),
      )
      .toBe(theme);
    await expectPageAxeClean(page, ".rv-stage");
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

    if (phone) await panel.getByRole("button", { name: / of \d+$/ }).click();
    const decidedToggle = page
      .getByRole("region", { name: "Decided" })
      .getByRole("button", { name: /Decided/ });
    if ((await decidedToggle.getAttribute("aria-expanded")) !== "true")
      await decidedToggle.click();
    await page
      .locator(".sys-queue-row--decided")
      .filter({ hasText: "Resolved" })
      .first()
      .click();
    await card.getByRole("button", { name: /^Reopen/ }).click();
    await expect(toast).toContainText("Comment reopened");
    await expect.poll(savedResolved).toBe(false);
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
        .locator('.stage-frame .sr-only[role="status"]')
        .filter({ hasText: "Comment reopened" }),
    ).toHaveText("Comment reopened");
    await page.unrouteAll({ behavior: "wait" });
  });
}
