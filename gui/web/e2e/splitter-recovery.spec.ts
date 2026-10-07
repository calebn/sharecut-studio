import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openHostProject } from "./overlayReachability";
import { openPhoneTimeline } from "./phoneTimeline";
import { setTheme } from "./theme";

for (const width of [1440, 820]) {
  for (const theme of ["light", "dark"] as const) {
    test(`panel resize cancels precisely at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1024 });
      await page.emulateMedia({
        reducedMotion: theme === "dark" ? "reduce" : "no-preference",
      });
      await openHostProject(page);
      const separator = page.getByRole("separator", {
        name: "Resize editor panels",
      });
      await expect(separator).toBeVisible();
      await expect(separator).toHaveAttribute(
        "title",
        "Drag or arrows to resize · Shift for larger steps · Escape cancels · Enter or double-click resets",
      );
      await setTheme(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const trackDetails = page.locator(".track-header-open").first();
      await trackDetails.focus();
      await trackDetails.press("Enter");
      await expect(trackDetails).toHaveAttribute("aria-expanded", "true");
      await separator.focus();
      await separator.press("Enter");
      const commands: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/document/command")
          commands.push(request.postData() ?? "");
      });
      const position = page.getByRole("slider", { name: "Timeline position" });
      const playhead = await position.getAttribute("aria-valuenow");
      const trackOrder = () =>
        page.locator(".track-title-text").allTextContents();
      const originalOrder = await trackOrder();
      const snapshot = () =>
        separator.evaluate((element) => ({
          height: element.parentElement!.getBoundingClientRect().height,
          preference: localStorage.getItem("sharecut.tabsHeight"),
        }));
      const origin = await snapshot();
      const rootFontSize = await page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
      await expect
        .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
        .toBe(Math.round((origin.height / rootFontSize) * 10) / 10);
      const savedProject = fs.readFileSync(e2eProjectPath, "utf8");
      const bounds = (await separator.boundingBox())!;
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 64, { steps: 4 });
      await expect
        .poll(async () => (await snapshot()).height)
        .toBeCloseTo(origin.height + 64, 0);
      for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "Enter"])
        await page.keyboard.press(key);
      await expect(position).toHaveAttribute("aria-valuenow", playhead!);
      expect(await trackOrder()).toEqual(originalOrder);
      expect(commands).toEqual([]);
      await page.mouse.move(x, y - 32, { steps: 2 });
      await expect
        .poll(async () => (await snapshot()).height)
        .toBeCloseTo(origin.height + 32, 0);
      await page.keyboard.press("Escape");
      await expect.poll(snapshot).toEqual(origin);
      await expect(separator).toBeFocused();
      await page.mouse.move(x, y - 96);
      await page.mouse.up();
      await expect.poll(snapshot).toEqual(origin);
      await separator.press("ArrowUp");
      const stored = await snapshot();
      const next = (await separator.boundingBox())!;
      await page.mouse.move(x, next.y + next.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, next.y - 80);
      const owner = await separator.evaluate((element) => {
        for (let id = 1; id < 10; id++)
          if (element.hasPointerCapture(id)) return id;
        return null;
      });
      expect(owner).not.toBeNull();
      await separator.evaluate(
        (element, id) => element.releasePointerCapture(id!),
        owner,
      );
      await page.mouse.move(x, next.y - 96);
      await expect.poll(snapshot).toEqual(stored);
      await page.mouse.up();
      await separator.press("Enter");
      const reset = await snapshot();
      const last = (await separator.boundingBox())!;
      const start = last.y + last.height / 2;
      await page.mouse.move(x, start);
      await page.mouse.down();
      await page.mouse.move(x, -1000);
      await expect
        .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
        .toBeCloseTo(Number(await separator.getAttribute("aria-valuemax")), 0);
      await page.mouse.move(x, start);
      await page.mouse.up();
      await expect.poll(snapshot).toEqual(reset);
      expect(commands).toEqual([]);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(fs.readFileSync(e2eProjectPath, "utf8")).toBe(savedProject);
      await page.screenshot({
        path: test.info().outputPath("splitter-restored.png"),
      });
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`phone panel sizing uses Expand and Collapse in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({
      reducedMotion: theme === "dark" ? "reduce" : "no-preference",
    });
    await openHostProject(page);
    await openPhoneTimeline(page);
    await setTheme(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(
      page.getByRole("separator", { name: "Resize editor panels" }),
    ).toHaveCount(0);
    // A track opens the plain sheet; a clip opens the compact drawer.
    await page.locator(".track-header-open").first().click();
    const sheet = page.locator(".bottom-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(sheet).toHaveClass(/bottom-sheet--full/);
    await sheet.getByRole("button", { name: "Collapse", exact: true }).click();
    await expect(sheet).toHaveClass(/bottom-sheet--half/);
    expect(
      await page.evaluate(() => localStorage.getItem("sharecut.tabsHeight")),
    ).toBeNull();
  });
}
