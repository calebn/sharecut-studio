import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import {
  DEAD_TITLE,
  loseConnectionOnLoad,
  revokeLink,
  SIZES,
  withSharedProject,
} from "./guestLink";
import { hostEdit } from "./guestTranscript";
import { createRelocatedE2eProject } from "./liveProject";
import {
  guestLinkAudio,
  guestSavedCopy,
  SHARED_AUDIO_CACHE,
} from "./offlineQueue";
import { playButton } from "./playback";
import { silenceWav, withShareableProject } from "./shareableProject";
import { createReviewShare, openGuestShare } from "./shareNavigation";
import { parseTimecodeSec } from "./timecode";
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

test("a guest sees an audio-load error and can retry after a failed chunk request", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ guest, tokens }) => {
    const [token] = tokens as [string];
    const chunks = countChunkRequests(guest);
    const clock = await audioClocks(guest);
    let blocked = true;
    await guest.route(
      (url) => isChunk(url.href),
      (route) => (blocked ? route.abort("failed") : route.continue()),
    );
    await open(guest, token);
    await playButton(guest).click();

    const retry = guest.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    const pill = guest.locator(".sys-player-pill.sys-pill--danger");
    await expect(pill).toHaveAttribute("title", "Audio failed to load");
    await expect(pill).toHaveText("Audio failed to load");
    expect(chunks.started).toBeGreaterThan(0);

    blocked = false;
    await retry.click();
    await expect(pill).toHaveCount(0);
    await expect(
      guest.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await expect.poll(() => chunks.finished).toBeGreaterThan(0);
    await expect.poll(() => clock.advanced()).toBe(true);
    await expect(pill).toHaveCount(0);
  });
});

const LONG_EPISODE_SEC = 320;

function longGuestEpisode(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = JSON.parse(fs.readFileSync(fixture.projectPath, "utf8")) as {
    timeline: {
      tracks: { media: { path: string; duration_sec: number } }[];
      clips: { source_end: number }[];
      duration_sec: number;
    };
  };
  const audio = silenceWav(LONG_EPISODE_SEC);
  for (let frame = 0; frame < LONG_EPISODE_SEC * 48_000; frame++) {
    const sample = Math.sin((2 * Math.PI * 220 * frame) / 48_000);
    audio.writeInt16LE(Math.round(1_300 * sample), 44 + 2 * frame);
  }
  for (const track of project.timeline.tracks) {
    track.media.duration_sec = LONG_EPISODE_SEC;
    fs.writeFileSync(path.join(fixture.workspaceDir, track.media.path), audio);
  }
  for (const clip of project.timeline.clips) clip.source_end = LONG_EPISODE_SEC;
  project.timeline.duration_sec = LONG_EPISODE_SEC;
  fs.writeFileSync(fixture.projectPath, JSON.stringify(project));
  return fixture;
}

