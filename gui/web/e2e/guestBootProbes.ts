import { expect, type Page } from "@playwright/test";

/** What the page showed while the studio's script took over from the server's markup. */
export type BootProbes = {
  /** Frames and observer callbacks looked at between the first one with the name and the landed studio. */
  frames: number;
  callbacks: number;
  /** Every look at which the root was empty or no title held the name. */
  gaps: {
    kind: "frame" | "callback";
    at: number;
    root: number;
    text: string | null;
  }[];
  /** `performance.now()` when the title first held the name, and when the studio's title did. */
  firstAt: number | null;
  landedAt: number | null;
};

type BootWindow = typeof globalThis & {
  __boot: {
    probes: BootProbes;
    staticTitle: Element | null;
    landedFrames: number;
    securityViolations: string[];
  };
};

/**
 * Watches `#root` from before the page's first script: on every animation
 * frame and on every batch of DOM changes it checks that the root has a child
 * and that a `.sys-header-title` holds the episode's name. It starts at the
 * first look where the title does (the page's own markup, before the script)
 * and stops two frames after the studio's own title does. A layout-shift
 * observer cannot see a title that is removed and put back, so this does.
 * It also keeps every `securitypolicyviolation` event the page raises.
 */
export async function installBootProbes(
  page: Page,
  name: string,
): Promise<void> {
  await page.addInitScript((episode: string) => {
    const probes: BootProbes = {
      frames: 0,
      callbacks: 0,
      gaps: [],
      firstAt: null,
      landedAt: null,
    };
    const state = {
      probes,
      staticTitle: null as Element | null,
      landedFrames: 0,
      securityViolations: [] as string[],
    };
    (window as unknown as BootWindow).__boot = state;
    document.addEventListener("securitypolicyviolation", (event) => {
      state.securityViolations.push(
        `${event.violatedDirective}: ${event.blockedURI}`,
      );
    });
    const look = (kind: "frame" | "callback") => {
      const now = performance.now();
      const title = document.querySelector(".sys-header-title");
      if (probes.firstAt === null) {
        if (title?.textContent !== episode) return;
        probes.firstAt = now;
        state.staticTitle = title;
      }
      if (state.landedFrames >= 2) return;
      if (kind === "frame") probes.frames += 1;
      else probes.callbacks += 1;
      const rootChildren = document.getElementById("root")?.childElementCount;
      if (!rootChildren || title?.textContent !== episode)
        probes.gaps.push({
          kind,
          at: now,
          root: rootChildren ?? 0,
          text: title?.textContent ?? null,
        });
      const studio = document.querySelector(
        ".stage-frame--guest .sys-header-title",
      );
      if (studio?.textContent === episode) {
        probes.landedAt ??= now;
        if (kind === "frame") state.landedFrames += 1;
      }
    };
    new MutationObserver(() => look("callback")).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    const frame = () => {
      look("frame");
      if (state.landedFrames < 2) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, name);
}

export async function readBootProbes(page: Page): Promise<BootProbes> {
  return page.evaluate(
    () => (window as unknown as BootWindow).__boot.probes as BootProbes,
  );
}

export async function securityViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as BootWindow).__boot.securityViolations,
  );
}

/** Whether the title on the page is React's loading header, not the markup the server wrote. */
export async function reactDrewLoadingHeader(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const title = document.querySelector(
      "main.guest-loading .sys-header-title",
    );
    return (
      title !== null &&
      title !== (window as unknown as BootWindow).__boot.staticTitle
    );
  });
}

/**
 * Holds every built script until `ms` after the page's own HTML arrived: the
 * bundle on a slow phone connection. `released()` says whether the hold is
 * over, so a test can show it read the page while the script was still away.
 */
export async function holdScripts(page: Page, ms: number) {
  let htmlAt = 0;
  let releasedAt = 0;
  let htmlSeen: () => void = () => {};
  const html = new Promise<void>((resolve) => {
    htmlSeen = resolve;
  });
  page.on("response", (response) => {
    if (response.request().resourceType() !== "document" || htmlAt) return;
    htmlAt = Date.now();
    htmlSeen();
  });
  await page.route("**/assets/*.js", async (route) => {
    await html;
    const left = htmlAt + ms - Date.now();
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    releasedAt ||= Date.now();
    await route.fallback();
  });
  return { released: () => releasedAt > 0 };
}

/** Milliseconds from the page's HTML to now, read in the page. */
export async function sinceHtml(page: Page): Promise<number> {
  return page.evaluate(() => {
    const [nav] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    return performance.now() - (nav?.responseEnd ?? 0);
  });
}

/** Waits, frame by frame in the page, until `ms` have passed since the HTML arrived. */
export async function waitSinceHtml(page: Page, ms: number): Promise<void> {
  await page.waitForFunction(
    (wanted) => {
      const [nav] = performance.getEntriesByType(
        "navigation",
      ) as PerformanceNavigationTiming[];
      return performance.now() - (nav?.responseEnd ?? 0) >= wanted;
    },
    ms,
    { polling: "raf" },
  );
}

/** Milliseconds from the page's HTML to its first paint, read in the page. */
export async function firstPaintAfterHtml(page: Page): Promise<number> {
  await expect
    .poll(() =>
      page.evaluate(() => performance.getEntriesByType("paint").length),
    )
    .toBeGreaterThan(0);
  return page.evaluate(() => {
    const [nav] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    const paint = performance
      .getEntriesByType("paint")
      .reduce(
        (first, e) => Math.min(first, e.startTime),
        Number.POSITIVE_INFINITY,
      );
    return paint - (nav?.responseEnd ?? 0);
  });
}
