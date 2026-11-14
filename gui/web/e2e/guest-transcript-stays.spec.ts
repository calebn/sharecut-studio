import { randomUUID } from "node:crypto";
import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openGuestShare } from "./shareNavigation";
import { parseTimecodeSec } from "./timecode";

/**
 * A guest reading the transcript keeps its words on screen while the host
 * edits. The host edit is a real document command posted to the host API; the
 * guest receives it as a word-free delta over the review socket and then
 * refetches the word detail. A frame watcher records every animation frame and
 * DOM mutation so a gap of a few milliseconds cannot slip between polls.
 */

const SCRIPT = ".stage-host-guest-script";
const SECTION = `${SCRIPT} .sys-script`;
const BODY = `${SCRIPT} .sys-script-body`;
const WORD = `${SCRIPT} .sys-script-word`;
const DETAIL = /\/daw\/document\/state\?phase=detail/;
const REASON = "Refreshing the transcript. Try again in a moment.";
const WIDE = { width: 1280, height: 800, phone: false } as const;
const SIZES = [{ width: 390, height: 844, phone: true }, WIDE] as const;
const ROLES = ["viewer", "commenter"] as const;
/** A phone short enough that the fixture's few lines overflow the Script. */
const SHORT_PHONE = { width: 320, height: 568, phone: true } as const;

type Size = { width: number; height: number; phone: boolean };
type Role = (typeof ROLES)[number];

type Frame = {
  t: number;
  skeleton: boolean;
  words: number;
  busy: boolean;
  /** The Script section is the element the watcher found when it started. */
  same: boolean;
  hostSame: boolean;
  /** The failure cover that replaces the Script when the detail cannot be had. */
  cover: boolean;
  scrollTop: number | null;
  /** The watched word's distance from the top of the Script body, if it is drawn. */
  offset: number | null;
  shape: string;
};
type Watched = Window & {
  __scriptFrames: Frame[];
  __stopScriptWatch: () => void;
  __scriptSection: Element | null;
  __scriptHost: Element | null;
};

function watcher(anchorKey: string | null): string {
  return `(() => {
  const SCRIPT = ${JSON.stringify(SCRIPT)};
  const ANCHOR = ${JSON.stringify(anchorKey)};
  const frames = [];
  window.__scriptFrames = frames;
  window.__scriptSection = document.querySelector(${JSON.stringify(SECTION)});
  window.__scriptHost = document.querySelector(SCRIPT);
  const describe = (list) =>
    [...list]
      .slice(0, 8)
      .map((e) => e.tagName.toLowerCase() + "." + String(e.className).split(" ").join("."))
      .join(" , ");
  const sample = () => {
    const root = document.querySelector(SCRIPT);
    const body = root && root.querySelector(".sys-script-body");
    const section = root && root.querySelector(".sys-script");
    const words = root ? root.querySelectorAll(".sys-script-word").length : 0;
    // The anchor is a place in a line, "line id|nth word": a cut renumbers words.
    const [turnId, nth] = ANCHOR ? ANCHOR.split("|") : [];
    const turn = body
      ? [...body.querySelectorAll("[data-turn-id]")].find((e) => e.getAttribute("data-turn-id") === turnId)
      : null;
    const turnWords = turn ? [...turn.querySelectorAll("[data-word-key]")] : [];
    const anchor = turnWords.length ? turnWords[Math.min(Number(nth), turnWords.length - 1)] : null;
    frames.push({
      t: performance.timeOrigin + performance.now(),
      skeleton: !!(root ? root.querySelector(".sys-skeleton") : document.querySelector(".sys-skeleton")),
      words,
      busy: !!section && section.getAttribute("aria-busy") === "true",
      same: !!section && section === window.__scriptSection,
      hostSame: !!root && root === window.__scriptHost,
      cover: !!document.querySelector("[role='alert']"),
      scrollTop: body ? body.scrollTop : null,
      offset: anchor && body ? anchor.getBoundingClientRect().top - body.getBoundingClientRect().top : null,
      shape: words
        ? ""
        : root
          ? describe(root.querySelectorAll("*"))
          : "no Script host; document has: " +
            describe(document.querySelectorAll("#root [class*='stage-frame'], #root [class*='skeleton']")),
    });
  };
  let alive = true;
  const loop = () => {
    if (!alive) return;
    sample();
    requestAnimationFrame(loop);
  };
  const observer = new MutationObserver(sample);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  requestAnimationFrame(loop);
  window.__stopScriptWatch = () => {
    alive = false;
    observer.disconnect();
  };
})();`;
}

