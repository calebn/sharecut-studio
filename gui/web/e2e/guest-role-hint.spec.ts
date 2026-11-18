import { expect, type Page, type Route, test } from "@playwright/test";
import { fontsReady } from "./fontsReady";
import {
  NARROW_PHONE,
  ROLES,
  SIZES,
  type Size,
  withGuestLinks,
  withGuestPage,
} from "./guestLink";
import { afterFrames } from "./guestLoadingProbes";
import { guestSavedCopy } from "./offlineQueue";
import { setRootFontSize } from "./rootFontSize";

type Role = (typeof ROLES)[number];

const [PHONE, DESKTOP] = SIZES;
const PHONES = [PHONE, NARROW_PHONE] as const;
/** Short enough that the transcript has more lines than fit, so a scroll moves it. */
const SHORT_PHONE: Size = {
  name: "short",
  width: 390,
  height: 560,
  touch: true,
};

const NOTE = ".sys-role-hint [role=note]";
const SENTENCE: Record<Role, string> = {
  viewer: "You can listen along. The host decides.",
  commenter: "You can comment and suggest cuts. The host decides.",
  editor: "You can edit and comment. The host decides what ships.",
};

/** What a guest's own browser keeps for the three roles, in the order viewer, commenter, editor. */
const seenFlags = (page: Page) =>
  page.evaluate(() =>
    ["viewer", "commenter", "editor"].map(
      (role) => localStorage.getItem(`sharecut.roleHintSeen.${role}`) ?? "-",
    ),
  );

/** The review link opened and settled: the studio's first content drawn, fonts in, two frames passed. */
async function settle(page: Page, role: Role) {
  await expect(page.locator(".stage-frame--guest")).toBeVisible();
  await page
    .locator(
      role === "editor" ? ".clip-block, .sys-script-word" : ".sys-script-word",
    )
    .first()
    .waitFor();
  await fontsReady(page);
  await afterFrames(page);
}

/** A first visit: the hint is up and the page has settled under it. */
async function firstVisit(page: Page, token: string, role: Role) {
  await page.goto(`/r/${token}`);
  await expect(page.locator(NOTE)).toBeVisible();
  await settle(page, role);
}

async function press(page: Page, size: Size, x: number, y: number) {
  if (size.touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

type Box = { x: number; y: number; w: number; h: number; bottom: number };

type HintBoxes = {
  window: { w: number; h: number };
  note: Box;
  sentence: Box;
  close: Box;
  /** The header bar the bubble hangs from. */
  header: Box;
  /** The first transcript line of text, when the page has one. */
  firstLine: Box | null;
  /** Whether any of the note's content is clipped by its own box. */
  clipped: boolean;
  /** The bubble's block padding. */
  padding: number;
};

async function hintBoxes(page: Page): Promise<HintBoxes> {
  return page.evaluate((selector) => {
    const box = (el: Element): Box => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom };
    };
    const note = document.querySelector<HTMLElement>(selector);
    const sentence = note?.querySelector<HTMLElement>(":scope > span");
    const close = note?.querySelector<HTMLElement>("button");
    const header = document.querySelector(".sys-app-header-host");
    if (!note || !sentence || !close || !header)
      throw new Error("the hint, its sentence or its X is not on the page");
    const words = [...document.querySelectorAll(".sys-script-word")];
    const top = words[0]?.getBoundingClientRect().top;
    const row = words.filter(
      (word) => Math.abs(word.getBoundingClientRect().top - (top ?? 0)) < 2,
    );
    const rects = row.map((word) => word.getBoundingClientRect());
    const firstLine =
      rects.length === 0
        ? null
        : {
            x: Math.min(...rects.map((r) => r.left)),
            y: Math.min(...rects.map((r) => r.top)),
            w:
              Math.max(...rects.map((r) => r.right)) -
              Math.min(...rects.map((r) => r.left)),
            h: Math.max(...rects.map((r) => r.height)),
            bottom: Math.max(...rects.map((r) => r.bottom)),
          };
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      note: box(note),
      sentence: box(sentence),
      close: box(close),
      header: box(header),
      firstLine,
      padding: Number.parseFloat(getComputedStyle(note).paddingTop),
      clipped:
        note.scrollWidth > note.clientWidth + 1 ||
        note.scrollHeight > note.clientHeight + 1 ||
        sentence.scrollWidth > sentence.clientWidth + 1,
    };
  }, NOTE);
}

