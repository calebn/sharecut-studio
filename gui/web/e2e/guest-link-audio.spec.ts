import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  DEAD_TITLE,
  loseConnectionOnLoad,
  revokeLink,
  SIZES,
  withSharedProject,
} from "./guestLink";
import {
  guestLinkAudio,
  guestSavedCopy,
  SHARED_AUDIO_CACHE,
} from "./offlineQueue";
import { playButton } from "./playback";
import { openGuestShare } from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

/**
 * What a guest's browser keeps of the audio it played through a review link:
 * it stays while the link is alive, and goes when the link ends.
 */

const PHONE = SIZES[0];
/** The fixture is one minute long, one chunk a track, two tracks. */
const CHUNKS = 2;
const CHUNK_PATH = /\/daw\/proxy\/[^/]+\/[^/]+\/\d+$/;

const isChunk = (url: string) => CHUNK_PATH.test(new URL(url).pathname);

type Links = {
  host: Page;
  guest: Page;
  projectPath: string;
  tokens: string[];
};

async function withLinks(
  browser: Parameters<typeof withBrowserPages>[0],
  count: number,
  run: (links: Links) => Promise<void>,
  guestOptions: { init?: () => void } = {},
) {
  await withSharedProject(
    browser,
    [{ viewport: PHONE, hasTouch: PHONE.touch }],
    ["commenter", "editor"].slice(0, count) as ("commenter" | "editor")[],
    async ([host, guest], links, projectPath) => {
      if (guestOptions.init) await guest!.addInitScript(guestOptions.init);
      // The page's own clock is stepped to reach the cover without waiting
      // out the page's 30 second poll.
      await guest!.clock.install();
      await run({
        host: host!,
        guest: guest!,
        projectPath,
        tokens: Object.values(links),
      });
    },
  );
}

function countChunkRequests(page: Page) {
  const seen = { started: 0, finished: 0 };
  page.on("request", (request) => {
    if (isChunk(request.url())) seen.started += 1;
  });
  page.on("requestfinished", (request) => {
    if (isChunk(request.url())) seen.finished += 1;
  });
  return seen;
}

async function dismissHint(page: Page) {
  await page
    .getByRole("button", { name: "Dismiss hint" })
    .tap({ timeout: 1_000 })
    .catch(() => undefined);
}

async function open(page: Page, token: string) {
  await openGuestShare(page, token);
  await dismissHint(page);
}

/** Presses Play until every chunk of the episode is in the link's cache, then pauses. */
async function playUntilKept(page: Page, token: string) {
  const play = playButton(page);
  await expect
    .poll(
      async () => {
        const kept = (await guestLinkAudio(page, token)).entries;
        if (kept === 0 && (await play.isVisible()))
          await play.click({ timeout: 2_000 }).catch(() => undefined);
        return kept;
      },
      { timeout: 40_000 },
    )
    .toBe(CHUNKS);
  await pause(page);
}

async function pause(page: Page) {
  await page
    .getByRole("button", { name: "Pause", exact: true })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
}

/**
 * Remembers every audio context the page makes, from before its scripts run;
 * `advanced()` is true once one is running and its clock has moved on.
 */
async function audioClocks(page: Page) {
  await page.addInitScript(() => {
    const scope = window as unknown as Record<string, unknown>;
    const made: BaseAudioContext[] = [];
    scope.__contexts = made;
    for (const name of ["AudioContext", "webkitAudioContext"]) {
      const Native = scope[name] as typeof AudioContext | undefined;
      if (!Native) continue;
      scope[name] = new Proxy(Native, {
        construct(target, args, newTarget) {
          const context = Reflect.construct(target, args, newTarget);
          made.push(context);
          return context;
        },
      });
    }
  });
  return {
    advanced: () =>
      page.evaluate(() =>
        (
          (window as unknown as { __contexts?: BaseAudioContext[] })
            .__contexts ?? []
        ).some((c) => c.state === "running" && c.currentTime > 0.5),
      ),
  };
}

const cover = (page: Page) => page.getByRole("heading", { name: DEAD_TITLE });

/** Steps the page's clock until the confirming check has put the cover up. */
async function untilCover(page: Page) {
  await expect
    .poll(
      async () => {
        await page.clock.runFor(2_000);
        return cover(page).isVisible();
      },
      { timeout: 90_000 },
    )
    .toBe(true);
}

/** Nothing of this link is left on the device, in either cache. */
async function expectNothingKept(page: Page, token: string) {
  await expect
    .poll(async () => {
      const kept = await guestLinkAudio(page, token);
      return [kept.entries, kept.shared];
    })
    .toEqual([0, 0]);
}

