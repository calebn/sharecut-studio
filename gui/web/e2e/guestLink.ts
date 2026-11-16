import { expect, type Locator, type Page } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openHostShare } from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

export type Size = {
  name: string;
  width: number;
  height: number;
  touch: boolean;
};

export const SIZES = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "desktop", width: 1280, height: 800, touch: false },
] as const;

export async function press(button: Locator, touch: boolean) {
  if (touch) {
    await button.tap();
  } else {
    await button.click();
  }
}

/** What a stubbed request answers: nothing at all, or this status, headers and body. */
export type FailedAnswer =
  | "abort"
  | { status: number; headers?: Record<string, string>; body: string };

/** Every review request for the episode itself fails the way `fail` says. */
export async function failBootstrap(
  page: Page,
  token: string,
  fail: FailedAnswer,
) {
  await page.route(`**/api/review/${token}/project`, (route) =>
    fail === "abort" ? route.abort("connectionrefused") : route.fulfill(fail),
  );
}

/** What a server, a proxy or a crashed handler might put in an answer, and a guest or host must never read. */
export const SERVER_MARKER = "ZEBRA-secret-9931 db password=hunter2";

/** A 500 whose JSON `detail` is the marker. */
export const MARKER_500: FailedAnswer = {
  status: 500,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ detail: SERVER_MARKER }),
};

/**
 * The studio's first read of the episode (`phase=shell`, not the detail read
 * after it) fails the way `fail` says until `lift()`. A guest's read is the
 * share's own route; a host's is the document route.
 */
export async function failShell(
  page: Page,
  who: { token: string } | "host",
  fail: FailedAnswer,
) {
  let failing = true;
  let requests = 0;
  const pattern =
    who === "host"
      ? "**/api/document/state*"
      : `**/api/review/${who.token}/daw/document/state*`;
  await page.route(pattern, (route) => {
    if (new URL(route.request().url()).searchParams.get("phase") !== "shell") {
      return route.continue();
    }
    requests += 1;
    if (!failing) return route.continue();
    return fail === "abort"
      ? route.abort("connectionrefused")
      : route.fulfill(fail);
  });
  return {
    lift: () => {
      failing = false;
    },
    requests: () => requests,
  };
}

/**
 * Nothing the server said is anywhere a person or a screen reader can reach:
 * not the visible text, the page source, a `title` or `aria-label`, the live
 * regions, or the accessibility snapshot. Call it with the cover on screen, so
 * an empty page cannot pass.
 */
export async function expectServerWordsAbsent(
  page: Page,
  words: readonly string[] = ["ZEBRA", "hunter2"],
) {
  const reachable = await page.evaluate(() => ({
    text: document.body.innerText,
    labels: [...document.querySelectorAll("[title], [aria-label]")].flatMap(
      (el) => [
        el.getAttribute("title") ?? "",
        el.getAttribute("aria-label") ?? "",
      ],
    ),
    live: [
      ...document.querySelectorAll(
        "[aria-live], [role=status], [role=alert], [role=log]",
      ),
    ].map((el) => el.textContent ?? ""),
  }));
  const surfaces = {
    text: reachable.text,
    source: await page.content(),
    labels: reachable.labels.join("\n"),
    live: reachable.live.join("\n"),
    snapshot: await page.locator("body").ariaSnapshot(),
  };
  const leaks = Object.entries(surfaces)
    .filter(([, value]) => words.some((word) => value.includes(word)))
    .map(([name]) => name);
  expect(leaks, `the server's words reached: ${leaks.join(", ")}`).toEqual([]);
}

export async function withGuestLink(
  browser: Parameters<typeof withBrowserPages>[0],
  size: Size,
  run: (guest: Page, token: string) => Promise<void>,
) {
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
        const token = await createReviewShare(host!, projectPath, "commenter");
        await run(guest!, token);
      },
    );
  });
}

/** A window too short for the cover's usual offset: a desktop at 200% zoom. */
export const SHORT_WINDOW = {
  name: "short",
  width: 640,
  height: 400,
  touch: false,
} as const;

/** The cover's title, sentence and whole button sit inside the window and the page does not scroll. */
export async function expectCoverInWindow(page: Page) {
  const fit = await page.evaluate(() => {
    const parts = ["main h1", ".sys-cover-text", "main button"].map((sel) => {
      const box = document.querySelector(sel)!.getBoundingClientRect();
      return { sel, top: box.top, bottom: box.bottom };
    });
    return {
      outside: parts.filter((p) => p.top < 0 || p.bottom > window.innerHeight),
      overflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
  expect(fit.outside, JSON.stringify(fit)).toEqual([]);
  expect(fit.overflow, JSON.stringify(fit)).toBeLessThanOrEqual(0);
}