const describeBox = (b: Box) =>
  `x ${b.x}, y ${b.y}, ${b.w} x ${b.h}, bottom ${b.bottom}`;

/** The state a press or a key must leave alone when it only closes the hint. */
const untouched = (page: Page) =>
  page.evaluate(() => ({
    elapsed:
      document.querySelector(".sys-listen-dock-elapsed, .sys-player-now")
        ?.textContent ?? null,
    selection: window.getSelection()?.toString() ?? "",
    playingWords: document.querySelectorAll(".sys-script-word[data-playing]")
      .length,
    dialogs: document.querySelectorAll("[role=dialog]").length,
    focus: document.activeElement?.tagName ?? null,
  }));

test.describe("a press on the first-visit role hint itself", () => {
  for (const size of [...PHONES, DESKTOP]) {
    test(`closes it and records it at ${size.width}x${size.height}`, async ({
      browser,
    }) => {
      await withGuestLinks(browser, async (links) => {
        await withGuestPage(browser, size, async (guest) => {
          await firstVisit(guest, links.commenter, "commenter");
          const boxes = await hintBoxes(guest);
          // Near the bubble's foot, inside its padding.
          await press(
            guest,
            size,
            boxes.note.x + boxes.note.w / 2,
            boxes.note.bottom - 2,
          );
          await expect(
            guest.locator(NOTE),
            `a press at the bubble's foot (${describeBox(boxes.note)}) left the hint up`,
          ).toHaveCount(0);
          expect(await seenFlags(guest)).toEqual(["-", "1", "-"]);
        });
      });
    });
  }

  test("a tap on the sentence where a word lies under it closes it and presses that word not", async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, NARROW_PHONE, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        // Larger text lays the bubble over the first line, so there is a word to press under it.
        await setRootFontSize(guest, 32);
        await afterFrames(guest);
        const spot = await guest.evaluate((selector) => {
          const note = document.querySelector<HTMLElement>(selector)!;
          const nb = note.getBoundingClientRect();
          const closeLeft = note
            .querySelector("button")!
            .getBoundingClientRect().left;
          for (const word of document.querySelectorAll(".sys-script-word")) {
            const b = word.getBoundingClientRect();
            const left = Math.max(b.left, nb.left);
            const right = Math.min(b.right, nb.right, closeLeft - 8);
            const top = Math.max(b.top, nb.top);
            const bottom = Math.min(b.bottom, nb.bottom);
            if (right - left < 4 || bottom - top < 4) continue;
            const x = (left + right) / 2;
            const y = (top + bottom) / 2;
            const stack = document.elementsFromPoint(x, y);
            const onNote = stack.findIndex((el) => note.contains(el));
            const onWord = stack.findIndex((el) => word.contains(el));
            return { x, y, onNote, onWord };
          }
          return null;
        }, NOTE);
        expect(spot, "no word lies under the bubble").not.toBeNull();
        expect(spot!.onNote, JSON.stringify(spot)).toBe(0);
        expect(spot!.onWord, JSON.stringify(spot)).toBeGreaterThan(0);
        const before = await untouched(guest);
        await guest.touchscreen.tap(spot!.x, spot!.y);
        await expect(guest.locator(NOTE)).toHaveCount(0);
        expect(await seenFlags(guest)).toEqual(["-", "1", "-"]);
        await afterFrames(guest);
        expect(await untouched(guest)).toEqual(before);
        // The control: the same word, now bare, does seek.
        await guest.touchscreen.tap(spot!.x, spot!.y);
        await expect
          .poll(async () => (await untouched(guest)).elapsed)
          .not.toBe(before.elapsed);
      });
    });
  });

  test("closes it on a press on the sentence's own text, with no dialog opened", async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, PHONE, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        const { sentence } = await hintBoxes(guest);
        await press(
          guest,
          PHONE,
          sentence.x + sentence.w / 2,
          sentence.y + sentence.h / 2,
        );
        await expect(guest.locator(NOTE)).toHaveCount(0);
        await expect(guest.getByRole("dialog")).toHaveCount(0);
        await expect(
          guest.getByRole("button", { name: "Explain Commenter role" }),
        ).toHaveAttribute("aria-expanded", "false");
      });
    });
  });
});

