import { expect, type Page, test } from "@playwright/test";
import { LONG_PRESS_MS } from "../src/hooks/gestureConstants";
import { editStakesKey } from "../src/utils/editStakes";
import { expectSurfaceAxeClean } from "./axe";
import { newFinger } from "./finger";
import {
  episodeName,
  NARROW_PHONE,
  press,
  SIZES,
  withGuestLinks,
  withGuestPage,
} from "./guestLink";
import {
  afterFrames,
  installProbes,
  openLanded,
  readProbes,
} from "./guestLoadingProbes";
import { setRootFontSize } from "./rootFontSize";
import { openGuestShare } from "./shareNavigation";

const PLAYER = ".sys-player-host";
const UNDO = "There is nothing of yours to undo.";
const REDO = "There is nothing of yours to redo.";

function playerOf(page: Page) {
  return page.getByRole("group", { name: "Player" });
}

async function targetGeometry(page: Page) {
  return page.locator(PLAYER).evaluate((bar) => {
    const selectors = [
      ".sys-player-time",
      ".sys-play-btn",
      '.sys-player-history [aria-label="Undo"]',
      '.sys-player-history [aria-label="Redo"]',
      ".sys-player-comment",
    ];
    const outer = bar.getBoundingClientRect();
    const buttons = selectors.map((selector) => {
      const button = bar.querySelector(selector);
      const rect = button?.getBoundingClientRect();
      return button && rect ? { selector, button, rect } : null;
    });
    const misses: string[] = [];
    for (const [i, item] of buttons.entries()) {
      if (!item) {
        misses.push(selectors[i]!);
        continue;
      }
      const { rect, button, selector } = item;
      if (
        rect.width < 44 ||
        rect.height < 44 ||
        rect.left < outer.left - 0.25 ||
        rect.right > outer.right + 0.25 ||
        rect.top < outer.top - 0.25 ||
        rect.bottom > outer.bottom + 0.25 ||
        !button.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        )
      )
        misses.push(selector);
      for (const other of buttons.slice(i + 1)) {
        if (!other) continue;
        const b = other.rect;
        if (
          Math.min(rect.right, b.right) - Math.max(rect.left, b.left) > 0.25 &&
          Math.min(rect.bottom, b.bottom) - Math.max(rect.top, b.top) > 0.25
        ) {
          misses.push(`${selector} overlaps ${other.selector}`);
        }
      }
    }
    return {
      misses,
      rows: new Set(
        buttons.map(
          (item) => item && Math.round(item.rect.y + item.rect.height / 2),
        ),
      ).size,
      targets: buttons.map(
        (item) => item && [item.selector, item.rect.width, item.rect.height],
      ),
    };
  });
}

for (const size of [NARROW_PHONE, SIZES[0]]) {
  for (const touch of [false, true]) {
    for (const rootFont of [100, 150, 200]) {
      test(`the Editor Player fits one history pair at ${size.width}px, ${rootFont}% text, ${touch ? "touch" : "mouse"}`, async ({
        browser,
      }) => {
        await withGuestLinks(browser, async (links, host) => {
          const name = await episodeName(host, links.editor);
          await withGuestPage(
            browser,
            { ...size, touch },
            async (guest) => {
              await installProbes(guest);
              await guest.addInitScript((size) => {
                const setSize = () => {
                  const root = document.documentElement;
                  if (!root) return;
                  root.style.fontSize = `${size}%`;
                  observer.disconnect();
                };
                const observer = new MutationObserver(setSize);
                observer.observe(document, { childList: true });
                setSize();
              }, rootFont);
              await openLanded(guest, links.editor, name);
              await expect(guest.locator(".stage-frame--phone")).toBeVisible();
              const player = playerOf(guest);
              await expect(
                player.getByRole("button", { name: "Undo" }),
              ).toBeVisible();
              await expect(
                player.getByRole("button", { name: "Redo" }),
              ).toBeVisible();
              await expect(guest.locator(".sys-header-history")).toHaveCount(0);
              const report = await targetGeometry(guest);
              expect(report.misses, JSON.stringify(report.targets)).toEqual([]);
              expect(report.rows).toBe(1);
              const probes = await readProbes(guest);
              const playerShifts = probes.shifts.filter((entry) =>
                entry.sources.some((source) => source.inPlayer),
              );
              expect(playerShifts).toEqual([]);
              if (size.width === 390 && rootFont === 100 && touch) {
                await expectSurfaceAxeClean(guest, PLAYER);
              }
            },
            { visit: "returning" },
          );
        });
      });
    }
  }
}

