import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { goToStage, selectRangeSec } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

const COMMAND_ROUTE = "**/api/review/*/daw/document/command";
const ROW_TITLE = "Your cut at 0:11 overlaps a newer edit";

function twoCopiesProject(prefix: string) {
  const copy = createRelocatedE2eProject(prefix);
  const data = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
  const clip = {
    track_id: "reference",
    source_start: 0,
    source_end: 5,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
  };
  data.timeline.clips = [
    { ...clip, id: "first-copy", timeline_start: 0 },
    { ...clip, id: "second-copy", timeline_start: 10 },
    {
      ...clip,
      id: "peer",
      track_id: "guest",
      source_end: 20,
      timeline_start: 0,
    },
  ];
  data.timeline.duration_sec = 20;
  data.editorial.edit_decisions = [];
  data.editorial.edit_log = [];
  fs.writeFileSync(copy.projectPath, `${JSON.stringify(data, null, 2)}\n`);
  return copy;
}

const PROOF_DIR = process.env.UI_PROOF_DIR;

async function proof(page: Page, name: string) {
  if (!PROOF_DIR) return;
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: path.join(PROOF_DIR, `${name}-light.png`) });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: path.join(PROOF_DIR, `${name}-dark.png`) });
  await page.emulateMedia({ colorScheme: "light" });
}

const pendingEdits = (projectPath: string): number =>
  (
    JSON.parse(fs.readFileSync(projectPath, "utf8")).editorial
      .edit_decisions as unknown[]
  ).length;

const attention = (page: Page) =>
  page.getByRole("group", { name: /^Needs attention/ });

function queued(page: Page, token: string) {
  return page.evaluate(
    (key) =>
      new Promise<{ type: string }[]>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const read = db
            .transaction("kv", "readonly")
            .objectStore("kv")
            .get(key);
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            db.close();
            resolve((read.result as { type: string }[] | undefined) ?? []);
          };
        };
      }),
    `queue:${token}`,
  );
}

async function seedStaleCut(page: Page, token: string): Promise<void> {
  const row = {
    client_id: "viewer-e2e",
    command_id: "e2e-stale-cut",
    client_seq: 1,
    type: "EditSelectedRange",
    created_at: Date.now(),
    payload: {
      action: "cut",
      targets: [
        {
          kind: "exact_range",
          intervals: [{ start: 11, end: 12 }],
          track_ids: ["reference"],
          clips: [],
          media_seals: { reference: "sealed-before-the-host-edit" },
        },
      ],
    },
  };
  await page.evaluate(
    ({ key, value }) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const store = db.transaction("kv", "readwrite").objectStore("kv");
          store.put([value], key);
          store.transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          store.transaction.onerror = () => reject(store.transaction.error);
        };
      }),
    { key: `queue:${token}`, value: row },
  );
}

async function hostEditsTheAudio(host: Page, projectPath: string) {
  await postDocumentCommand(
    host,
    "e2e-host",
    "SetClipFade",
    {
      clip_id: "second-copy",
      fade_in_ms: 40,
      fade_out_ms: 0,
      expected: { fade_in_ms: 0, fade_out_ms: 0 },
    },
    projectPath,
  );
}

async function reconnect(guest: Page) {
  await guest.unroute(COMMAND_ROUTE);
  await guest.evaluate(() => window.dispatchEvent(new Event("online")));
  const opener = guest.getByRole("button", { name: /Needs attention$/ });
  await expect(attention(guest).or(opener)).toBeVisible();
  if (await opener.isVisible()) await opener.click();
  await expect(attention(guest)).toContainText(ROW_TITLE);
}

/** An Editor cuts 11 to 12 s offline in the real UI, the host edits that audio, the guest reconnects. */
async function refusedEditorCut(host: Page, guest: Page, projectPath: string) {
  const token = await createReviewShare(host, projectPath, "editor");
  await guest.route(COMMAND_ROUTE, (route) => route.abort("failed"));
  await openGuestShare(guest, token);
  await guest.getByRole("button", { name: "Explain Editor role" }).click();
  await selectRangeSec(guest, "11", "12");
  await guest
    .getByRole("group", { name: /^(Selection|Edit) actions$/ })
    .getByRole("button", { name: "Cut", exact: true })
    .click();
  await expect
    .poll(async () => (await queued(guest, token)).map((c) => c.type))
    .toEqual(["EditSelectedRange"]);
  await hostEditsTheAudio(host, projectPath);
  await goToStage(guest, "review");
  await reconnect(guest);
}

