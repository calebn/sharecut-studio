import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { setRootFontSize } from "./rootFontSize";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { goToStage, selectRangeSec } from "./stageNav";
import { setTheme, withAppearance } from "./theme";
import { withBrowserPages } from "./twoBrowserPages";
import { hostEditsTheAudio, twoCopiesProject } from "./twoCopiesProject";

const COMMAND_ROUTE = "**/api/review/*/daw/document/command";
const ROW_TITLE = "Your cut at 0:11 overlaps a newer edit";

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
  await goToStage(guest, "review");
  const save = guest.locator(".sys-save").first();
  await expect(save).toContainText("1 waiting to send");
  await expect(save).not.toContainText("Save failed");
  await expect(attention(guest)).toHaveAccessibleName(
    "Needs attention. 1 edit waiting to send",
  );
  await expect(attention(guest)).toContainText("1 edit waiting to send");
  await expect(
    attention(guest).getByRole("button", { name: "Dismiss all" }),
  ).toHaveCount(0);
  await expect(
    attention(guest).getByRole("button", { name: "Retry" }),
  ).toHaveCount(0);
  await hostEditsTheAudio(host, projectPath);
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

const DOCK_PROPERTY = "--player-dock-height";

async function seedStaleCuts(page: Page, token: string): Promise<void> {
  const rows = [1, 2, 3].map((n) => ({
    client_id: "viewer-e2e",
    command_id: `e2e-stale-cut-${n}`,
    client_seq: n,
    type: "EditSelectedRange",
    created_at: Date.now() + n,
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
  }));
  await page.evaluate(
    ({ key, value }) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const store = db.transaction("kv", "readwrite").objectStore("kv");
          store.put(value, key);
          store.transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          store.transaction.onerror = () => reject(store.transaction.error);
        };
      }),
    { key: `queue:${token}`, value: rows },
  );
}

async function threeRefusedCuts(host: Page, guest: Page, projectPath: string) {
  const token = await createReviewShare(host, projectPath, "commenter");
  await openGuestShare(guest, token);
  await guest.route(COMMAND_ROUTE, (route) => route.abort("failed"));
  await seedStaleCuts(guest, token);
  await guest.reload();
  await expect(guest.locator(".stage-frame--guest")).toBeVisible();
  await hostEditsTheAudio(host, projectPath);
  await reconnect(guest);
  await expect(
    attention(guest).getByRole("button", { name: /^Hear your cut/ }),
  ).toHaveCount(3);
}

function dockButtons(page: Page) {
  return page.evaluate(() => {
    const window_ = { width: innerWidth, height: innerHeight };
    const shown = [
      ...document.querySelectorAll(".sys-listen-dock button"),
    ].filter((button) => button.getBoundingClientRect().width > 0);
    return shown.map((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return {
        name: button.getAttribute("aria-label") ?? button.textContent,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        inWindow:
          box.left >= 0 &&
          box.right <= window_.width &&
          box.top >= 0 &&
          box.bottom <= window_.height,
        reachable: hit === button || button.contains(hit),
      };
    });
  });
}

function sheetOf(page: Page) {
  return attention(page).evaluate((group) => {
    let node: HTMLElement | null = group.parentElement;
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY))
      node = node.parentElement;
    const sheet = node ?? document.documentElement;
    const box = sheet.getBoundingClientRect();
    const dock = document.querySelector(".sys-listen-dock");
    return {
      scrollWidth: sheet.scrollWidth,
      clientWidth: sheet.clientWidth,
      bottom: box.bottom,
      dockTop: dock ? dock.getBoundingClientRect().top : null,
    };
  });
}

const PHONE_CELLS = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const;

