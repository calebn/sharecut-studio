import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { selectCommentCard } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

/**
 * A review link the host turns off while the guest has the episode open.
 * The page ends on the cover for a dead link after one confirming check, hands
 * back what the guest had typed, and never ends on any other answer.
 */

const SIZES = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "desktop", width: 1280, height: 800, touch: false },
] as const;
type Size = (typeof SIZES)[number];

const DEAD_TITLE = "This link doesn't open anything";
const DEAD_SENTENCE = "Ask the person who sent it for a new link.";
const ASLEEP_TITLE = "The host's computer is asleep";
const SERVER_WORDS = "invalid or revoked";
const SEEDED = "Cut candidate: long pause";
const COMMENT = "Typed before the link was turned off";
const REPLY = "A reply I had not sent yet";
const COPY_FAILED =
  "Couldn't copy. The text is selected, so you can copy it by hand.";

type Probe = {
  media: HTMLMediaElement[];
  contexts: BaseAudioContext[];
  serverWords: boolean;
};

/**
 * Runs in the page before it loads: remembers every media element that was
 * played and every audio context, and whether the server's own sentence for a
 * dead link was ever in the page's text.
 */
function watchSoundAndWords(words: string) {
  const probe: Probe = { media: [], contexts: [], serverWords: false };
  const scope = window as unknown as Record<string, unknown>;
  scope.__probe = probe;
  const play = Reflect.get(HTMLMediaElement.prototype, "play") as (
    this: HTMLMediaElement,
  ) => Promise<void>;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!probe.media.includes(this)) probe.media.push(this);
    return play.call(this);
  };
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const Native = scope[name] as typeof AudioContext | undefined;
    if (!Native) continue;
    scope[name] = new Proxy(Native, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget);
        probe.contexts.push(context);
        return context;
      },
    });
  }
  new MutationObserver(() => {
    if (document.body?.textContent?.includes(words)) probe.serverWords = true;
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

const soundNow = (page: Page) =>
  page.evaluate(() => {
    const probe = (window as unknown as { __probe: Probe }).__probe;
    return {
      playing: probe.media.filter((m) => !m.paused).length,
      contexts: probe.contexts.filter((c) => c.state === "running").length,
      elements: [...document.querySelectorAll("audio")].filter((a) => !a.paused)
        .length,
      session: navigator.mediaSession?.playbackState ?? "none",
    };
  });

const serverWordsSeen = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __probe: Probe }).__probe.serverWords,
  );

const savedCopy = (page: Page, token: string) =>
  page.evaluate(
    (key) =>
      new Promise<unknown>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const read = db
            .transaction("kv", "readonly")
            .objectStore("kv")
            .get(key);
          read.onsuccess = () => {
            db.close();
            resolve(read.result ?? null);
          };
          read.onerror = () => reject(read.error);
        };
      }),
    `snap:${token}`,
  );

async function press(button: Locator, size: Size) {
  if (size.touch) {
    await button.tap();
  } else {
    await button.click();
  }
}

type Link = { token: string; projectPath: string; host: Page };

async function revoke({ host, token, projectPath }: Link) {
  const ended = await host.request.post(`/api/shares/${token}/revoke`, {
    data: { path: projectPath },
  });
  expect(ended.ok(), await ended.text()).toBeTruthy();
}

