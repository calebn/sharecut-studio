import { expect, test } from "@playwright/test";
import { openHome } from "./home";
import {
  expectNoHorizontalScroll,
  mockBootstrap,
  prepare,
  row,
  shot,
  VIEWPORTS,
} from "./modelsMock";

const NOTES = [
  ["Fast", /^English only, .* choose Best\.$/],
  ["Balanced", /^English only, .* choose Best\.$/],
  ["Best", /^Works in other languages too\./],
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`whisper size note ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
    });

    test("each size says whether it is English only, and the rows below stay put", async ({
      page,
    }) => {
      await prepare(page, "light", false);
      await mockBootstrap(page);
      await page.route(
        (url) => url.pathname === "/api/projects/recent",
        (route) => route.fulfill({ json: { projects: [] } }),
      );
      await openHome(page, { dismissSetup: false });
      await page
        .getByRole("region", { name: "Get ShareCut ready" })
        .getByRole("button", { name: "Choose…" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Models" });
      const size = dialog.getByRole("group", { name: "Size" });
      const note = dialog.locator(".sys-size-note");
      const next = row(dialog, "Word timing");
      let top: number | undefined;
      for (const [name, text] of NOTES) {
        await size
          .getByRole("button", { name: new RegExp(`^${name}`) })
          .click();
        await expect(note).toHaveText(text);
        const box = await next.boundingBox();
        expect(box).not.toBeNull();
        top ??= box?.y;
        expect(box?.y).toBeCloseTo(top ?? 0, 0);
        await expectNoHorizontalScroll(page);
        await shot(page, viewport.name, "light", `whisper-note-${name}`);
      }
    });
  });
}
