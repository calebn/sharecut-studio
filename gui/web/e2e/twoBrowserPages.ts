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
  browser: Pick<Browser, "newContext">,
  firstContextOptions: BrowserContextOptions,
  secondContextOptions: BrowserContextOptions,
  run: (firstPage: Page, secondPage: Page) => Promise<T>,
): Promise<T> {
  return withBrowserPages(
    browser,
    [firstContextOptions, secondContextOptions],
    async ([firstPage, secondPage]) => run(firstPage!, secondPage!),
  );
}

/** Run a multi-page scenario and close every context created during setup. */
export async function withBrowserPages<T>(
  browser: Pick<Browser, "newContext">,
  contextOptions: BrowserContextOptions[],
  run: (pages: Page[]) => Promise<T>,
): Promise<T> {
  const contexts: BrowserContext[] = [];
  let primaryFailed = false;
  let primaryError: unknown;
  let result!: T;
  try {
    const pages: Page[] = [];
    for (const options of contextOptions) {
      const context = await browser.newContext(options);
      contexts.push(context);
      pages.push(await context.newPage());
    }
    result = await run(pages);
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