/** A real share on the real server, opened by a guest on the studio. */
async function withOpenGuest(
  browser: Parameters<typeof withBrowserPages>[0],
  size: Size,
  run: (guest: Page, link: Link) => Promise<void>,
  options: { colorScheme?: "light" | "dark"; socketDown?: boolean } = {},
) {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          viewport: { width: size.width, height: size.height },
          hasTouch: size.touch,
          colorScheme: options.colorScheme ?? "light",
          permissions: ["clipboard-read", "clipboard-write"],
        },
      ],
      async ([host, guest]) => {
        await openHostShare(host!, projectPath);
        await postDocumentCommand(
          host!,
          "e2e-seed",
          "AddComment",
          { body: SEEDED, author: "Dee", timeline_start: 5 },
          projectPath,
        );
        const token = await createReviewShare(host!, projectPath, "commenter");
        await guest!.addInitScript(watchSoundAndWords, SERVER_WORDS);
        await guest!.clock.install();
        if (options.socketDown) {
          // Without the live connection the page asks the server on its own
          // every 1.5 seconds, which is what these scenarios answer.
          await guest!.routeWebSocket(/\/api\/review\/.*\/daw\/ws/, (ws) =>
            ws.close({ code: 1011, reason: "down" }),
          );
        }
        await openGuestShare(guest!, token);
        await guest!
          .getByRole("button", { name: "Dismiss hint" })
          .tap({ timeout: 1_000 })
          .catch(() => undefined);
        await run(guest!, { token, projectPath, host: host! });
      },
    );
  });
}

/** A guest whose live connection is down, so the page polls the server itself. */
const withPollingGuest = (
  browser: Parameters<typeof withBrowserPages>[0],
  size: Size,
  run: (guest: Page, link: Link) => Promise<void>,
) => withOpenGuest(browser, size, run, { socketDown: true });

const commentField = (guest: Page) =>
  guest.getByRole("textbox", { name: "Comment", exact: true });

async function typeComment(guest: Page, size: Size, text: string) {
  if (size.touch) {
    await guest.getByRole("button", { name: /^Comment at/ }).tap();
  }
  await commentField(guest).fill(text);
}

async function typeReply(guest: Page, size: Size, text: string) {
  if (size.touch) {
    await guest
      .getByRole("button", { name: /^Show\b.*\bcomments?/ })
      .tap({ timeout: 10_000 });
    const sheet = guest.getByRole("dialog", { name: "Comments" });
    await sheet.locator(".sys-queue-row").first().getByRole("button").tap();
    await guest.getByRole("textbox", { name: /^Reply to/ }).fill(text);
    await guest.getByRole("button", { name: "Back to comments" }).tap();
    await guest.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    return;
  }
  const card = await selectCommentCard(guest, SEEDED);
  await card.getByRole("textbox", { name: /^Reply/ }).fill(text);
}

async function startPlaying(guest: Page) {
  await expect
    .poll(async () => {
      if ((await soundNow(guest)).playing === 0) {
        await guest
          .getByRole("button", { name: "Play", exact: true })
          .click({ timeout: 2_000 })
          .catch(() => undefined);
      }
      return (await soundNow(guest)).playing;
    })
    .toBeGreaterThan(0);
}

const title = (guest: Page, name = DEAD_TITLE) =>
  guest.getByRole("heading", { name });

async function expectFocusOnTitle(guest: Page) {
  await expect
    .poll(() =>
      guest.evaluate(() => {
        const active = document.activeElement;
        return active ? `${active.tagName}:${active.textContent}` : "none";
      }),
    )
    .toBe(`H1:${DEAD_TITLE}`);
}

async function expectInViewport(guest: Page, target: Locator) {
  await expect
    .poll(async () => {
      const box = await target.boundingBox();
      const view = guest.viewportSize();
      if (!box || !view) return "no box";
      return box.y >= 0 &&
        box.y + box.height <= view.height &&
        box.x >= 0 &&
        box.x + box.width <= view.width
        ? "inside"
        : `${box.y}+${box.height} of ${view.height}`;
    })
    .toBe("inside");
}

/**
 * Moves the page's clock on in small steps until `count()` passes `above`. The
 * page asks again only after an answer arrives, so one long step would fire a
 * single request.
 */