for (const touch of [false, true]) {
  test(`the phone Editor can undo and redo from the Player by ${touch ? "touch" : "mouse"}`, async ({
    browser,
    browserName,
  }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(
        browser,
        { ...NARROW_PHONE, touch },
        async (guest) => {
          await openGuestShare(guest, links.editor);
          const player = playerOf(guest);
          const undo = player.getByRole("button", { name: "Undo" });
          const redo = player.getByRole("button", { name: "Redo" });
          await expect(undo).toBeDisabled();
          await expect(undo).toHaveAttribute("title", UNDO);
          await expect(redo).toBeDisabled();
          await expect(redo).toHaveAttribute("title", REDO);
          const response = await guest.request.post(
            `/api/review/${links.editor}/daw/document/command`,
            {
              data: {
                type: "AddChapter",
                payload: { time: 4, title: "A phone edit" },
                client_id: "e2e-phone-player-history",
                client_seq: 1,
                role: "guest",
              },
            },
          );
          expect(response.ok(), await response.text()).toBe(true);
          const chapter = guest.getByLabel("Chapter A phone edit");
          await expect(chapter).toBeVisible();
          await expect(undo).toBeEnabled();
          await press(undo, touch);
          await expect(chapter).toHaveCount(0);
          await expect(redo).toBeEnabled();
          await press(redo, touch);
          await expect(chapter).toBeVisible();
          await afterFrames(guest);
          await expect(redo).toBeDisabled();
          await expect(redo).toHaveAttribute("title", REDO);
          if (touch) {
            await guest.clock.install();
            const box = await undo.boundingBox();
            expect(box).toBeTruthy();
            const finger = await newFinger(guest.context(), guest, browserName);
            await finger.down({
              x: box!.x + box!.width / 2,
              y: box!.y + box!.height / 2,
            });
            await guest.clock.runFor(LONG_PRESS_MS);
            await finger.up();
          } else {
            await undo.click({ button: "right" });
          }
          await expect(
            guest.getByRole("dialog", { name: "History" }),
          ).toBeVisible();
          await expect(chapter).toBeAttached();
        },
        { visit: "returning" },
      );
    });
  });
}

test("a phone Editor edit shows its Undo tip above the Player", async ({
  browser,
}) => {
  await withGuestLinks(browser, async (links) => {
    await withGuestPage(
      browser,
      { ...NARROW_PHONE, touch: true },
      async (guest) => {
        await guest.addInitScript((key) => {
          localStorage.setItem(key, "1");
        }, editStakesKey(links.editor));
        await openGuestShare(guest, links.editor);
        const timeline = guest.getByRole("slider", {
          name: "Timeline position",
        });
        await timeline.focus();
        await guest.keyboard.press("ArrowRight");
        await guest
          .getByRole("button", {
            name: "Select reference clip at 00:00.000, 1m 0s",
          })
          .tap();
        await guest.keyboard.press("Control+k");
        const player = playerOf(guest);
        const tip = player
          .getByRole("note")
          .filter({ hasText: "Two-finger tap to undo" });
        await expect(tip).toBeVisible();
        for (const rootSize of [16, 32]) {
          await setRootFontSize(guest, rootSize);
          const bounds = await tip.boundingBox();
          const row = await player.boundingBox();
          expect(bounds).toBeTruthy();
          expect(row).toBeTruthy();
          expect(bounds!.y).toBeGreaterThanOrEqual(0);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(row!.y);
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
            NARROW_PHONE.width,
          );
        }
        await tip.getByRole("button", { name: "Dismiss hint" }).tap();
        await expect(tip).toHaveCount(0);
      },
      { visit: "returning" },
    );
  });
});
