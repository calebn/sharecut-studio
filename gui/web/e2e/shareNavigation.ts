import { expect, type Page } from "@playwright/test";

export const PROXY_MANIFEST_TIMEOUT_MS = 15_000;

/** Open a guest share and observe proxy setup even when navigation fails. */
export async function openGuestShare(page: Page, token: string): Promise<void> {
  const manifestPath = `/api/review/${token}/daw/proxy/manifest`;
  const manifestResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" && url.pathname === manifestPath
      );
    },
    { timeout: PROXY_MANIFEST_TIMEOUT_MS },
  );
  const [, response] = await Promise.all([
    page.goto(`/r/${token}`),
    manifestResponse,
  ]);
  await expect(page.locator(".daw-shell-guest")).toBeVisible({
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
  expect(response.status()).toBe(200);
}

export type ReviewShareRole = "viewer" | "editor";

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
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible({
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
  // WebSockets remain open but do not prevent Playwright network idle.
  await page.waitForLoadState("networkidle", {
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
}
