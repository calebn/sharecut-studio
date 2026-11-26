import { expect, type Page } from "@playwright/test";
import { openProject } from "./stageNav";

export const PROXY_MANIFEST_TIMEOUT_MS = 15_000;

/**
 * Open a guest share and observe setup even when navigation fails. An Editor link
 * plays through the stem proxies, so its manifest must answer 200; a Viewer or
 * Commenter link on a published version plays the review WAV (the bootstrap says
 * `frozen_review_view`), so it needs no manifest and the guest frame is the signal.
 */
export async function openGuestShare(page: Page, token: string): Promise<void> {
  const manifestPath = `/api/review/${token}/daw/proxy/manifest`;
  const bootstrapPath = `/api/review/${token}/project`;
  const manifestResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" && url.pathname === manifestPath
      );
    },
    { timeout: PROXY_MANIFEST_TIMEOUT_MS },
  );
  // Observed here, awaited below only for a link that needs the manifest.
  manifestResponse.catch(() => undefined);
  const statePath = `/api/review/${token}/daw/document/state`;
  const stateResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" && url.pathname === statePath
      );
    },
    { timeout: PROXY_MANIFEST_TIMEOUT_MS },
  );
  stateResponse.catch(() => undefined);
  const bootstrapResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" && url.pathname === bootstrapPath
      );
    },
    { timeout: PROXY_MANIFEST_TIMEOUT_MS },
  );
  const [, bootstrap] = await Promise.all([
    page.goto(`/r/${token}`),
    bootstrapResponse,
  ]);
  const frozen =
    ((await bootstrap.json()) as { frozen_review_view?: boolean })
      .frozen_review_view === true;
  await expect(page.locator(".stage-frame--guest")).toBeVisible({
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
  if (frozen) {
    // No proxy manifest to settle on: the document shell is what the page is ready on.
    expect((await stateResponse).status()).toBe(200);
    return;
  }
  expect((await manifestResponse).status()).toBe(200);
}

export type ReviewShareRole = "viewer" | "commenter" | "editor";

/** Create a review share for `projectPath` and return its token. */
export async function createReviewShare(
  host: Page,
  projectPath: string,
  role: ReviewShareRole = "viewer",
): Promise<string> {
  const created = await host.request.post("/api/shares", {
    data: { path: projectPath, role },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const body = (await created.json()) as { share: { token: string } };
  return body.share.token;
}

/** Open a host share and wait for the hydrated shell's lazy requests. */
export async function openHostShare(
  page: Page,
  projectPath: string,
): Promise<void> {
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible({
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
  // WebSockets remain open but do not prevent Playwright network idle.
  await page.waitForLoadState("networkidle", {
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
}