test.setTimeout(240_000);

test("a link turned off while open gives up its audio, and nothing comes back", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ host, guest, projectPath, tokens }) => {
    const [token] = tokens as [string];
    await open(guest, token);
    await playUntilKept(guest, token);

    await revokeLink(host, token, projectPath);
    await untilCover(guest);

    await expectNothingKept(guest, token);
    await guest.clock.runFor(5_000);
    expect(await guestLinkAudio(guest, token)).toMatchObject({
      entries: 0,
      shared: 0,
    });
  });
});

test("a link opened after it was turned off gives up the audio kept earlier", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ host, guest, projectPath, tokens }) => {
    const [token] = tokens as [string];
    await open(guest, token);
    await playUntilKept(guest, token);

    await guest.goto("/");
    await revokeLink(host, token, projectPath);
    await guest.goto(`/r/${token}`);

    await expect(cover(guest)).toBeVisible();
    await expectNothingKept(guest, token);
  });
});

test("a chunk still on its way when the link ends is not kept, and none is asked for after the cover", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ host, guest, projectPath, tokens }) => {
    const [token] = tokens as [string];
    let letThrough: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letThrough = resolve;
    });
    const held: Route[] = [];
    let delivered = 0;
    await guest.route(`**/api/review/${token}/daw/proxy/**`, async (route) => {
      if (!isChunk(route.request().url())) return route.fallback();
      // Answered by the real server now, delivered to the page later.
      const real = await route.fetch();
      held.push(route);
      await gate;
      delivered += 1;
      return route.fulfill({ response: real });
    });
    const chunks = countChunkRequests(guest);
    await open(guest, token);
    const play = playButton(guest);
    await expect
      .poll(async () => {
        if (held.length === 0 && (await play.isVisible()))
          await play.click({ timeout: 2_000 }).catch(() => undefined);
        return held.length;
      })
      .toBeGreaterThan(0);

    await revokeLink(host, token, projectPath);
    await untilCover(guest);
    const startedAtCover = chunks.started;
    const finishedAtCover = chunks.finished;

    letThrough();
    await expect.poll(() => delivered).toBe(held.length);
    await expect.poll(() => chunks.finished).toBeGreaterThan(finishedAtCover);
    await guest.clock.runFor(5_000);

    await expectNothingKept(guest, token);
    expect(chunks.started).toBe(startedAtCover);
  });
});

test("turning one link off leaves the audio kept through another link", async ({
  browser,
}) => {
  await withLinks(browser, 2, async ({ host, guest, projectPath, tokens }) => {
    const [ending, living] = tokens as [string, string];
    const other = await guest.context().newPage();
    await open(guest, ending);
    await open(other, living);
    await playUntilKept(guest, ending);
    await playUntilKept(other, living);
    const before = await guestLinkAudio(other, living);

    await revokeLink(host, ending, projectPath);
    await untilCover(guest);

    await expectNothingKept(guest, ending);
    expect(await guestLinkAudio(other, living)).toMatchObject({
      entries: before.entries,
      bytes: before.bytes,
    });
  });
});

test("a live link replays from the device without asking the server again", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ guest, tokens }) => {
    const [token] = tokens as [string];
    await open(guest, token);
    await playUntilKept(guest, token);
    const kept = await guestLinkAudio(guest, token);

    const chunks = countChunkRequests(guest);
    await guest.reload();
    await expect(guest.locator(".stage-frame--guest")).toBeVisible();
    await dismissHint(guest);
    await playButton(guest).click();
    await expect(
      guest.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    expect(chunks.started).toBe(0);
    expect(await guestLinkAudio(guest, token)).toMatchObject({
      entries: kept.entries,
      bytes: kept.bytes,
    });
  });
});

test("a live link's kept audio plays from the saved copy when the connection is lost on load", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ guest, tokens }) => {
    const [token] = tokens as [string];
    const clock = await audioClocks(guest);
    await open(guest, token);
    await playUntilKept(guest, token);
    await expect.poll(() => guestSavedCopy(guest, token)).not.toBeNull();

    await loseConnectionOnLoad(guest, token);
    await expect(guest.locator(".stage-frame--guest")).toBeVisible();
    await dismissHint(guest);
    const chunks = countChunkRequests(guest);
    await playButton(guest).click();

    await expect.poll(() => clock.advanced()).toBe(true);
    expect(chunks.started).toBe(0);
    await expect(guest.getByText(/audio error/i)).toHaveCount(0);
  });
});

