import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { openPanel } from "./stageNav";

/** The Script's words, and the ones that are selected. */
export const SCRIPT_WORD = ".sys-script-word";
export const SCRIPT_SELECTED = ".sys-script-word[data-selected]";

/** Open the Script and wait until words hydrate; returns the Script's body. */
export async function openTranscriptPanel(page: Page): Promise<Locator> {
  await openPanel(page, "transcript");
  const body = page.locator(".sys-script-body");
  await expect(body.locator(SCRIPT_WORD).first()).toBeVisible();
  return body;
}

/**
 * Serve the project without pending edits. Specs share one live project and
 * earlier ones leave suggested cuts behind; the Script folds the words under a
 * suggestion into one hatched run, so they would no longer be words to count.
 * `transform` may also change the rest of the served project.
 */
export async function servePendingEditsCleared(
  page: Page,
  transform?: (project: Record<string, unknown>) => void,
): Promise<void> {
  await page.route(
    (url) => new URL(url).pathname === "/api/document/state",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      const project = (body.project ?? body.patch) as Record<string, unknown>;
      project.pending_edits = [];
      transform?.(project);
      await route.fulfill({ response, json: body });
    },
  );
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
