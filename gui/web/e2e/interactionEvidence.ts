import { test as base } from "@playwright/test";

export type InteractionReceipt = {
  checkpoint: string;
  observation: object;
};

export const test = base.extend<{
  receipts: InteractionReceipt[];
}>({
  receipts: async ({ page }, provide, info) => {
    const receipts: InteractionReceipt[] = [];
    let fixtureError: unknown;
    try {
      await provide(receipts);
    } catch (error) {
      fixtureError = error;
    }
    const presentation = await page
      .evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        motion: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "reduce"
          : "no-preference",
        assets: Array.from(document.scripts, (script) => script.src).filter(
          Boolean,
        ),
      }))
      .catch(() => null);
    try {
      await info.attach("interaction-receipts", {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({
            version: 1,
            annotations: info.annotations,
            viewport: page.viewportSize(),
            browserVersion: page.context().browser()?.version(),
            presentation,
            receipts,
          }),
        ),
      });
    } catch (error) {
      if (fixtureError === undefined && info.errors.length === 0)
        fixtureError = error;
    }
    if (fixtureError !== undefined) throw fixtureError;
  },
});
