import type { Page } from "@playwright/test";

export type Rect = { x: number; y: number; w: number; h: number };

export type ShiftEntry = {
  value: number;
  at: number;
  sources: { node: string; from: Rect; to: Rect }[];
};

export type Probes = {
  shifts: ShiftEntry[];
  /** `html[data-shell]` in the first microtask after `.stage-frame--guest` was added; null until it was. */
  shellAtFrame: string | null | "unset";
  /** Every text the header's visible title (the studio's or the loading screen's) held, with when it first did. */
  titles: { at: number; text: string }[];
  /** The count of grey blocks after every change to the page, until the studio frame was added. */
  blocks: { at: number; count: number }[];
  firstLoadingAt: number | null;
  stillLoadingAt: number | null;
  frameAt: number | null;
};

/**
 * Watches the page from before its first script: layout shifts with their
 * sources, `html[data-shell]` when the studio frame is added, the header
 * title's text, the grey blocks, and the loading screen's clock. One
 * MutationObserver that only counts and reads text, and a buffered
 * PerformanceObserver: nothing here reads layout or samples frames, so it does
 * not change the race it watches.
 */
export async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const out = {
      shifts: [] as unknown[],
      shellAtFrame: null as string | null,
      titles: [] as { at: number; text: string }[],
      blocks: [] as { at: number; count: number }[],
      firstLoadingAt: null as number | null,
      stillLoadingAt: null as number | null,
      frameAt: null as number | null,
    };
    (window as unknown as { __probes: typeof out }).__probes = out;
    const rect = (r: DOMRectReadOnly) => ({
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
    });
    const label = (n: Node | null) => {
      const el = n as Element | null;
      if (!el?.tagName) return "?";
      return `${el.tagName.toLowerCase()}${
        typeof el.className === "string" && el.className
          ? `.${el.className.split(" ")[0]}`
          : ""
      }`;
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources: {
            node: Node | null;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }[];
        };
        if (shift.hadRecentInput) continue;
        out.shifts.push({
          value: shift.value,
          at: shift.startTime,
          sources: shift.sources.map((s) => ({
            node: label(s.node),
            from: rect(s.previousRect),
            to: rect(s.currentRect),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
    let lastTitle: string | null = null;
    const look = () => {
      const now = performance.now();
      const root = document.documentElement;
      if (
        out.frameAt === null &&
        document.querySelector(".stage-frame--guest")
      ) {
        out.frameAt = now;
        out.shellAtFrame = root.dataset.shell ?? "unset";
      }
      if (out.frameAt === null) {
        if (
          out.firstLoadingAt === null &&
          document.querySelector("main.guest-loading")
        )
          out.firstLoadingAt = now;
        const count = document.querySelectorAll(".sys-skeleton-block").length;
        if (out.blocks.at(-1)?.count !== count)
          out.blocks.push({ at: now, count });
        if (
          out.stillLoadingAt === null &&
          document.body.textContent?.includes("Still loading…")
        )
          out.stillLoadingAt = now;
      }
      const title = document.querySelector(".sys-header-title")?.textContent;
      if (title != null && title !== lastTitle) {
        lastTitle = title;
        out.titles.push({ at: now, text: title });
      }
    };
    new MutationObserver(look).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

export async function readProbes(page: Page): Promise<Probes> {
  return page.evaluate(
    () => (window as unknown as { __probes: Probes }).__probes,
  );
}

export const shiftSum = (probes: Probes) =>
  probes.shifts.reduce((sum, entry) => sum + entry.value, 0);

/** The header bar's and its title's boxes now. The title is the grey block while the loading screen has no name. */
export async function headerBoxes(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const host = document.querySelector(".sys-app-header-host");
    return {
      host: box(host),
      title: box(host?.querySelector(".sys-header-title")),
      block: box(host?.querySelector(".sys-skeleton-block--title")),
      sub: box(host?.querySelector(".sys-header-sub")),
    };
  });
}