test("a chunk is answered private, no-store, and the server refuses a dead link's chunk", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ host, guest, projectPath, tokens }) => {
    const [token] = tokens as [string];
    let chunkUrl = "";
    let cacheControl: string | null = null;
    guest.on("response", (response) => {
      if (chunkUrl === "" && isChunk(response.url())) {
        chunkUrl = response.url();
        cacheControl = response.headers()["cache-control"] ?? null;
      }
    });
    await open(guest, token);
    await playUntilKept(guest, token);
    expect(cacheControl).toBe("private, no-store");

    await revokeLink(host, token, projectPath);
    await untilCover(guest);

    // A failure here would print the address, which holds the token.
    const answer = await guest.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        return {
          status: res.status,
          code: res.headers.get("x-sharecut-error-code"),
        };
      } catch {
        return { status: 0, code: null };
      }
    }, chunkUrl);
    expect(answer).toEqual({ status: 404, code: "share_not_found" });
  });
});

test("a browser whose cache rejects still plays a live link and still shows the cover when it ends", async ({
  browser,
}) => {
  const refuse = () => {
    const refusal = () =>
      Promise.reject(new DOMException("blocked", "SecurityError"));
    CacheStorage.prototype.open = refusal;
    CacheStorage.prototype.delete = refusal;
  };
  await withLinks(
    browser,
    1,
    async ({ host, guest, projectPath, tokens }) => {
      const [token] = tokens as [string];
      const errors: string[] = [];
      // A line that names the link must never reach a failure message.
      const redact = (text: string) => text.split(token).join("<token>");
      guest.on("pageerror", (error) => errors.push(redact(error.message)));
      guest.on("console", (message) => {
        // The browser itself reports every 404 the ended link answers.
        if (
          message.type() === "error" &&
          !message.text().startsWith("Failed to load resource")
        )
          errors.push(redact(message.text()));
      });
      const chunks = countChunkRequests(guest);
      const clock = await audioClocks(guest);
      await open(guest, token);
      await playButton(guest).click();
      await expect(
        guest.getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(guest.getByText(/audio error/i)).toHaveCount(0);
      // The audio was fetched and played, not only shown as playing.
      await expect.poll(() => chunks.finished).toBeGreaterThan(0);
      await expect.poll(() => clock.advanced()).toBe(true);

      await revokeLink(host, token, projectPath);
      await untilCover(guest);

      expect(errors).toEqual([]);
    },
    { init: refuse },
  );
});

test("the old cache every link shared is removed the first time a link's audio is fetched", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ guest, tokens }) => {
    const [token] = tokens as [string];
    await open(guest, token);
    await guest.evaluate(async (name) => {
      const cache = await caches.open(name);
      await cache.put("/old-audio", new Response("old"));
    }, SHARED_AUDIO_CACHE);
    expect((await guestLinkAudio(guest, token)).shared).toBe(1);

    await playUntilKept(guest, token);

    await expect
      .poll(async () => (await guestLinkAudio(guest, token)).shared)
      .toBe(0);
  });
});

test("a link keeps only the audio its current version names", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ guest, projectPath, tokens }) => {
    const [token] = tokens as [string];
    const hashes = async () =>
      (
        (await (
          await guest.request.get(`/api/review/${token}/daw/proxy/manifest`)
        ).json()) as { tracks: Record<string, { hash: string }> }
      ).tracks;
    await open(guest, token);
    await playUntilKept(guest, token);
    const before = await hashes();

    // A few bytes of every recording change, which re-renders the episode.
    const folder = path.dirname(projectPath);
    for (const sub of ["raw", "sources"]) {
      if (!fs.existsSync(path.join(folder, sub))) continue;
      for (const name of fs.readdirSync(path.join(folder, sub))) {
        if (!name.endsWith(".wav")) continue;
        const handle = fs.openSync(path.join(folder, sub, name), "r+");
        fs.writeSync(handle, Buffer.alloc(64, 0x55), 0, 64, 20_000);
        fs.closeSync(handle);
      }
    }
    const after = await hashes();
    expect(Object.values(after).map((t) => t.hash)).not.toEqual(
      Object.values(before).map((t) => t.hash),
    );

    await guest.reload();
    await expect(guest.locator(".stage-frame--guest")).toBeVisible();
    await dismissHint(guest);
    await expect
      .poll(async () => (await guestLinkAudio(guest, token)).entries)
      .toBe(0);
    await playUntilKept(guest, token);
  });
});
