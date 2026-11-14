import { randomUUID } from "node:crypto";
import {
  type Browser,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openGuestShare } from "./shareNavigation";

/** The frame watcher samples every animation frame and DOM mutation, so a gap of a few milliseconds cannot slip between polls. */

const SCRIPT = ".stage-host-guest-script";
export const SECTION = `${SCRIPT} .sys-script`;
export const BODY = `${SCRIPT} .sys-script-body`;
export const WORD = `${SCRIPT} .sys-script-word`;
const DETAIL = /\/daw\/document\/state\?phase=detail/;
export const REASON = "Refreshing the transcript. Try again in a moment.";
export const WIDE = { width: 1280, height: 800, phone: false } as const;
export const SIZES = [{ width: 390, height: 844, phone: true }, WIDE] as const;
export const ROLES = ["viewer", "commenter"] as const;
/** A phone short enough that the fixture's few lines overflow the Script. */
export const SHORT_PHONE = { width: 320, height: 568, phone: true } as const;

export type Size = { width: number; height: number; phone: boolean };
export type Role = (typeof ROLES)[number];

export type Frame = {
  t: number;
  skeleton: boolean;
  words: number;
  busy: boolean;
  /** The Script section is the element the watcher found when it started. */
  same: boolean;
  /** The failure cover that replaces the Script when the detail cannot be had. */
  cover: boolean;
  /** The watched word's distance from the top of the Script body, if it is drawn. */
  offset: number | null;
};
export type Watched = Window & {
  __scriptFrames: Frame[];
  __stopScriptWatch: () => void;
  __scriptSection: Element | null;
};

