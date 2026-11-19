import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { AUTO_MIX_PREF_KEY } from "../src/hooks/autoMixPref";
import {
  CLIP_EXPORTS,
  createClipCurrentnessProject,
} from "./clipCurrentnessProject";
import { e2eBaseURL } from "./env";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { goToStage, stageTab } from "./stageNav";
import { withTwoBrowserPages } from "./twoBrowserPages";

const test = base.extend({ trace: "off", screenshot: "off", video: "off" });
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
type Inventory = Array<{ id: string; current: boolean; kind: string }>;

function fileRow(page: Page, name: string) {
  return page.locator(".dv-file-row").filter({
    has: page.getByText(name, { exact: true }),
  });
}

async function downloadHash(page: Page, name: string) {
  const downloaded = page.waitForEvent("download");
  await fileRow(page, name)
    .getByRole("link", {
      name: new RegExp(`^Download ${name.replaceAll(".", "\\.")},`),
    })
    .click();
  const file = await downloaded;
  expect(await file.failure()).toBeNull();
  expect(file.suggestedFilename()).toBe(name);
  const localPath = await file.path();
  if (!localPath)
    throw new Error("Browser download did not yield a local file");
  return hash(fs.readFileSync(localPath));
}

export function registerClipCurrentnessSmoke() {
  test.describe("saved clip export currentness", () => {
    test.describe.configure({ retries: 0 });
    test("Deliver refresh keeps orphan downloads and updates the host badge", async ({
      browser,
    }, testInfo) => {
      test.setTimeout(120_000);
      let token = "";
      let phase = "synthetic fixture setup";
      const receipt: Record<string, unknown> = { outcome: "NOT_EXECUTED" };
      try {
        await withShareableProject(
          async (projectPath) => {
            const expectedHashes = Object.fromEntries(
              CLIP_EXPORTS.map((file) => [
                file.name,
                hash(
                  fs.readFileSync(
                    path.join(path.dirname(projectPath), "export", file.id),
                  ),
                ),
              ]),
            );
            expect(new Set(Object.values(expectedHashes)).size).toBe(2);
            const contextOptions = {
              viewport: { width: 1280, height: 900 },
              acceptDownloads: true,
              storageState: {
                cookies: [],
                origins: [
                  {
                    origin: new URL(e2eBaseURL).origin,
                    localStorage: [{ name: AUTO_MIX_PREF_KEY, value: "off" }],
                  },
                ],
              },
            };
            await withTwoBrowserPages(
              browser,
              contextOptions,
              contextOptions,
              async (host, guest) => {
                phase = "host project and Deliver navigation";
                await openHostShare(host, projectPath);
                await goToStage(host, "deliver");
                phase = "real Editor share creation";
                token = await createReviewShare(host, projectPath, "editor");
                const reads: Inventory[] = [];
                let unreadable = false;
                guest.on("response", async (response) => {
                  if (
                    response.request().method() !== "GET" ||
                    new URL(response.url()).pathname !==
                      `/api/review/${token}/daw/export/files`
                  )
                    return;
                  try {
                    if (response.status() !== 200)
                      throw new Error("Inventory request failed");
                    const body = (await response.json()) as {
                      files?: Inventory;
                    };
                    if (!Array.isArray(body.files))
                      throw new Error("Inventory response missing files");
                    reads.push(
                      body.files
                        .map(({ id, current, kind }) => ({ id, current, kind }))
                        .sort((a, b) => a.id.localeCompare(b.id)),
                    );
                  } catch {
                    unreadable = true;
                  }
                });
                phase = "real Editor share open and onboarding dismissal";
                await openGuestShare(guest, token);
                const hint = guest
                  .locator(".stage-frame-header")
                  .getByRole("note")
                  .filter({
                    hasText:
                      "You can edit and comment. The host decides what ships.",
                  });
                await expect(hint).toBeVisible();
                await hint
                  .getByRole("button", { name: "Dismiss hint", exact: true })
                  .click();
                await expect(hint).toBeHidden();
                await goToStage(guest, "deliver");
                phase = "initial real inventory, labels and host badge";
                const initial: Inventory = [
                  { id: "clips/current_c1.wav", current: true, kind: "audio" },
                  { id: "clips/old_c1.wav", current: false, kind: "audio" },
                ];
                await expect.poll(() => reads.at(-1)).toEqual(initial);
                await expect(guest.locator(".dv-file-row")).toHaveCount(2);
                await expect(
                  fileRow(guest, "old_c1.wav").getByText(
                    "Export is out of date",
                    { exact: true },
                  ),
                ).toBeVisible();
                await expect(
                  fileRow(guest, "current_c1.wav").getByText(
                    "Export is out of date",
                    { exact: true },
                  ),
                ).toHaveCount(0);
                await expect(
                  stageTab(host, "deliver").locator(".sys-stage-badge"),
                ).toHaveText("Done");
                phase = "both initial browser download hashes";
                const before: Record<string, string> = {};
                for (const file of CLIP_EXPORTS) {
                  before[file.name] = await downloadHash(guest, file.name);
                  expect(before[file.name]).toBe(expectedHashes[file.name]);
                }
                phase = "host Clips Remove and resulting real server refresh";
                const beforeRemoval = reads.length;
                await host
                  .getByRole("button", {
                    name: "More for Current clip",
                    exact: true,
                  })
                  .click();
                await host
                  .getByRole("menuitem", { name: "Remove", exact: true })
                  .click();
                await expect(
                  host.getByRole("button", {
                    name: "More for Current clip",
                    exact: true,
                  }),
                ).toHaveCount(0);
                const orphaned = initial.map((file) => ({
                  ...file,
                  current: false,
                }));
                await expect
                  .poll(() =>
                    reads
                      .slice(beforeRemoval)
                      .some(
                        (files) =>
                          JSON.stringify(files) === JSON.stringify(orphaned),
                      ),
                  )
                  .toBe(true);
                await expect(guest.locator(".dv-file-row")).toHaveCount(2);
                for (const file of CLIP_EXPORTS)
                  await expect(
                    fileRow(guest, file.name).getByText(
                      "Export is out of date",
                      { exact: true },
                    ),
                  ).toBeVisible();
                await expect(
                  stageTab(host, "deliver").locator(".sys-stage-badge"),
                ).toHaveText("Needs you");
                phase = "both refreshed browser download hashes";
                const after: Record<string, string> = {};
                for (const file of CLIP_EXPORTS) {
                  after[file.name] = await downloadHash(guest, file.name);
                  expect(after[file.name]).toBe(expectedHashes[file.name]);
                }
                expect(unreadable).toBe(false);
                receipt.outcome = "HEAD_PASS";
                receipt.downloadSha256Before = before;
                receipt.downloadSha256After = after;
                receipt.badges = ["Done", "Needs you"];
                receipt.genuineInventoryReads = reads.length;
              },
            );
          },
          undefined,
          createClipCurrentnessProject,
        );
      } catch {
        const safe = `Clip currentness failed during ${phase}. Raw network and locator errors are omitted to protect generated credentials.`;
        receipt.outcome = "FAIL";
        receipt.reason = safe;
        throw new Error(safe);
      } finally {
        await testInfo.attach("clip-currentness-verdict", {
          body: JSON.stringify(receipt, null, 2),
          contentType: "application/json",
        });
      }
    });
  });
}