const redact = (url: string) =>
  url.replace(/\/api\/review\/[^/]+/, "/api/review/<token>");

/** Request log kept only to explain a failure; the token never reaches it. */
function logGuestRequests(page: Page): string[] {
  const rows: string[] = [];
  const started = Date.now();
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.includes("/api/review/")) return;
    rows.push(
      `+${Date.now() - started}ms ${response.request().method()} ${redact(url.pathname + url.search)} -> ${response.status()}`,
    );
  });
  return rows;
}

/** What the word-detail response does, set by the test while it runs. */
type Detail = { delayMs: number; status: number | null };

type Guest = {
  page: Page;
  projectPath: string;
  detail: Detail;
  log: string[];
};

async function withGuest(
  browser: Browser,
  host: Page,
  { role, size }: { role: Role; size: Size },
  run: (guest: Guest) => Promise<void>,
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    const token = await createReviewShare(host, projectPath, role);
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.phone,
      isMobile: size.phone,
    });
    try {
      const page = await context.newPage();
      const detail: Detail = { delayMs: 0, status: null };
      await page.route(DETAIL, async (route) => {
        if (detail.delayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, detail.delayMs));
        if (detail.status !== null)
          await route.fulfill({ status: detail.status, body: "{}" });
        else await route.continue();
      });
      const log = logGuestRequests(page);
      await openGuestShare(page, token);
      await expect(page.locator(WORD).first()).toBeVisible({ timeout: 20_000 });
      // Let the first detail hydrate and any follow-up settle.
      await page.waitForTimeout(800);
      await run({ page, projectPath, detail, log });
    } finally {
      await context.close();
    }
  });
}

type Edit = "cut" | "correct";

async function hostEdit(
  host: Page,
  projectPath: string,
  edit: Edit,
  step: number,
): Promise<void> {
  const client = `e2e-3797-${randomUUID()}`;
  await host.request.post("/api/transcript/refine/waive", {
    data: { path: projectPath, reason: "e2e guest transcript stays" },
  });
  if (edit === "cut") {
    await postDocumentCommand(
      host,
      client,
      "CutRange",
      { mode: "ripple", start: 5 + step * 12, end: 10 + step * 12 },
      projectPath,
    );
    return;
  }
  const response = await host.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    transcript: {
      utterances: {
        track_id: string;
        source_id?: string | null;
        words?: { text: string; word_index: number }[];
      }[];
    };
  };
  const row = body.transcript.utterances.find(
    (u) => (u.words?.length ?? 0) > 3,
  );
  const word = row?.words?.[2];
  if (!row || !word) throw new Error("the fixture has no row to correct");
  await postDocumentCommand(
    host,
    client,
    "CorrectTranscriptWord",
    {
      track_id: row.track_id,
      ...(row.source_id ? { source_id: row.source_id } : {}),
      word_index: word.word_index,
      text: `${word.text}!`,
    },
    projectPath,
  );
}

async function startWatch(page: Page, anchorKey: string | null = null) {
  await page.evaluate(watcher(anchorKey));
  return { from: Date.now() };
}

async function stopWatch(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const watched = window as unknown as Watched;
    watched.__stopScriptWatch();
    return watched.__scriptFrames;
  });
}

const blank = (f: Frame) => f.skeleton || (f.words === 0 && !f.cover);

function expectNoBlankFrame(
  frames: Frame[],
  from: number,
  log: string[],
  what: string,
) {
  const bad = frames.filter((f) => f.t >= from && blank(f));
  const first = bad[0];
  const around = first
    ? frames
        .slice(
          Math.max(0, frames.indexOf(first) - 2),
          frames.indexOf(first) + 4,
        )
        .map(
          (f) =>
            `  +${(f.t - from).toFixed(1)}ms skeleton=${f.skeleton} words=${f.words} ${f.shape}`,
        )
        .join("\n")
    : "";
  expect(
    bad.length,
    `the Script showed its skeleton or no words in ${bad.length} frame(s) ${what}.\n${around}\nGuest requests:\n${log.join("\n")}`,
  ).toBe(0);
}