test.describe("the first-visit role hint's box on a touch screen", () => {
  // The tallest the bubble may be at 200% text, by width. The Viewer's one line takes the smallest cap of its width.
  const LARGE_TEXT_HEIGHT: Record<number, Record<Role, number>> = {
    390: { viewer: 112, commenter: 112, editor: 112 },
    320: { viewer: 176, commenter: 176, editor: 208 },
  };
  for (const size of PHONES) {
    test(`is 44 px tall in every role, clear of the Commenter's first line of text and inside the window, and at 200% text cuts nothing, keeps the X on screen and stays under its height cap at ${size.width}x${size.height}`, async ({
      browser,
    }) => {
      await withGuestLinks(browser, async (links) => {
        for (const role of ROLES) {
          await withGuestPage(browser, size, async (guest) => {
            await firstVisit(guest, links[role], role);
            const boxes = await hintBoxes(guest);
            const at = `${role} at ${size.width}: note ${describeBox(boxes.note)}`;
            expect.soft(boxes.note.h, at).toBe(44);
            expect.soft(boxes.close.w, at).toBeCloseTo(44, 1);
            expect.soft(boxes.close.h, at).toBeCloseTo(44, 1);
            expect
              .soft(boxes.close.y, at)
              .toBeGreaterThanOrEqual(boxes.note.y - 0.5);
            expect
              .soft(boxes.close.bottom, at)
              .toBeLessThanOrEqual(boxes.note.bottom + 0.5);
            expect
              .soft(boxes.close.x + boxes.close.w, at)
              .toBeLessThanOrEqual(boxes.note.x + boxes.note.w + 0.5);
            expect.soft(boxes.note.x, at).toBeGreaterThanOrEqual(0);
            expect
              .soft(boxes.note.x + boxes.note.w, at)
              .toBeLessThanOrEqual(boxes.window.w);
            expect
              .soft(boxes.note.bottom, at)
              .toBeLessThanOrEqual(boxes.window.h);
            expect.soft(boxes.clipped, at).toBe(false);
            expect
              .soft(
                boxes.close.y + boxes.close.h / 2,
                `${at}: the X is centred on the bubble`,
              )
              .toBeCloseTo(boxes.note.y + boxes.note.h / 2, 0);
            expect
              .soft(boxes.note.y - boxes.header.bottom, at)
              .toBeCloseTo(3, 1);
            if (role === "commenter") {
              // The first line of text is the page's, so nothing of it may sit under the bubble.
              expect(boxes.firstLine, at).not.toBeNull();
              expect
                .soft(
                  boxes.note.bottom,
                  `${at}; first line ${describeBox(boxes.firstLine!)}`,
                )
                .toBeLessThanOrEqual(boxes.firstLine!.y);
            }

            await setRootFontSize(guest, 32);
            await afterFrames(guest);
            const large = await hintBoxes(guest);
            const atLarge = `${role} at ${size.width}, 200%: note ${describeBox(large.note)}`;
            expect.soft(large.clipped, atLarge).toBe(false);
            expect.soft(large.close.x, atLarge).toBeGreaterThanOrEqual(0);
            expect
              .soft(large.close.x + large.close.w, atLarge)
              .toBeLessThanOrEqual(large.window.w);
            expect
              .soft(large.close.bottom, atLarge)
              .toBeLessThanOrEqual(large.window.h);
            expect.soft(large.padding, atLarge).toBeGreaterThan(0);
            expect
              .soft(large.sentence.y - large.note.y, atLarge)
              .toBeGreaterThanOrEqual(large.padding - 0.5);
            expect
              .soft(large.note.bottom - large.sentence.bottom, atLarge)
              .toBeGreaterThanOrEqual(large.padding - 0.5);
            expect
              .soft(large.note.h, atLarge)
              .toBeLessThanOrEqual(LARGE_TEXT_HEIGHT[size.width][role]);
          });
        }
      });
    });
  }
});

test.describe("the first-visit role hint's box on a desktop", () => {
  test("keeps its 40 px height and its place under the bar", async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links) => {
      for (const role of ROLES) {
        await withGuestPage(browser, DESKTOP, async (guest) => {
          await firstVisit(guest, links[role], role);
          const boxes = await hintBoxes(guest);
          const at = `${role} on desktop: note ${describeBox(boxes.note)}, header ${describeBox(boxes.header)}`;
          expect(boxes.note.h, at).toBeCloseTo(40, 1);
          expect(boxes.note.y - boxes.header.bottom, at).toBeCloseTo(7, 1);
          expect(boxes.note.x, at).toBeCloseTo(8, 1);
        });
      }
    });
  });
});

