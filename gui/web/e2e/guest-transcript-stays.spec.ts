import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openGuestShare } from "./shareNavigation";

/**
 * A guest reading the transcript keeps its words on screen while the host
 * edits. The host edit is a real document command posted to the host API; the
 * guest receives it as a word-free delta over the review socket and then
 * refetches the word detail. A frame watcher records every animation frame and
 * DOM mutation so a gap of a few milliseconds cannot slip between polls.
 */

const SCRIPT = ".stage-host-guest-script";
const DETAIL = /\/daw\/document\/state\?phase=detail/;
const SIZES = [
  { width: 390, height: 844, phone: true },
  { width: 1280, height: 800, phone: false },
] as const;
const ROLES = ["viewer", "commenter"] as const;

type Frame = { t: number; skeleton: boolean; words: number; shape: string };
type Watched = Window & {
  __scriptFrames: Frame[];
  __stopScriptWatch: () => void;
};

const WATCHER = `(() => {
  const SCRIPT = ${JSON.stringify(SCRIPT)};
  const frames = [];
  window.__scriptFrames = frames;
  const describe = (list) =>
    [...list]
      .slice(0, 8)
      .map((e) => e.tagName.toLowerCase() + "." + String(e.className).split(" ").join("."))
      .join(" , ");
  const sample = () => {
    const root = document.querySelector(SCRIPT);
    const words = root ? root.querySelectorAll(".sys-script-word").length : 0;
    frames.push({
      t: performance.timeOrigin + performance.now(),
      skeleton: !!(root ? root.querySelector(".sys-skeleton") : document.querySelector(".sys-skeleton")),
      words,
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

async function hostCut(
  host: Page,
  projectPath: string,
  step: number,
): Promise<void> {
  await host.request.post("/api/transcript/refine/waive", {
    data: { path: projectPath, reason: "e2e guest transcript stays" },
  });
  await postDocumentCommand(
    host,
    `e2e-3797-${randomUUID()}`,
    "CutRange",
    { mode: "ripple", start: 5 + step * 12, end: 10 + step * 12 },
    projectPath,
  );
}

type Scenario = {
  role: (typeof ROLES)[number];
  size: (typeof SIZES)[number];
  cuts: number;
  /** Milliseconds the word-detail response is held back by the test. */
  detailDelayMs?: number;
};

/**
 * Open a guest link, make the host cut `cuts` times back to back, and return
 * the frames the watcher saw from the first cut until the guest settled.
 */
async function guestFramesThroughHostCuts(
  browser: import("@playwright/test").Browser,
  host: Page,
  { role, size, cuts, detailDelayMs = 0 }: Scenario,
): Promise<{ frames: Frame[]; from: number; log: string[] }> {
  return withShareableProject(async (projectPath) => {
    const token = await createReviewShare(host, projectPath, role);
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.phone,
      isMobile: size.phone,
    });
    try {
      const guest = await context.newPage();
      if (detailDelayMs > 0) {
        await guest.route(DETAIL, async (route) => {
          await new Promise((resolve) => setTimeout(resolve, detailDelayMs));
          await route.continue();
        });
      }
      const log = logGuestRequests(guest);
      await openGuestShare(guest, token);
      await expect(
        guest.locator(`${SCRIPT} .sys-script-word`).first(),
      ).toBeVisible({ timeout: 20_000 });
      // Let the first detail hydrate and any follow-up settle.
      await guest.waitForTimeout(800);
      await guest.evaluate(WATCHER);

      const from = Date.now();
      const detail = guest
        .waitForResponse((r) => DETAIL.test(r.url()), { timeout: 15_000 })
        .catch(() => null);
      for (let n = 0; n < cuts; n += 1) {
        await hostCut(host, projectPath, n);
      }
      await detail;
      await guest.waitForTimeout(800);
      const frames = await guest.evaluate(() => {
        const watched = window as unknown as Watched;
        watched.__stopScriptWatch();
        return watched.__scriptFrames;
      });
      return { frames, from, log };
    } finally {
      await context.close();
    }
  });
}

function expectNoBlankFrame(
  { frames, from, log }: { frames: Frame[]; from: number; log: string[] },
  what: string,
) {
  const bad = frames.filter(
    (f) => f.t >= from && (f.skeleton || f.words === 0),
  );
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

for (const role of ROLES) {
  for (const size of SIZES) {
    test(`a ${role} at ${size.width}x${size.height} keeps the transcript on screen through a host cut`, async ({
      browser,
      page,
    }) => {
      const run = await guestFramesThroughHostCuts(browser, page, {
        role,
        size,
        cuts: 1,
      });
      expectNoBlankFrame(run, "after a host cut");
    });
  }
}