export function watcher(anchorKey: string | null): string {
  return `(() => {
  const SCRIPT = ${JSON.stringify(SCRIPT)};
  const ANCHOR = ${JSON.stringify(anchorKey)};
  const frames = [];
  window.__scriptFrames = frames;
  window.__scriptSection = document.querySelector(${JSON.stringify(SECTION)});
  const sample = () => {
    const root = document.querySelector(SCRIPT);
    const body = root && root.querySelector(".sys-script-body");
    const section = root && root.querySelector(".sys-script");
    const words = root ? root.querySelectorAll(".sys-script-word").length : 0;
    // The anchor is "line id|nth word", not a word key: a cut renumbers word_index.
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
      cover: [...document.querySelectorAll("[role='alert']")].some((e) => (e.textContent || "").includes("The transcript didn't load")),
      offset: anchor && body ? anchor.getBoundingClientRect().top - body.getBoundingClientRect().top : null,
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
export function logGuestRequests(page: Page): string[] {
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

export type Detail = { delayMs: number; status: number | null };

export type Guest = {
  page: Page;
  projectPath: string;
  detail: Detail;
  log: string[];
};

export async function withGuest(
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
      await settled(page);
      await run({ page, projectPath, detail, log });
    } finally {
      await context.close();
    }
  });
}

export type Edit = "cut" | "correct";

export async function hostEdit(
  host: Page,
  projectPath: string,
  edit: Edit,
  step: number,
  /** Where a cut starts, in seconds; it runs 5 s. Default: 5 s plus 12 s a step. */
  startSec = 5 + step * 12,
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
      { mode: "ripple", start: startSec, end: startSec + 5 },
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

export async function startWatch(page: Page, anchorKey: string | null = null) {
  await page.evaluate(watcher(anchorKey));
  return { from: Date.now() };
}

export async function stopWatch(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const watched = window as unknown as Watched;
    watched.__stopScriptWatch();
    return watched.__scriptFrames;
  });
}

export const blank = (f: Frame) => f.skeleton || (f.words === 0 && !f.cover);

export function expectNoBlankFrame(
  frames: Frame[],
  from: number,
  log: string[],
  what: string,
) {
  const bad = frames.filter((f) => f.t >= from && blank(f));
  expect(
    bad.length,
    `the Script showed its skeleton or no words in ${bad.length} frame(s) ${what}.\nGuest requests:\n${log.join("\n")}`,
  ).toBe(0);
}

/** Nothing is refreshing and what was last drawn has been painted (two frames). */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator(SECTION)).not.toHaveAttribute("aria-busy", "true", {
    timeout: 15_000,
  });
  await painted(page);
}

export async function painted(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** The Script body has not scrolled for three animation frames. */
export async function scrollIdle(page: Page): Promise<void> {
  await page.evaluate(
    (selector) =>
      new Promise<void>((resolve) => {
        const body = document.querySelector(selector);
        let last = body?.scrollTop;
        let still = 0;
        const tick = () => {
          const now = body?.scrollTop;
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 3) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    BODY,
  );
}

export async function frames(
  guest: Guest,
  host: Page,
  edit: Edit,
  edits: number,
  anchorKey: string | null = null,
  startSec?: number,
) {
  const { from } = await startWatch(guest.page, anchorKey);
  let detailSeen = false;
  const detail = guest.page
    .waitForResponse((r) => DETAIL.test(r.url()), { timeout: 15_000 })
    .then(() => {
      detailSeen = true;
    })
    .catch(() => undefined);
  for (let n = 0; n < edits; n += 1) {
    await hostEdit(host, guest.projectPath, edit, n, startSec);
  }
  await detail;
  await settled(guest.page);
  const seen = await stopWatch(guest.page);
  // Without a refresh the checks over these frames would pass on nothing.
  expect(
    detailSeen || seen.some((f) => f.busy),
    `the host edit never made the guest refresh its transcript.\nGuest requests:\n${guest.log.join("\n")}`,
  ).toBe(true);
  return { frames: seen, from };
}

/**
 * The browser's own scroll anchoring must not do the pane's work: with it on,
 * a browser that supports it keeps the reader still by itself and the test
 * would pass without our code. Every engine runs with it off.
 */
export async function anchoringOff(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "* { overflow-anchor: none !important; }",
  });
}

/** A reader's scroll as the pane reads one: a wheel event for intent, then the scroll. Without intent the pane does not attribute the scroll to the user. */
export async function scrollByHand(
  page: Page,
  to: "end" | number,
): Promise<void> {
  await page.locator(BODY).evaluate((el, target) => {
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true }),
    );
    el.scrollTop = target === "end" ? el.scrollHeight : target;
  }, to);
}

/** A word of what the Script body shows, as "line id|nth word": the first whole one, or the middle one. */
export async function visiblePlace(
  page: Page,
  which: "first" | "middle" = "middle",
): Promise<string | null> {
  return page.evaluate(
    ({ selector, which }) => {
      const bodyEl = document.querySelector(selector);
      if (!bodyEl) return null;
      const box = bodyEl.getBoundingClientRect();
      const visible = [...bodyEl.querySelectorAll("[data-word-key]")].filter(
        (e) => {
          const r = e.getBoundingClientRect();
          return r.top >= box.top + 4 && r.bottom <= box.bottom - 4;
        },
      );
      const word =
        which === "first"
          ? visible[0]
          : visible[Math.floor(visible.length / 2)];
      const turn = word?.closest("[data-turn-id]");
      if (!word || !turn) return null;
      const nth = [...turn.querySelectorAll("[data-word-key]")].indexOf(word);
      return `${turn.getAttribute("data-turn-id")}|${nth}`;
    },
    { selector: BODY, which },
  );
}

/** Whether the word at "line id|nth word" is inside the Script body's box. */
export async function placeInView(page: Page, place: string): Promise<boolean> {
  return page.evaluate(
    ({ selector, at }) => {
      const bodyEl = document.querySelector(selector);
      const [turnId, nth] = at.split("|");
      const turn = [...(bodyEl?.querySelectorAll("[data-turn-id]") ?? [])].find(
        (e) => e.getAttribute("data-turn-id") === turnId,
      );
      const words = turn ? [...turn.querySelectorAll("[data-word-key]")] : [];
      const word = words[Math.min(Number(nth), words.length - 1)];
      if (!bodyEl || !word) return false;
      const box = bodyEl.getBoundingClientRect();
      const r = word.getBoundingClientRect();
      return r.top >= box.top && r.bottom <= box.bottom;
    },
    { selector: BODY, at: place },
  );
}

export async function bodyOverflows(body: Locator): Promise<{ over: number }> {
  return body.evaluate((el) => ({ over: el.scrollHeight - el.clientHeight }));
}
