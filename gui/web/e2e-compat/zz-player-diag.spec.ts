import { expect, type Page, test } from "@playwright/test";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { phone } from "../e2e/stageNav";

test.use({ hasTouch: true, actionTimeout: 15_000 });

// Diagnostic only (#2462): dumps the Player's geometry on phone shells so the
// Linux WebKit overlap can be read from the CI log. Never merged.
async function dump(page: Page, width: number, height: number) {
  await withShareableProject(async (projectPath) => {
    await page.setViewportSize({ width, height });
    await openHostShare(page, projectPath);
    await openPhoneTimeline(page);
    await phone.showListen(page);
    await expect(page.getByRole("main", { name: "Review" })).toBeVisible();
    const dump = await page.evaluate(() => {
      const player = document.querySelector(".sys-player");
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return [
          Math.round(r.left * 10) / 10,
          Math.round(r.top * 10) / 10,
          Math.round(r.width * 10) / 10,
          Math.round(r.height * 10) / 10,
        ].join(",");
      };
      if (!player) return "no .sys-player";
      const ps = getComputedStyle(player);
      const rows = [
        `player ${box(player)} display=${ps.display} cols=${ps.gridTemplateColumns} rows=${ps.gridTemplateRows} font=${ps.fontFamily} size=${ps.fontSize}`,
      ];
      for (const el of player.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.display === "none") continue;
        const label =
          el.getAttribute("aria-label") ||
          (el.textContent ?? "").trim().slice(0, 24);
        rows.push(
          `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "").slice(0, 40)} "${label}" ${box(el)} pos=${cs.position} area=${cs.gridArea} z=${cs.zIndex} ov=${cs.overflow} pe=${cs.pointerEvents}`,
        );
      }
      return rows.join("\n");
    });
    expect(dump, `player ${width}`).toBe("");
  });
}

test("player geometry 360", async ({ page }) => {
  await dump(page, 360, 780);
});

test("player geometry 390", async ({ page }) => {
  await dump(page, 390, 844);
});

test("player geometry 767", async ({ page }) => {
  await dump(page, 767, 1024);
});