test("guest playback survives a ten-second chunk outage mid-listen", async ({
  page: host,
  browser,
}) => {
  test.setTimeout(120_000);
  await withShareableProject(
    async (projectPath) => {
      const token = await createReviewShare(host, projectPath, "viewer");
      const guest = await browser.newPage({
        viewport: { width: 1_440, height: 900 },
      });
      try {
        const extensionChunk = /\/daw\/proxy\/reference\/[^/]+\/3$/;
        const matches = (url: URL) => extensionChunk.test(url.pathname);
        const outageMs = 10_000;
        let outageStart: number | undefined;
        let failures = 0;
        let recovered = false;
        guest.on("response", (response) => {
          if (matches(new URL(response.url())) && response.ok())
            recovered = true;
        });
        await guest.route(matches, (route) => {
          const now = performance.now();
          outageStart ??= now;
          if (now - outageStart >= outageMs) return route.continue();
          failures++;
          return route.fulfill({ status: 503, body: "temporary chunk outage" });
        });
        await open(guest, token);
        const pause = guest.getByRole("button", { name: "Pause", exact: true });
        const clock = guest.locator(
          ".stage-frame-player .sys-player-now, .sys-player--expanded .sys-player-now",
        );
        const played = async () => parseTimecodeSec(await clock.innerText());
        await playButton(guest).click();
        await expect(pause).toBeVisible();
        await expect.poll(played).toBeGreaterThan(1);
        await guest.keyboard.press("l");
        await guest.keyboard.press("l");
        await expect(guest.getByLabel("Playback speed 4×")).toBeVisible();

        await expect
          .poll(() => failures, { timeout: 30_000 })
          .toBeGreaterThan(0);
        const atOutage = await played();
        expect(atOutage).toBeGreaterThan(0);
        await expect
          .poll(
            async () => {
              const time = await played();
              return {
                advanced: time > atOutage + 8,
                stillBlocked:
                  outageStart !== undefined &&
                  performance.now() - outageStart < outageMs &&
                  !recovered,
              };
            },
            { timeout: 8_000 },
          )
          .toEqual({ advanced: true, stillBlocked: true });
        await expect(pause).toBeVisible();
        await expect.poll(() => recovered).toBe(true);
        expect(failures).toBeGreaterThan(1);
        // Chunk 3 begins at 180 s. Playback must cross into the recovered audio.
        await expect.poll(played, { timeout: 50_000 }).toBeGreaterThan(185);
        await expect(pause).toBeVisible();
        await expect(
          guest.getByRole("button", { name: "Retry", exact: true }),
        ).toHaveCount(0);
      } finally {
        await guest.close();
      }
    },
    undefined,
    longGuestEpisode,
  );
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

test("guest playback waits for proxy hashes and recovers from a matching snapshot", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ guest, tokens }) => {
    const [token] = tokens as [string];
    const chunks = countChunkRequests(guest);
    const clock = await audioClocks(guest);
    const snapshotPath = `/api/review/${token}/daw/document/state`;
    let omitHashes = true;
    let snapshotsWithoutHashes = 0;
    // Exercise HTTP recovery with the older snapshot shape. A live socket
    // would otherwise immediately supply the current server's complete state.
    await guest.routeWebSocket(/\/daw\/ws(?:\?|$)/, () => undefined);
    await guest.route(
      (url) => url.pathname === snapshotPath,
      async (route) => {
        if (!omitHashes) return route.continue();
        const response = await route.fetch();
        const json = await response.json();
        if (json.project?.render_status?.proxy_hashes) {
          delete json.project.render_status.proxy_hashes;
          snapshotsWithoutHashes++;
        }
        await route.fulfill({ response, json });
      },
    );
    await open(guest, token);
    await expect.poll(() => snapshotsWithoutHashes).toBeGreaterThan(0);
    const retry = guest.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    expect(chunks.started).toBe(0);

    omitHashes = false;
    const recovered = guest.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === snapshotPath && response.ok(),
    );
    await retry.click();
    expect(
      (await (await recovered).json()).project.render_status.proxy_hashes,
    ).toBeDefined();
    await expect.poll(() => chunks.finished).toBeGreaterThan(0);
    await expect.poll(() => clock.advanced()).toBe(true);
    await expect(retry).toHaveCount(0);
  });
});

test("a guest manifest keeps its revision through comment-only saves", async ({
  browser,
}) => {
  await withLinks(browser, 1, async ({ host, guest, projectPath, tokens }) => {
    const [token] = tokens as [string];
    const manifest = async () => {
      const response = await guest.request.get(
        `/api/review/${token}/daw/proxy/manifest`,
      );
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()) as {
        revision: string;
        tracks: Record<string, { hash: string; urls: string[] }>;
      };
    };
    await open(guest, token);
    const before = await manifest();
    expect(before.revision).toMatch(/^[a-f0-9]{64}$/);
    const tracks = Object.values(before.tracks);
    expect(tracks).not.toHaveLength(0);
    for (const note of ["First note", "Second note"]) {
      await postDocumentCommand(
        host,
        "e2e-manifest-comments",
        "AddComment",
        { body: note, author: "Host", timeline_start: 5 },
        projectPath,
      );
      const after = await manifest();
      expect(after.tracks).toEqual(before.tracks);
      expect(after.revision).toBe(before.revision);
    }
    const chunk = await guest.request.get(tracks[0].urls[0]);
    expect(chunk.ok(), `Audio chunk returned ${chunk.status()}`).toBe(true);
    expect((await chunk.body()).byteLength).toBeGreaterThan(0);

    await hostEdit(host, projectPath, "cut", 0);
    expect((await manifest()).revision).not.toBe(before.revision);
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