/** Make the edits back to back and let the guest settle, then report what the watcher saw. */
async function frames(
  guest: Guest,
  host: Page,
  edit: Edit,
  edits: number,
  anchorKey: string | null = null,
) {
  const { from } = await startWatch(guest.page, anchorKey);
  const detail = guest.page
    .waitForResponse((r) => DETAIL.test(r.url()), { timeout: 15_000 })
    .catch(() => null);
  for (let n = 0; n < edits; n += 1) {
    await hostEdit(host, guest.projectPath, edit, n);
  }
  await detail;
  await guest.page.waitForTimeout(800);
  return { frames: await stopWatch(guest.page), from };
}

for (const role of ROLES) {
  for (const size of SIZES) {
    test(`a ${role} at ${size.width}x${size.height} keeps the transcript on screen through a host cut`, async ({
      browser,
      page,
    }) => {
      await withGuest(browser, page, { role, size }, async (guest) => {
        const seen = await frames(guest, page, "cut", 1);
        expectNoBlankFrame(
          seen.frames,
          seen.from,
          guest.log,
          "after a host cut",
        );
      });
    });
  }
}

test("a commenter keeps the transcript on screen through a host correction", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "commenter", size: WIDE },
    async (guest) => {
      const seen = await frames(guest, page, "correct", 1);
      expectNoBlankFrame(
        seen.frames,
        seen.from,
        guest.log,
        "after a host correction",
      );
    },
  );
});

test("a commenter keeps the transcript on screen through two quick host cuts", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "commenter", size: WIDE },
    async (guest) => {
      const seen = await frames(guest, page, "cut", 2);
      expectNoBlankFrame(
        seen.frames,
        seen.from,
        guest.log,
        "after two quick host cuts",
      );
    },
  );
});

const clock = (page: Page) => page.locator(".sys-player-now");
const seconds = async (page: Page) =>
  parseTimecodeSec(await clock(page).innerText());

test("a slow word detail leaves the same busy Script, whose held words do not seek", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "commenter", size: WIDE },
    async (guest) => {
      const { page: view } = guest;
      const section = view.locator(SECTION);
      const last = view.locator(WORD).last();
      // A selection made before the edit is the one the bar acts on: a gesture
      // on a held word is dropped, because a cut renumbers the words.
      await last.click();
      await expect(
        view.getByRole("group", { name: "Selection actions" }),
      ).toBeVisible();
      const before = await seconds(view);
      const { from } = await startWatch(view);
      guest.detail.delayMs = 1_500;
      await hostEdit(page, guest.projectPath, "cut", 0);

      await expect(section).toHaveAttribute("aria-busy", "true", {
        timeout: 10_000,
      });
      expect(
        await view.evaluate(
          (selector) =>
            document.querySelector(selector) ===
            (window as unknown as Watched).__scriptSection,
          SECTION,
        ),
        "the Script section is the element that was on screen before the edit",
      ).toBe(true);
      expect(await view.locator(WORD).count()).toBeGreaterThan(0);

      await view.locator(WORD).first().click();
      await view.waitForTimeout(300);
      expect(await seconds(view), "a tap on a held word does not seek").toBe(
        before,
      );
      const bar = view.getByRole("group", { name: "Selection actions" });
      await expect(bar).toBeVisible();
      const comment = bar.getByRole("button", { name: "Comment" });
      await expect(comment).toBeDisabled();
      await expect(comment).toHaveAttribute("title", REASON);

      await expect(section).not.toHaveAttribute("aria-busy", "true", {
        timeout: 15_000,
      });
      await view.waitForTimeout(500);
      const seen = await stopWatch(view);
      expectNoBlankFrame(
        seen,
        from,
        guest.log,
        "while the word detail was slow",
      );
      const swapped = seen.filter((f) => f.t >= from && f.words > 0 && !f.same);
      expect(
        swapped.length,
        `the Script section was replaced in ${swapped.length} frame(s); first at +${swapped[0] ? (swapped[0].t - from).toFixed(0) : "-"}ms, busy=${swapped[0]?.busy} hostSame=${swapped[0]?.hostSame}\nGuest requests:\n${guest.log.join("\n")}`,
      ).toBe(0);
    },
  );
});