/** A Commenter's queued cut was sealed before the host edit; it replays and is refused. */
async function refusedCommenterCut(
  host: Page,
  guest: Page,
  projectPath: string,
) {
  const token = await createReviewShare(host, projectPath, "commenter");
  await openGuestShare(guest, token);
  await guest.route(COMMAND_ROUTE, (route) => route.abort("failed"));
  await seedStaleCut(guest, token);
  await guest.reload();
  await expect(guest.locator(".stage-frame--guest")).toBeVisible();
  await hostEditsTheAudio(host, projectPath);
  await reconnect(guest);
}

test("a refused offline cut shows the three-button row; Hear plays, Drop it clears and stays cleared", async ({
  browser,
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      await withBrowserPages(
        browser,
        [{ viewport: { width: 1280, height: 800 } }],
        async ([guest]) => {
          await refusedEditorCut(page, guest!, projectPath);
          const group = attention(guest!);
          const buttons = group.getByRole("button");
          await expect(
            buttons.filter({ hasText: /^Dismiss all$/ }),
          ).toHaveCount(1);
          await expect(
            group.getByRole("button", { name: "Hear your cut at 0:11" }),
          ).toBeVisible();
          await expect(
            group.getByRole("button", {
              name: "Suggest again here, your cut at 0:11",
            }),
          ).toBeVisible();
          await expectPageAxeClean(
            guest!,
            '[role="group"][aria-label^="Needs attention"]',
          );

          await expect(
            guest!.getByRole("button", { name: "Pause", exact: true }),
          ).toHaveCount(0);
          await group
            .getByRole("button", { name: "Hear your cut at 0:11" })
            .click();
          await expect(
            guest!.getByRole("button", { name: "Pause", exact: true }),
          ).toBeVisible();

          await group
            .getByRole("button", { name: "Drop it, your cut at 0:11" })
            .click();
          await expect(attention(guest!)).toHaveCount(0);
          await expect(guest!.locator(".rv-progress")).toBeFocused();
          await guest!.reload();
          await expect(guest!.locator(".stage-frame--guest")).toBeVisible();
          await expect(attention(guest!)).toHaveCount(0);
        },
      );
    },
    undefined,
    twoCopiesProject,
  );
});

test("Suggest again here sends a fresh cut from the current document and replaces the row", async ({
  browser,
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      await withBrowserPages(
        browser,
        [{ viewport: { width: 1280, height: 800 } }],
        async ([guest]) => {
          await refusedCommenterCut(page, guest!, projectPath);
          await proof(guest!, "conflict-row-desktop-1280");
          const proposed: string[] = [];
          guest!.on("request", (request) => {
            if (
              request.method() === "POST" &&
              request.url().includes("/command")
            )
              proposed.push(request.postDataJSON().type);
          });
          expect(pendingEdits(projectPath)).toBe(0);
          await attention(guest!)
            .getByRole("button", {
              name: "Suggest again here, your cut at 0:11",
            })
            .click();
          await expect(attention(guest!)).toHaveCount(0);
          expect(proposed).toEqual(["EditSelectedRange"]);
          await expect.poll(() => pendingEdits(projectPath)).toBe(1);
        },
      );
    },
    undefined,
    twoCopiesProject,
  );
});

test("on a phone with touch the row keeps its three buttons reachable and 44 px tall", async ({
  browser,
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      await withBrowserPages(
        browser,
        [
          {
            viewport: { width: 390, height: 844 },
            hasTouch: true,
            isMobile: true,
          },
        ],
        async ([guest]) => {
          await refusedCommenterCut(page, guest!, projectPath);
          const group = attention(guest!);
          await expect(group).toBeInViewport();
          const names = [
            "Hear your cut at 0:11",
            "Suggest again here, your cut at 0:11",
            "Drop it, your cut at 0:11",
          ];
          for (const name of names) {
            const button = group.getByRole("button", { name });
            await button.scrollIntoViewIfNeeded();
            const box = (await button.boundingBox())!;
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(390);
          }
          expect(
            await guest!.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(390);
          await expectPageAxeClean(
            guest!,
            '[role="group"][aria-label^="Needs attention"]',
          );
          await proof(guest!, "conflict-row-phone-390-touch");
          await group.getByRole("button", { name: names[2]! }).tap();
          await expect(attention(guest!)).toHaveCount(0);
        },
      );
    },
    undefined,
    twoCopiesProject,
  );
});
