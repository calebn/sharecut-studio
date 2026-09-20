import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

test.describe("control state parity", () => {
  test("transcript Focus and Follow both use ui-control and matching hover", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    const panels = page.getByLabel("Editor panels");
    await panels
      .getByRole("button", { name: "Transcript", exact: true })
      .click();

    const focus = panels.getByRole("button", { name: /^Focus$|^Focused$/ });
    let follow = panels.getByRole("button", { name: /^Follow$|^Unlocked$/ });
    await expect(focus).toBeVisible();
    await expect(follow).toBeVisible();

    expect(
      await focus.evaluate((el) => el.classList.contains("ui-control")),
    ).toBe(true);
    expect(
      await follow.evaluate((el) => el.classList.contains("ui-control")),
    ).toBe(true);

    // Prefer unpressed Follow so hover border is not already accent.
    if ((await follow.getAttribute("aria-pressed")) === "true") {
      await follow.click();
      follow = panels.getByRole("button", { name: "Unlocked" });
    }
    if ((await focus.getAttribute("aria-pressed")) === "true") {
      await focus.click();
    }

    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(follow).toHaveAttribute("aria-pressed", "false");

    // Clear sticky :hover from the unlock click before measuring rest.
    await page.getByRole("heading", { level: 1 }).hover();

    const borderTop = (locator: typeof focus) =>
      locator.evaluate((el) => getComputedStyle(el).borderTopColor);

    const focusRest = await borderTop(focus);
    const followRest = await borderTop(follow);
    expect(followRest).toBe(focusRest);

    await focus.hover();
    const focusHover = await borderTop(focus);
    await page.getByRole("heading", { level: 1 }).hover();
    await follow.hover();
    const followHover = await borderTop(follow);

    expect(focusHover).not.toBe(focusRest);
    expect(followHover).not.toBe(followRest);
    expect(followHover).toBe(focusHover);
  });

  test("active quiet tab hover keeps underline-only border", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    const panels = page.getByLabel("Editor panels");
    const transcriptTab = panels.getByRole("button", {
      name: "Transcript",
      exact: true,
    });
    await transcriptTab.click();
    await expect(transcriptTab).toHaveAttribute("aria-pressed", "true");
    expect(
      await transcriptTab.evaluate((el) =>
        el.classList.contains("ui-control--quiet"),
      ),
    ).toBe(true);

    const bg = (el: typeof transcriptTab) =>
      el.evaluate((node) => getComputedStyle(node).backgroundColor);

    await page.getByRole("heading", { level: 1 }).hover();
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

  test("pressed Comment and Mix keep fill on hover", async ({ page }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    const paint = (locator: ReturnType<typeof page.getByRole>) =>
      locator.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color };
      });

    const comment = page.getByRole("button", { name: "Comment", exact: true });
    await comment.click();
    await expect(comment).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("heading", { level: 1 }).hover();
    const commentRest = await paint(comment);
    await comment.hover();
    const commentHover = await paint(comment);
    expect(commentHover.bg).toBe(commentRest.bg);
    expect(commentHover.color).toBe(commentRest.color);

    const commentToken = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.background = "var(--comment-marker)";
      document.body.appendChild(el);
      const bg = getComputedStyle(el).backgroundColor;
      el.remove();
      return bg;
    });
    expect(commentRest.bg).toBe(commentToken);

    const mix = page
      .getByRole("group", { name: "Audition mode" })
      .getByRole("button", { name: "Mix", exact: true });
    await expect(mix).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("heading", { level: 1 }).hover();
    const mixRest = await paint(mix);
    await mix.hover();
    const mixHover = await paint(mix);
    expect(mixHover.bg).toBe(mixRest.bg);
    expect(mixHover.color).toBe(mixRest.color);

    const mixToken = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.background = "var(--color-accent-solid)";
      document.body.appendChild(el);
      const bg = getComputedStyle(el).backgroundColor;
      el.remove();
      return bg;
    });
    expect(mixRest.bg).toBe(mixToken);
  });
});
