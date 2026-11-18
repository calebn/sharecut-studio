import fs from "node:fs";
import {
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openHostShare } from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

/** The host turns a review link off, as the Share menu does. */
export async function revokeLink(
  host: Page,
  token: string,
  projectPath: string,
) {
  const ended = await host.request.post(`/api/shares/${token}/revoke`, {
    data: { path: projectPath },
  });
  expect(ended.ok(), await ended.text()).toBeTruthy();
}

/** The title of the cover for a link that does not open anything. */
export const DEAD_TITLE = "This link doesn't open anything";

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

/** The narrowest phone the specs open (the app states no minimum): the header folds its right side at exactly this width (20 rem). */
export const NARROW_PHONE = {
  name: "narrow",
  width: 320,
  height: 568,
  touch: true,
} as const;

export const ROLES = ["viewer", "commenter", "editor"] as const;
type GuestRole = (typeof ROLES)[number];

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
  initial: FailedAnswer,
) {
  let fail = initial;
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
    /** The next failed answers say `next` instead. */
    answerWith: (next: FailedAnswer) => {
      fail = next;
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

/**
 * Holds the first answer of the episode's own read (`/project`) for `ms`. The
 * header's own read of the version label comes next and is not held.
 */
export async function holdFirstProject(page: Page, token: string, ms: number) {
  let held = false;
  await page.route(`**/api/review/${token}/project`, async (route) => {
    if (!held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.fallback();
  });
}

/** Holds the built chunk `assets/<name>-*.js` until `release()`. */
export async function holdChunk(page: Page, name: string) {
  let release: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/assets/${name}-*.js`, async (route) => {
    await open;
    await route.fallback();
  });
  return { release: () => release() };
}

/** The episode's name, as the link's own read answers it. */
export async function episodeName(page: Page, token: string): Promise<string> {
  const answer = await page.request.get(`/api/review/${token}/project`);
  expect(answer.ok()).toBeTruthy();
  return ((await answer.json()) as { meta: { name: string } }).meta.name;
}

/**
 * Gives the episode a blank name, the way the server's own tests do: in the
 * project file. The rename command refuses a blank name, so no browser can ask
 * for this one. The link's next read of the episode answers `meta.name` as "".
 */
export function blankEpisodeName(projectPath: string): void {
  const data = JSON.parse(fs.readFileSync(projectPath, "utf8")) as {
    meta: { name?: string };
  };
  data.meta.name = "";
  fs.writeFileSync(projectPath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * A shared project with the host's own page open on it, the guest contexts
 * asked for after it, and a link for each of `roles`. The host stays open so a
 * guest finds a person in the header's people slot, as a real one does.
 */
export async function withSharedProject(
  browser: Parameters<typeof withBrowserPages>[0],
  guests: BrowserContextOptions[],
  roles: readonly GuestRole[],
  run: (
    pages: Page[],
    links: Record<GuestRole, string>,
    projectPath: string,
  ) => Promise<void>,
) {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(browser, [{}, ...guests], async (pages) => {
      const [host] = pages;
      await openHostShare(host!, projectPath);
      const links = {} as Record<GuestRole, string>;
      for (const role of roles)
        links[role] = await createReviewShare(host!, projectPath, role);
      await run(pages, links, projectPath);
    });
  });
}

export async function withGuestLink(
  browser: Parameters<typeof withBrowserPages>[0],
  size: Size,
  run: (
    guest: Page,
    token: string,
    host: Page,
    projectPath: string,
  ) => Promise<void>,
  role: "commenter" | "editor" = "commenter",
) {
  await withSharedProject(
    browser,
    [
      {
        viewport: { width: size.width, height: size.height },
        hasTouch: size.touch,
      },
    ],
    [role],
    async ([host, guest], links, projectPath) =>
      run(guest!, links[role], host!, projectPath),
  );
}

export async function withGuestLinks(
  browser: Parameters<typeof withBrowserPages>[0],
  run: (
    links: Record<GuestRole, string>,
    host: Page,
    projectPath: string,
  ) => Promise<void>,
) {
  await withSharedProject(
    browser,
    [],
    ROLES,
    async ([host], links, projectPath) => run(links, host!, projectPath),
  );
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

/** How many words sit on the last line of a text node's element (a title or a sentence). */
export function lastLineWordCount(element: Locator): Promise<number> {
  return element.evaluate((el) => {
    const text = el.firstChild as Text;
    const words = [...text.data.matchAll(/\S+/g)];
    const top = (word: RegExpMatchArray) => {
      const range = document.createRange();
      range.setStart(text, word.index ?? 0);
      range.setEnd(text, (word.index ?? 0) + word[0].length);
      return range.getBoundingClientRect().top;
    };
    const lastTop = top(words[words.length - 1]!);
    return words.filter((word) => top(word) === lastTop).length;
  });
}

/**
 * Starts watching for `text` to first appear on the page and records, in the
 * same task that put it there, what holds focus. Read the result with
 * `focusWhenSeen`. A poll that only passes after the busy hold would hide a
 * button that held focus for a moment.
 */
export async function watchFocusWhenSeen(page: Page, text: string) {
  await page.evaluate((wanted) => {
    const seen = new Promise<string>((resolve) => {
      const look = () => {
        if (!document.body.textContent?.includes(wanted)) return false;
        const active = document.activeElement;
        resolve(
          active?.getAttribute("data-cover-action") ??
            `${active?.tagName.toLowerCase()}:${active?.textContent}`,
        );
        return true;
      };
      if (look()) return;
      const observer = new MutationObserver(() => {
        if (look()) observer.disconnect();
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    (window as unknown as { __focusSeen: Promise<string> }).__focusSeen = seen;
  }, text);
}

export const focusWhenSeen = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __focusSeen: Promise<string> }).__focusSeen,
  );

export async function seeEveryHint(page: Page) {
  await page.addInitScript(() => {
    for (const role of ["viewer", "commenter", "editor"])
      localStorage.setItem(`sharecut.roleHintSeen.${role}`, "1");
  });
}

/** A guest's own browser window of `size`: a first visit shows the role hint, a returning guest has seen it. */
export async function withGuestPage(
  browser: Parameters<typeof withBrowserPages>[0],
  size: Size,
  run: (guest: Page) => Promise<void>,
  options: { visit?: "first" | "returning"; scale?: number } = {},
) {
  await withBrowserPages(
    browser,
    [
      {
        viewport: { width: size.width, height: size.height },
        hasTouch: size.touch,
        deviceScaleFactor: options.scale ?? 1,
      },
    ],
    async ([guest]) => {
      if (options.visit === "returning") await seeEveryHint(guest!);
      await run(guest!);
    },
  );
}

export type Answer = "offline" | "refused" | "through";

/** Holds the episode request the page makes on load, so the device can lose its connection while it is out. */
export async function holdFirstRequest(page: Page, token: string) {
  let answer: Answer = "offline";
  let asked = 0;
  let release: (route: Route) => void = () => {};
  const first = new Promise<Route>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/review/${token}/project`, async (route) => {
    asked += 1;
    if (asked === 1) return release(route);
    if (answer === "through") return route.continue();
    return route.abort(
      answer === "offline" ? "internetdisconnected" : "connectionrefused",
    );
  });
  return {
    first,
    asked: () => asked,
    answerWith: (next: Answer) => {
      answer = next;
    },
  };
}

export const deviceOnLine = (page: Page) =>
  page.evaluate(() => navigator.onLine);

export async function loseConnectionOnLoad(page: Page, token: string) {
  const held = await holdFirstRequest(page, token);
  await page.goto(`/r/${token}`);
  const route = await held.first;
  await page.context().setOffline(true);
  await expect.poll(() => deviceOnLine(page)).toBe(false);
  await route.abort("internetdisconnected");
  return held;
}