test.describe("keys and the first-visit role hint", () => {
  test("the next letter key closes it and still does its own job", async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, DESKTOP, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        await expect(
          guest.getByRole("button", { name: "Play", exact: true }).first(),
        ).toBeVisible();
        await guest.keyboard.press("l");
        await expect(guest.locator(NOTE)).toHaveCount(0);
        await expect(
          guest.getByRole("button", { name: "Pause" }).first(),
        ).toBeVisible();
        expect(await seenFlags(guest)).toEqual(["-", "1", "-"]);
      });
    });
  });

  test("Escape closes it", async ({ browser }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, DESKTOP, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        await guest.keyboard.press("Escape");
        await expect(guest.locator(NOTE)).toHaveCount(0);
        await expect(guest.getByRole("dialog")).toHaveCount(0);
        expect(await seenFlags(guest)).toEqual(["-", "1", "-"]);
      });
    });
  });

  test("a character typed into the composer lands and closes it", async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, DESKTOP, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        const composer = guest.locator("textarea").first();
        // Focus by script: a click would close the hint by its own press.
        await composer.focus();
        await guest.keyboard.type("h");
        await expect(guest.locator(NOTE)).toHaveCount(0);
        await expect(composer).toHaveValue("h");
      });
    });
  });

  test("Shift alone leaves it up, Tab reaches its X, and Enter on the X closes it and focuses the Role button", async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, DESKTOP, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        await guest.keyboard.press("Shift");
        await expect(guest.locator(NOTE)).toBeVisible();
        const close = guest.locator(NOTE).getByRole("button", {
          name: "Dismiss hint",
        });
        await guest.keyboard.press("Tab");
        await expect(close).toBeFocused();
        await expect(guest.locator(NOTE)).toBeVisible();
        await guest.keyboard.press("Enter");
        await expect(guest.locator(NOTE)).toHaveCount(0);
        await expect(
          guest.getByRole("button", { name: "Explain Commenter role" }),
        ).toBeFocused();
      });
    });
  });
});

test.describe("the first-visit role hint is said once", () => {
  /** Counts the times the sentence is put into a polite live region, from before the page's own scripts run. */
  async function listenForSentence(page: Page, sentence: string) {
    await page.addInitScript((said) => {
      const w = window as unknown as { __spoken: number };
      w.__spoken = 0;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (
              node instanceof HTMLElement &&
              node.textContent === said &&
              node.parentElement?.closest("[role=status]")
            ) {
              w.__spoken += 1;
            }
          }
        }
      }).observe(document, { subtree: true, childList: true });
    }, sentence);
  }
  const spoken = (page: Page) =>
    page.evaluate(() => (window as unknown as { __spoken: number }).__spoken);

  for (const size of [PHONE, DESKTOP]) {
    test(`goes once through the status region on a first visit at ${size.width}x${size.height}, and not again`, async ({
      browser,
    }) => {
      await withGuestLinks(browser, async (links) => {
        await withGuestPage(browser, size, async (guest) => {
          await listenForSentence(guest, SENTENCE.commenter);
          await firstVisit(guest, links.commenter, "commenter");
          expect(await spoken(guest)).toBe(1);
          await guest
            .locator(NOTE)
            .getByRole("button", { name: "Dismiss hint" })
            .click();
          await guest
            .getByRole("button", { name: "Explain Commenter role" })
            .click();
          await expect(guest.getByRole("dialog")).toBeVisible();
          await afterFrames(guest);
          expect(await spoken(guest)).toBe(1);
        });
      });
    });

    test(`is not said to a returning guest at ${size.width}x${size.height}`, async ({
      browser,
    }) => {
      await withGuestLinks(browser, async (links) => {
        await withGuestPage(
          browser,
          size,
          async (guest) => {
            await listenForSentence(guest, SENTENCE.commenter);
            await guest.goto(`/r/${links.commenter}`);
            await settle(guest, "commenter");
            await expect(guest.locator(NOTE)).toHaveCount(0);
            expect(await spoken(guest)).toBe(0);
          },
          { visit: "returning" },
        );
      });
    });
  }
});