test("a failed word detail shows the cover with Retry, and Retry brings the words back", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "viewer", size: WIDE },
    async (guest) => {
      const { page: view } = guest;
      const { from } = await startWatch(view);
      guest.detail.status = 500;
      guest.detail.delayMs = 400;
      await hostEdit(page, guest.projectPath, "cut", 0);

      const retry = view.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible({ timeout: 15_000 });
      expect(await view.locator(WORD).count()).toBe(0);

      guest.detail.status = null;
      guest.detail.delayMs = 0;
      await retry.click();
      await expect(view.locator(WORD).first()).toBeVisible({ timeout: 15_000 });
      await expect(retry).toHaveCount(0);
      await view.waitForTimeout(500);
      const seen = await stopWatch(view);
      expectNoBlankFrame(seen, from, guest.log, "around a failed word detail");
      await expect(view.locator(SECTION)).not.toHaveAttribute(
        "aria-busy",
        "true",
      );
    },
  );
});

async function bodyOverflows(body: Locator): Promise<{ over: number }> {
  return body.evaluate((el) => ({ over: el.scrollHeight - el.clientHeight }));
}

test("a scrolled reader's word stays where it was through a host cut above it", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "viewer", size: SHORT_PHONE },
    async (guest) => {
      const { page: view } = guest;
      const body = view.locator(BODY);
      expect(
        (await bodyOverflows(body)).over,
        "the Script must overflow to scroll",
      ).toBeGreaterThan(100);
      // A scroll event from the reader, in every engine (mobile WebKit has no wheel).
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(
          async () =>
            (await bodyOverflows(body)).over -
            (await body.evaluate((el) => el.scrollTop)),
        )
        .toBeLessThan(2);
      const anchorKey = await view.evaluate((selector) => {
        const bodyEl = document.querySelector(selector);
        if (!bodyEl) return null;
        const box = bodyEl.getBoundingClientRect();
        const visible = [...bodyEl.querySelectorAll("[data-word-key]")].filter(
          (e) => {
            const r = e.getBoundingClientRect();
            return r.top >= box.top + 4 && r.bottom <= box.bottom - 4;
          },
        );
        const word = visible[Math.floor(visible.length / 2)];
        const turn = word?.closest("[data-turn-id]");
        if (!word || !turn) return null;
        const nth = [...turn.querySelectorAll("[data-word-key]")].indexOf(word);
        return `${turn.getAttribute("data-turn-id")}|${nth}`;
      }, BODY);
      expect(anchorKey, "a word is visible to anchor on").not.toBeNull();

      const seen = await frames(guest, page, "cut", 1, anchorKey);
      expectNoBlankFrame(
        seen.frames,
        seen.from,
        guest.log,
        "for a scrolled reader",
      );
      const offsets = seen.frames
        .filter((f) => f.t >= seen.from)
        .map((f) => f.offset);
      expect(
        offsets.every((o) => o !== null),
        "the reader's word stayed on screen",
      ).toBe(true);
      const first = offsets[0] as number;
      const worst = Math.max(
        ...offsets.map((o) => Math.abs((o as number) - first)),
      );
      expect(
        worst,
        "the reader's word moved by at most 2px on every frame",
      ).toBeLessThan(2);
    },
  );
});

test("a following guest's Script does not scroll while it refreshes", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "viewer", size: SHORT_PHONE },
    async (guest) => {
      const { page: view } = guest;
      const body = view.locator(BODY);
      expect(
        (await bodyOverflows(body)).over,
        "the Script must overflow to scroll",
      ).toBeGreaterThan(100);
      // A tap on the last word moves the playhead there; following scrolls to it.
      await view.locator(WORD).last().click();
      await expect
        .poll(
          async () =>
            (await bodyOverflows(body)).over -
            (await body.evaluate((el) => el.scrollTop)),
        )
        .toBeLessThan(2);
      guest.detail.delayMs = 1_500;
      const { from } = await startWatch(view);
      await hostEdit(page, guest.projectPath, "cut", 0);
      await expect(view.locator(SECTION)).toHaveAttribute("aria-busy", "true", {
        timeout: 10_000,
      });
      await expect(view.locator(SECTION)).not.toHaveAttribute(
        "aria-busy",
        "true",
        { timeout: 15_000 },
      );
      await view.waitForTimeout(500);
      const seen = await stopWatch(view);
      expectNoBlankFrame(seen, from, guest.log, "for a following guest");
      const busy = seen
        .filter((f) => f.t >= from && f.busy)
        .map((f) => f.scrollTop);
      expect(busy.length).toBeGreaterThan(0);
      expect(
        new Set(busy).size,
        "the Script did not scroll while it was refreshing",
      ).toBe(1);
      const playing = view.locator(`${WORD}[data-playing]`).first();
      if ((await playing.count()) > 0) await expect(playing).toBeInViewport();
    },
  );
});