for (const { cell, theme } of withAppearance(PHONE_CELLS)) {
  test(`at 32 px text on ${cell.width}x${cell.height} the Listen dock and the Needs attention head stay on screen with three conflicts`, async ({
    browser,
    page,
  }) => {
    await withShareableProject(
      async (projectPath) => {
        await openHostShare(page, projectPath);
        await withBrowserPages(
          browser,
          [{ viewport: cell, hasTouch: true, isMobile: true }],
          async ([guest]) => {
            await setTheme(guest!, theme);
            await threeRefusedCuts(page, guest!, projectPath);
            await setRootFontSize(guest!, 32);
            await setTheme(guest!, theme);

            await expect
              .poll(async () =>
                (await dockButtons(guest!)).filter(
                  (button) => !button.inWindow || !button.reachable,
                ),
              )
              .toEqual([]);
            // The grown dock would take over 40% of the frame, so it folds to one row and the sheet keeps its room.
            await expect
              .poll(() =>
                guest!.evaluate(
                  () => "frameShort" in document.documentElement.dataset,
                ),
              )
              .toBe(true);
            const folded = await sheetOf(guest!);
            expect(folded.bottom).toBeLessThanOrEqual(folded.dockTop! + 0.5);
            const dockBox = (await guest!
              .locator(".sys-listen-dock")
              .boundingBox())!;
            expect(dockBox.height).toBeLessThan(cell.height * 0.2);

            const sheet = await sheetOf(guest!);
            expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
            const dismiss = attention(guest!).getByRole("button", {
              name: "Dismiss all",
            });
            await dismiss.scrollIntoViewIfNeeded();
            const box = (await dismiss.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(cell.width);
            expect(box.width).toBeGreaterThanOrEqual(150);
            expect(
              await dismiss.evaluate((el) => el.scrollWidth <= el.clientWidth),
            ).toBe(true);
            expect(
              await dismiss.evaluate((el) => {
                const at = el.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  at.left + at.width / 2,
                  at.top + at.height / 2,
                );
                return hit === el || el.contains(hit);
              }),
            ).toBe(true);
            const hear = attention(guest!)
              .getByRole("button", { name: /^Hear your cut/ })
              .last();
            await hear.scrollIntoViewIfNeeded();
            await expect(hear).toBeInViewport({ ratio: 1 });
            await dismiss.scrollIntoViewIfNeeded();
            await expect(dismiss).toBeInViewport({ ratio: 1 });
          },
        );
      },
      undefined,
      twoCopiesProject,
    );
  });
}

test("a Viewer's dock keeps its token height at 32 px text", async ({
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
          const token = await createReviewShare(page, projectPath, "viewer");
          await openGuestShare(guest!, token);
          await setRootFontSize(guest!, 32);
          const dock = guest!.locator(".sys-listen-dock");
          await expect(dock).toBeVisible();
          await expect(guest!.locator(".sys-listen-dock-comment")).toHaveCount(
            0,
          );
          const height = (await dock.boundingBox())!.height;
          expect(height).toBeCloseTo(9.8125 * 32, 0);
          expect(
            await guest!.evaluate(
              (property) =>
                document.documentElement.style.getPropertyValue(property),
              DOCK_PROPERTY,
            ),
          ).toBe("");
        },
      );
    },
    undefined,
    twoCopiesProject,
  );
});

test("on a desktop at 16 and 32 px text Dismiss all is 44 px tall with a mouse and the Needs attention rows are reachable", async ({
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
          await threeRefusedCuts(page, guest!, projectPath);
          const dismiss = attention(guest!).getByRole("button", {
            name: "Dismiss all",
          });
          const at16 = (await dismiss.boundingBox())!;
          expect(at16.height).toBeGreaterThanOrEqual(44);
          expect(at16.width).toBeGreaterThanOrEqual(44);
          await setRootFontSize(guest!, 32);
          const at32 = (await dismiss.boundingBox())!;
          expect(at32.height).toBeGreaterThanOrEqual(88);
          expect(at32.width).toBeGreaterThanOrEqual(44);
          for (const name of [
            "Dismiss all",
            "Hear your cut at 0:11",
            "Suggest again here, your cut at 0:11",
          ]) {
            const button = attention(guest!)
              .getByRole("button", { name })
              .first();
            await button.scrollIntoViewIfNeeded();
            await expect(button).toBeInViewport({ ratio: 1 });
            expect(
              await button.evaluate((el) => {
                const box = el.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  box.left + box.width / 2,
                  box.top + box.height / 2,
                );
                return hit === el || el.contains(hit);
              }),
            ).toBe(true);
          }
        },
      );
    },
    undefined,
    twoCopiesProject,
  );
});