test.describe("the first-visit role hint on a saved copy", () => {
  /** The page asks for the episode, and the device loses its connection while that request is out. */
  async function loseConnectionOnLoad(page: Page, token: string) {
    let asked = 0;
    let release: (route: Route) => void = () => {};
    const first = new Promise<Route>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/review/${token}/project`, async (route) => {
      asked += 1;
      if (asked === 1) return release(route);
      return route.abort("internetdisconnected");
    });
    await page.goto(`/r/${token}`);
    const held = await first;
    await page.context().setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await held.abort("internetdisconnected");
  }

  for (const size of [PHONE, DESKTOP]) {
    for (const role of ["commenter", "editor"] as const) {
      test(`shows a ${role} link opened without a connection no hint, and its own once the connection is back at ${size.width}x${size.height}`, async ({
        browser,
      }) => {
        await withGuestLinks(browser, async (links) => {
          await withGuestPage(browser, size, async (guest) => {
            await firstVisit(guest, links[role], role);
            await expect
              .poll(() => guestSavedCopy(guest, links[role]))
              .not.toBeNull();

            await loseConnectionOnLoad(guest, links[role]);
            await expect(guest.locator(".stage-frame--guest")).toBeVisible();
            await expect(
              guest.getByRole("button", { name: /^Explain .* role$/ }),
            ).toBeVisible();
            await expect(guest.getByRole("alert").first()).toContainText(
              /offline/i,
            );
            await afterFrames(guest);
            expect(
              await guest.locator(NOTE).allInnerTexts(),
              "the saved copy is read-only, so the link's role is not known and no sentence is said for it",
            ).toEqual([]);
            await guest.keyboard.press("Escape");
            expect(await seenFlags(guest)).toEqual(["-", "-", "-"]);

            await guest.unroute(`**/api/review/${links[role]}/project`);
            await guest.context().setOffline(false);
            await guest.goto(`/r/${links[role]}`);
            await expect(guest.locator(NOTE)).toHaveText(SENTENCE[role]);
            await guest
              .locator(NOTE)
              .getByRole("button", { name: "Dismiss hint" })
              .click();
            await expect(guest.locator(NOTE)).toHaveCount(0);
            expect(await seenFlags(guest)).toEqual([
              "-",
              role === "commenter" ? "1" : "-",
              role === "editor" ? "1" : "-",
            ]);
          });
        });
      });
    }
  }
});

test.describe("what a guest's first action does with the hint up", () => {
  test("a tap on a visible word closes it and seeks there", async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, PHONE, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        const before = (await untouched(guest)).elapsed;
        const word = await guest.evaluate(() => {
          for (const el of document.querySelectorAll(".sys-script-word")) {
            const b = el.getBoundingClientRect();
            const x = b.left + b.width / 2;
            const y = b.top + b.height / 2;
            const hit = document.elementFromPoint(x, y);
            if (
              b.top >= 60 &&
              b.bottom < window.innerHeight - 20 &&
              hit &&
              el.contains(hit)
            )
              return { x, y };
          }
          return null;
        });
        expect(word).not.toBeNull();
        await guest.touchscreen.tap(word!.x, word!.y);
        await expect(guest.locator(NOTE)).toHaveCount(0);
        await expect
          .poll(async () => (await untouched(guest)).elapsed)
          .not.toBe(before);
      });
    });
  });

  test("a tap on Play closes it and starts playback", async ({ browser }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, PHONE, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        await guest
          .getByRole("button", { name: "Play", exact: true })
          .first()
          .tap();
        await expect(guest.locator(NOTE)).toHaveCount(0);
        await expect(
          guest.getByRole("button", { name: "Pause" }).first(),
        ).toBeVisible();
      });
    });
  });

  test("a touch scroll of the transcript closes it and scrolls in the same gesture", async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links) => {
      await withGuestPage(browser, SHORT_PHONE, async (guest) => {
        await firstVisit(guest, links.commenter, "commenter");
        const cdp = await guest.context().newCDPSession(guest);
        const x = SHORT_PHONE.width / 2;
        const from = 300;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y: from }],
        });
        for (let step = 1; step <= 10; step += 1) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: from - 17 * step }],
          });
        }
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await cdp.detach();
        await expect(guest.locator(NOTE)).toHaveCount(0);
        await expect
          .poll(() =>
            guest.evaluate(
              () =>
                [
                  ...document.querySelectorAll<HTMLElement>(
                    ".sys-script-body, .sys-script",
                  ),
                ].find((el) => el.scrollHeight > el.clientHeight + 2)
                  ?.scrollTop ?? 0,
            ),
          )
          .toBeGreaterThan(0);
      });
    });
  });
});