async function advanceUntil(guest: Page, count: () => number, above: number) {
  await expect
    .poll(
      async () => {
        await guest.clock.runFor(2_000);
        return count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(above);
}

const CODED_DEAD = {
  status: 404,
  headers: {
    "content-type": "application/json",
    "x-sharecut-error-code": "share_not_found",
  },
  body: JSON.stringify({ detail: "invalid or revoked share token" }),
};

for (const size of SIZES) {
  test.describe(`a review link turned off while the episode is open at ${size.width}x${size.height}`, () => {
    test("the cover replaces the studio, the sound stops and what was typed is handed back", async ({
      browser,
    }) => {
      await withOpenGuest(browser, size, async (guest, link) => {
        await typeReply(guest, size, REPLY);
        await typeComment(guest, size, COMMENT);
        await startPlaying(guest);
        await expect.poll(() => savedCopy(guest, link.token)).not.toBeNull();

        await revoke(link);

        await expect(title(guest)).toBeVisible({ timeout: 30_000 });
        await expect(guest.getByText(DEAD_SENTENCE)).toBeVisible();
        await expectFocusOnTitle(guest);
        await expect(guest.locator(".stage-frame--guest")).toHaveCount(0);
        await expect
          .poll(() => soundNow(guest))
          .toEqual({ playing: 0, contexts: 0, elements: 0, session: "none" });

        const both = `Your comment:\n${COMMENT}\n\nYour reply:\n${REPLY}`;
        const block = guest.getByRole("textbox", {
          name: "These were not posted",
        });
        await expect(block).toHaveValue(both);
        await expect(block).toHaveJSProperty("readOnly", true);

        const asked: string[] = [];
        guest.on("request", (request) => {
          if (request.url().includes(`/api/review/${link.token}`)) {
            asked.push(request.url());
          }
        });
        const copy = guest.getByRole("button", { name: "Copy all" });
        await press(copy, size);
        await expect(guest.getByRole("status")).toHaveText("Copied");
        expect(await guest.evaluate(() => navigator.clipboard.readText())).toBe(
          both,
        );
        await expect(copy).toBeFocused();

        await guest.clock.runFor(120_000);
        expect(asked).toEqual([]);
        expect(await savedCopy(guest, link.token)).toBeNull();
        expect(await serverWordsSeen(guest)).toBe(false);
      });
    });

    test("pressing Post after the link was turned off never shows the server's sentence", async ({
      browser,
    }) => {
      await withOpenGuest(browser, size, async (guest, link) => {
        await typeComment(guest, size, COMMENT);
        // No page timer runs, so only the Post itself can tell the page.
        await guest.clock.pauseAt(new Date(Date.now() + 1_000));
        await revoke(link);
        await press(
          guest.getByRole("button", { name: "Post", exact: true }),
          size,
        );

        await expect(title(guest)).toBeVisible({ timeout: 30_000 });
        await expect(
          guest.getByRole("textbox", { name: "Your comment was not posted" }),
        ).toHaveValue(COMMENT);
        await expect(
          guest.getByRole("button", { name: "Copy your comment" }),
        ).toBeVisible();
        expect(await serverWordsSeen(guest)).toBe(false);
      });
    });

    test("one stray dead-link answer while the link is alive changes nothing", async ({
      browser,
    }) => {
      await withPollingGuest(browser, size, async (guest, link) => {
        await typeComment(guest, size, COMMENT);
        await startPlaying(guest);
        let strayed = false;
        let meta = 0;
        let rechecks = 0;
        await guest.route(`**/api/review/${link.token}/daw/meta`, (route) => {
          meta += 1;
          if (!strayed) {
            strayed = true;
            return route.fulfill(CODED_DEAD);
          }
          return route.continue();
        });
        await guest.route(`**/api/review/${link.token}/project`, (route) => {
          rechecks += 1;
          return route.continue();
        });

        await advanceUntil(guest, () => rechecks, 0);
        await advanceUntil(guest, () => meta, 4);

        await expect(guest.locator(".stage-frame--guest")).toBeVisible();
        await expect(title(guest)).toHaveCount(0);
        await expect(commentField(guest)).toHaveValue(COMMENT);
        expect((await soundNow(guest)).playing).toBeGreaterThan(0);
        expect(await serverWordsSeen(guest)).toBe(false);
      });
    });

    test("a busy host, a rate limit, an uncoded 404 and lost requests never end it", async ({
      browser,
    }) => {
      await withPollingGuest(browser, size, async (guest, link) => {
        await typeComment(guest, size, COMMENT);
        const answers = [
          {
            status: 503,
            headers: { "x-sharecut-error-code": "project_busy" },
            body: JSON.stringify({
              detail: "This project is busy; try again.",
            }),
          },
          { status: 429, headers: { "retry-after": "5" }, body: "slow down" },
          {
            status: 404,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ detail: "Not Found" }),
          },
          "abort",
          { status: 403, body: JSON.stringify({ detail: "no" }) },
          { status: 500, body: "boom" },
        ] as const;
        let meta = 0;
        await guest.route(`**/api/review/${link.token}/daw/meta`, (route) => {
          const answer = answers[meta % answers.length]!;
          meta += 1;
          return answer === "abort"
            ? route.abort("connectionrefused")
            : route.fulfill(answer);
        });

        await advanceUntil(guest, () => meta, 12);
        await expect(guest.locator(".stage-frame--guest")).toBeVisible();
        await expect(title(guest)).toHaveCount(0);
        await expect(commentField(guest)).toHaveValue(COMMENT);
      });
    });

    test("a dead-link answer the confirming check cannot confirm never ends it", async ({
      browser,
    }) => {
      await withPollingGuest(browser, size, async (guest, link) => {
        await typeComment(guest, size, COMMENT);
        let meta = 0;
        await guest.route(`**/api/review/${link.token}/daw/meta`, (route) => {
          meta += 1;
          return route.fulfill(CODED_DEAD);
        });
        const rechecks = [
          {
            status: 503,
            headers: { "x-sharecut-error-code": "project_busy" },
            body: "{}",
          },
          { status: 429, body: "slow down" },
          "abort",
          { status: 500, body: "boom" },
        ] as const;
        let asked = 0;
        await guest.route(`**/api/review/${link.token}/project`, (route) => {
          const answer = rechecks[asked % rechecks.length]!;
          asked += 1;
          return answer === "abort"
            ? route.abort("connectionrefused")
            : route.fulfill(answer);
        });

        await advanceUntil(guest, () => meta, 12);
        await expect(guest.locator(".stage-frame--guest")).toBeVisible();
        await expect(title(guest)).toHaveCount(0);
        await expect(commentField(guest)).toHaveValue(COMMENT);
      });
    });

    test("a long draft keeps its copy button on screen at 100% and 200% text", async ({
      browser,
    }) => {
      const draft = "A long thought about the second act. "
        .repeat(136)
        .slice(0, 5_000);
      await withOpenGuest(browser, size, async (guest, link) => {
        await typeComment(guest, size, draft);
        await revoke(link);
        await expect(title(guest)).toBeVisible({ timeout: 30_000 });

        const copy = guest.getByRole("button", { name: "Copy your comment" });
        const text = guest.getByRole("textbox", {
          name: "Your comment was not posted",
        });
        await expect(text).toHaveValue(draft);
        for (const scale of ["100%", "200%"]) {
          await guest.addStyleTag({ content: `html { font-size: ${scale} }` });
          await expectInViewport(guest, copy);
          await guest.evaluate(() =>
            window.scrollTo(0, document.documentElement.scrollHeight),
          );
          const button = await copy.boundingBox();
          const area = await text.boundingBox();
          expect(area!.y + area!.height).toBeLessThanOrEqual(button!.y + 0.5);
          if (size.touch) {
            expect(button!.height).toBeGreaterThanOrEqual(43.5);
          }
          const limits = await text.evaluate((el) => {
            const css = getComputedStyle(el);
            return {
              min: Number.parseFloat(css.minHeight),
              max: Number.parseFloat(css.maxHeight),
            };
          });
          expect(area!.height).toBeGreaterThan(limits.min * 2);
          expect(area!.height).toBeGreaterThanOrEqual(limits.max - 1);
          await text.scrollIntoViewIfNeeded();
          await expectInViewport(guest, text);
          await expectInViewport(guest, copy);
          if (!size.touch && scale === "100%") {
            expect(button!.height).toBeLessThan(48);
          }
        }
        expect(
          await guest.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(size.width);
      });
    });

    test("when the clipboard refuses, the text is selected and the status says so", async ({
      browser,
    }) => {
      await withOpenGuest(browser, size, async (guest, link) => {
        await guest.evaluate(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: () =>
                Promise.reject(new DOMException("no", "NotAllowedError")),
            },
          });
        });
        await typeComment(guest, size, COMMENT);
        await revoke(link);
        await expect(title(guest)).toBeVisible({ timeout: 30_000 });

        await press(
          guest.getByRole("button", { name: "Copy your comment" }),
          size,
        );
        const text = guest.getByRole("textbox", {
          name: "Your comment was not posted",
        });
        await expect(text).toBeFocused();
        await expect(guest.getByRole("status")).toHaveText(COPY_FAILED);
        expect(
          await text.evaluate((el: HTMLTextAreaElement) => [
            el.selectionStart,
            el.selectionEnd,
            el.value.length,
          ]),
        ).toEqual([0, COMMENT.length, COMMENT.length]);
      });
    });

    test("a reload after the end is the cover again and the saved copy does not open", async ({
      browser,
    }) => {
      await withOpenGuest(browser, size, async (guest, link) => {
        await expect.poll(() => savedCopy(guest, link.token)).not.toBeNull();
        await revoke(link);
        await expect(title(guest)).toBeVisible({ timeout: 30_000 });
        expect(await savedCopy(guest, link.token)).toBeNull();

        await guest.reload();
        await expect(title(guest)).toBeVisible();
        await expect(guest.getByText(DEAD_SENTENCE)).toBeVisible();
        await expect(guest.locator(".stage-frame--guest")).toHaveCount(0);
        await expect(
          guest.getByRole("textbox", { name: /not posted/ }),
        ).toHaveCount(0);
        expect(await savedCopy(guest, link.token)).toBeNull();
      });
    });

    test("with no unsent text the cover has no block, no button and no status", async ({
      browser,
    }) => {
      await withOpenGuest(browser, size, async (guest, link) => {
        await revoke(link);
        await expect(title(guest)).toBeVisible({ timeout: 30_000 });
        await expect(guest.getByRole("main").getByRole("button")).toHaveCount(
          0,
        );
        await expect(guest.getByRole("textbox")).toHaveCount(0);
        await expect(guest.getByRole("status")).toHaveCount(0);
      });
    });

    test("a saved copy that cannot be read after a failed load ends on the cover, not on Home", async ({
      browser,
    }) => {
      await withShareableProject(async (projectPath) => {
        await withBrowserPages(
          browser,
          [
            {},
            {
              viewport: { width: size.width, height: size.height },
              hasTouch: size.touch,
            },
          ],
          async ([host, guest]) => {
            await openHostShare(host!, projectPath);
            const token = await createReviewShare(
              host!,
              projectPath,
              "commenter",
            );
            await guest!.addInitScript(() => {
              Object.defineProperty(indexedDB, "open", {
                value() {
                  throw new DOMException("denied", "SecurityError");
                },
              });
            });
            await guest!.route(`**/api/review/${token}/project`, (route) =>
              route.abort("connectionrefused"),
            );
            await guest!.goto(`/r/${token}`);
            await expect(title(guest!, ASLEEP_TITLE)).toBeVisible();
            await expect(
              guest!.getByRole("button", { name: "Import audio" }),
            ).toHaveCount(0);
          },
        );
      });
    });
  });
}

test.describe("the cover with unsent text in the dark theme", () => {
  test("shows the block and the button on the dark page", async ({
    browser,
  }) => {
    const size = SIZES[0];
    await withOpenGuest(
      browser,
      size,
      async (guest, link) => {
        await typeComment(guest, size, COMMENT);
        await revoke(link);
        await expect(title(guest)).toBeVisible({ timeout: 30_000 });
        await expect(
          guest.getByRole("button", { name: "Copy your comment" }),
        ).toBeVisible();
        expect(
          await guest.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          ),
        ).not.toBe("rgb(255, 255, 255)");
      },
      { colorScheme: "dark" },
    );
  });
});
