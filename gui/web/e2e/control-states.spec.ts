import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openPanel, openProject } from "./stageNav";

test.describe("control state parity", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("transcript Annotate is quiet while Follow keeps an outline, with shared hover", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    await openPanel(page, "transcript");

    const annotate = page.locator(".transcript-annotate-btn");
    let follow = page.getByRole("button", { name: /^Follow$|^Unlocked$/ });
    await expect(annotate).toBeVisible();
    await expect(follow).toBeVisible();

    expect(
      await annotate.evaluate((el) => el.classList.contains("ui-control")),
    ).toBe(true);
    expect(
      await follow.evaluate((el) => el.classList.contains("ui-control")),
    ).toBe(true);

    // Prefer unpressed Follow so hover border is not already accent.
    if ((await follow.getAttribute("aria-pressed")) === "true") {
      await follow.click();
      follow = page.getByRole("button", { name: "Unlocked" });
    }
    if ((await annotate.getAttribute("aria-pressed")) === "true") {
      await annotate.click();
    }

    await expect(annotate).toHaveAttribute("aria-pressed", "false");
    await expect(follow).toHaveAttribute("aria-pressed", "false");

    // Clear sticky :hover from the unlock click before measuring rest.
    await page.mouse.move(0, 0);

    const borderTop = (locator: typeof annotate) =>
      locator.evaluate((el) => getComputedStyle(el).borderTopColor);

    const annotateRest = await borderTop(annotate);
    const followRest = await borderTop(follow);
    expect(followRest).not.toBe(annotateRest);
    expect(annotateRest).toBe("rgba(0, 0, 0, 0)");

    await annotate.hover();
    const annotateHover = await borderTop(annotate);
    await page.mouse.move(0, 0);
    await follow.hover();
    const followHover = await borderTop(follow);

    expect(annotateHover).not.toBe(annotateRest);
    expect(followHover).not.toBe(followRest);
    expect(followHover).toBe(annotateHover);

    await annotate.click();
    await expect(annotate).toHaveAttribute("aria-pressed", "true");
    const annotatedPaint = await annotate.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
      };
    });
    expect(annotatedPaint.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(annotatedPaint.border).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("active quiet section tab hover keeps underline-only border", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    await openPanel(page, "comments");
    const transcriptTab = page
      .getByRole("tablist", { name: "Review sections" })
      .getByRole("tab", { name: /^Comments\b/ });
    await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
    expect(
      await transcriptTab.evaluate((el) =>
        el.classList.contains("ui-control--quiet"),
      ),
    ).toBe(true);

    const bg = (el: typeof transcriptTab) =>
      el.evaluate((node) => getComputedStyle(node).backgroundColor);

    await page.mouse.move(0, 0);
    const restBg = await bg(transcriptTab);

    await transcriptTab.hover();
    const hoverBg = await bg(transcriptTab);
    const borders = await transcriptTab.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        top: cs.borderTopColor,
        right: cs.borderRightColor,
        bottom: cs.borderBottomColor,
        left: cs.borderLeftColor,
      };
    });

    expect(hoverBg).not.toBe(restBg);

    // Sides stay transparent; bottom keeps the accent underline.
    expect(borders.top).toBe("rgba(0, 0, 0, 0)");
    expect(borders.right).toBe("rgba(0, 0, 0, 0)");
    expect(borders.left).toBe("rgba(0, 0, 0, 0)");
    expect(borders.bottom).not.toBe("rgba(0, 0, 0, 0)");
    expect(borders.bottom).not.toBe(borders.top);
  });

  test("the pressed mix side keeps its fill on hover", async ({ page }) => {
    await openProject(page, e2eProjectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    const paint = (locator: ReturnType<typeof page.getByRole>) =>
      locator.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor,
          image: cs.backgroundImage,
          color: cs.color,
        };
      });

    const mix = page
      .getByRole("group", { name: "Audition" })
      .getByRole("button", { name: "B", exact: true });
    await expect(mix).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(0, 0);
    const mixRest = await paint(mix);
    await mix.hover();
    const mixHover = await paint(mix);
    expect(mixHover.bg).toBe(mixRest.bg);
    expect(mixHover.image).toBe(mixRest.image);
    expect(mixHover.color).toBe(mixRest.color);

    expect(mixRest.image).toBe("none");
  });
});
