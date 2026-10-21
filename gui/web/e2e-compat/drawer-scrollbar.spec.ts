import { expect, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";

// Headless Chromium hides scrollbars by default; this test needs one.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("the collapsed rail handle stays above the timeline's horizontal scrollbar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  await page.addStyleTag({
    content: ".timeline-scroll::-webkit-scrollbar{height:15px;background:#888}",
  });
  await page.getByRole("separator", { name: "Resize editor panels" }).focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("button", { name: "Show editor panels" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>(".timeline-time");
    if (t) t.style.minInlineSize = "6000px";
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sc = document.querySelector<HTMLElement>(".timeline-scroll")!;
        return sc.offsetHeight - sc.clientHeight;
      }),
    )
    .toBeGreaterThan(8);
  // The handle lifts on the next resize notification, so poll for it.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sc = document.querySelector<HTMLElement>(".timeline-scroll")!;
        const r = sc.getBoundingClientRect();
        const sb = sc.offsetHeight - sc.clientHeight;
        const handle = document
          .querySelector(".drawer-reopen-handle")!
          .getBoundingClientRect();
        const x = handle.left + handle.width / 2 + 40;
        const el = document.elementFromPoint(x, r.bottom - sb / 2);
        return !!el?.closest(".drawer-reopen-handle");
      }),
    )
    .toBe(false);
});
