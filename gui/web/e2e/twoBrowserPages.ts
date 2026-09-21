import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "@playwright/test";

/**
 * Run a two-browser-page scenario while reliably releasing every context that
 * was created, including when setup only partially succeeds.
 *
 * A scenario failure is always more useful than a subsequent close failure, so
 * preserve it and surface close failures only after otherwise successful work.
 */
export async function withTwoBrowserPages<T>(
  browser: Browser,
  firstContextOptions: BrowserContextOptions,
  secondContextOptions: BrowserContextOptions,
  run: (firstPage: Page, secondPage: Page) => Promise<T>,
): Promise<T> {
  const contexts: BrowserContext[] = [];
  let primaryFailed = false;
  let primaryError: unknown;
  let result!: T;
  try {
    const firstContext = await browser.newContext(firstContextOptions);
    contexts.push(firstContext);
    const secondContext = await browser.newContext(secondContextOptions);
    contexts.push(secondContext);
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    result = await run(firstPage, secondPage);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }
  const closed = await Promise.allSettled(
    contexts.reverse().map(async (context) => context.close()),
  );
  // Cleanup must not obscure the scenario failure that triggered it.
  if (primaryFailed) throw primaryError;
  const closeFailure = closed.find(
    (close): close is PromiseRejectedResult => close.status === "rejected",
  );
  if (closeFailure) throw closeFailure.reason;
  return result as T;
}
