import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";

/** Open the Transcript tab and wait until words hydrate; returns `.transcript-list`. */
export async function openTranscriptPanel(page: Page): Promise<Locator> {
  await page
    .getByLabel("Editor panels")
    .getByRole("button", { name: "Transcript", exact: true })
    .click();
  // Words hydrated ⇔ the Correct toggle carries its capability tooltip, not the loading label.
  await expect(page.getByRole("button", { name: /^Correct:/ })).toBeEnabled();
  return page.locator(".transcript-list");
}

/**
 * Run `body` while collecting the `type` of every POSTed
 * `/api/document/command` on `page`, in order (`types` fills in live). The
 * request listener is detached when `body` settles, even if it throws.
 */
export async function withDocumentCommandTypes<T>(
  page: Page,
  body: (types: readonly string[]) => Promise<T>,
): Promise<T> {
  const types: string[] = [];
  const onRequest = (req: Request) => {
    if (req.method() !== "POST" || !req.url().includes("/api/document/command"))
      return;
    const type = (req.postDataJSON() as { type?: string } | null)?.type;
    if (type) types.push(type);
  };
  page.on("request", onRequest);
  try {
    return await body(types);
  } finally {
    page.off("request", onRequest);
  }
}
