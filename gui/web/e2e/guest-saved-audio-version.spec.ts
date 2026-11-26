import { expect, type Page, test } from "@playwright/test";
import { loseConnectionOnLoad, NARROW_PHONE, SIZES } from "./guestLink";
import { guestLinkAudio, guestSavedCopy } from "./offlineQueue";
import { playButton } from "./playback";
import { createScriptRecordingIdentityProject } from "./scriptRecordingIdentityProject";
import { switchE2eProject, withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

type Occurrences = Record<
  string,
  {
    artifactId: string;
    bakesMutes?: boolean;
  }
>;

async function savedOccurrences(page: Page, token: string) {
  const saved = (await guestSavedCopy(page, token)) as {
    manifest?: { occurrences: Occurrences };
  } | null;
  return Object.values(saved?.manifest?.occurrences ?? {});
}

async function removeSavedOccurrenceMuteFlags(page: Page, token: string) {
  await page.evaluate(
    (key) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const transaction = db.transaction("kv", "readwrite");
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
          const store = transaction.objectStore("kv");
          const request = store.get(key);
          request.onsuccess = () => {
            const saved = request.result as {
              manifest: { occurrences: Occurrences };
            };
            for (const binding of Object.values(saved.manifest.occurrences))
              delete binding.bakesMutes;
            store.put(saved, key);
          };
        };
      }),
    `snap:${token}`,
  );
}

for (const [role, phone] of [
  ["editor", SIZES[0]],
  // An Editor link plays through proxies; a Viewer's published version does not (#3605).
  ["editor", NARROW_PHONE],
] as const) {
  test(`a legacy ${role} guest occurrence needs a fresh manifest before it plays${phone === NARROW_PHONE ? " on a narrow phone" : ""}`, async ({
    browser,
  }) => {
    await withShareableProject(
      async (projectPath) =>
        withBrowserPages(
          browser,
          [{}, { viewport: phone, hasTouch: phone.touch }],
          async ([host, guest]) => {
            await openHostShare(host!, projectPath);
            const token = await createReviewShare(host!, projectPath, role);
            const page = guest!;
            await page.addInitScript(() => {
              const start = AudioBufferSourceNode.prototype.start;
              const scope = window as Window & { audioStarts?: number };
              scope.audioStarts = 0;
              AudioBufferSourceNode.prototype.start = function (...args) {
                const result = start.apply(this, args);
                scope.audioStarts = (scope.audioStarts ?? 0) + 1;
                return result;
              };
            });
            const started = () =>
              page.evaluate(
                () => (window as Window & { audioStarts?: number }).audioStarts,
              );
            const dismissHint = () =>
              page
                .getByRole("button", { name: "Dismiss hint" })
                .click({ timeout: 1_000 })
                .catch(() => undefined);
            const pill = page.locator(".sys-player-pill.sys-pill--danger");

            await openGuestShare(page, token);
            await dismissHint();
            await expect
              .poll(async () =>
                (await savedOccurrences(page, token)).map((o) => o.bakesMutes),
              )
              .toContain(false);
            const [occurrence] = await savedOccurrences(page, token);
            const alternateChunk = page.waitForResponse((response) =>
              new URL(response.url()).pathname.endsWith(
                `/${occurrence!.artifactId}/0`,
              ),
            );
            await playButton(page).click();
            expect((await alternateChunk).ok()).toBe(true);
            await expect.poll(started).toBeGreaterThan(0);
            await expect
              .poll(async () => (await guestLinkAudio(page, token)).entries)
              .toBe(2);
            await page
              .getByRole("button", { name: "Pause", exact: true })
              .click();

            const validOffline = await loseConnectionOnLoad(page, token);
            await expect(
              page.getByText("Saved copy", { exact: true }),
            ).toBeVisible();
            await playButton(page).click();
            await expect.poll(started).toBeGreaterThan(0);
            await page
              .getByRole("button", { name: "Pause", exact: true })
              .click();
            validOffline.answerWith("through");
            await page.context().setOffline(false);
            await expect(
              page.getByText("Saved copy", { exact: true }),
            ).toHaveCount(0);
            await expect
              .poll(async () =>
                (await savedOccurrences(page, token)).map((o) => o.bakesMutes),
              )
              .toContain(false);
            await page.unroute(`**/api/review/${token}/project`);
            await removeSavedOccurrenceMuteFlags(page, token);
            const legacy = await savedOccurrences(page, token);
            expect(legacy.length).toBeGreaterThan(0);
            expect(legacy.every((binding) => !("bakesMutes" in binding))).toBe(
              true,
            );

            let chunks = 0;
            page.on("request", (request) => {
              if (
                /\/daw\/proxy\/[^/]+\/[^/]+\/\d+$/.test(
                  new URL(request.url()).pathname,
                )
              )
                chunks += 1;
            });
            const held = await loseConnectionOnLoad(page, token);
            await expect(page.locator(".stage-frame--guest")).toBeVisible();
            await expect(
              page.getByText("Saved copy", { exact: true }),
            ).toBeVisible();
            const guidance = "Reconnect for audio";
            const manifestPath = `/api/review/${token}/daw/proxy/manifest`;
            const isManifest = (url: string) =>
              new URL(url).pathname === manifestPath;
            const recovery = page
              .getByRole("status")
              .filter({ hasText: guidance });
            const label = recovery.getByText(guidance, { exact: true });
            const retry = recovery.getByRole("button", { name: "Retry audio" });
            await expect(pill).toHaveCount(0);
            await expect(label).toBeVisible();
            const expectRecoveryFits = async () => {
              await expect(label).toBeInViewport({ ratio: 1 });
              await expect(retry).toBeInViewport({ ratio: 1 });
              await expect(playButton(page)).toBeInViewport({ ratio: 1 });
            };
            await expectRecoveryFits();
            const zoom =
              phone === NARROW_PHONE
                ? await page.addStyleTag({
                    content: "html { font-size: 200%; }",
                  })
                : null;
            if (zoom) await expectRecoveryFits();
            const failed = page.waitForEvent("requestfailed", (request) =>
              isManifest(request.url()),
            );
            await retry.click({ timeout: 5_000 });
            await failed;
            await expect(label).toBeVisible();
            await zoom?.evaluate((element) =>
              element.parentNode?.removeChild(element),
            );
            expect(chunks).toBe(0);
            expect(await started()).toBe(0);

            // Keep the saved episode open so Retry is the request that replaces its manifest.
            await page.context().setOffline(false);
            const refreshed = page.waitForResponse((response) =>
              isManifest(response.url()),
            );
            await retry.click({ timeout: 5_000 });
            expect((await refreshed).status()).toBe(200);
            await expect(label).toHaveCount(0);
            await expect(pill).toHaveCount(0);
            await expect
              .poll(async () =>
                (await savedOccurrences(page, token)).map((o) => o.bakesMutes),
              )
              .toContain(false);
            await expect.poll(started).toBeGreaterThan(0);

            held.answerWith("through");
            await page.evaluate(() =>
              window.dispatchEvent(new Event("online")),
            );
            await expect(
              page.getByText("Saved copy", { exact: true }),
            ).toHaveCount(0);
          },
        ),
      switchE2eProject,
      createScriptRecordingIdentityProject,
    );
  });
}
