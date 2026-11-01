import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

type Candidate =
  | "baseline"
  | "exclude-transcript"
  | "exclude-other-sections"
  | "first-correction";
type Departure =
  | "none"
  | "scroll-only-queued"
  | "scroll-only-delivered"
  | "keyboard"
  | "pointer"
  | "scrollbar";

type Sample = {
  scrollTop: number;
  lateHeight: number;
  cancelTop: number;
  cancelBottom: number;
  reasonTop: number;
  reasonBottom: number;
  pageTop: number;
  pageBottom: number;
  activeId: string;
  reachable: boolean;
  ownWrites: number;
  releaseReason: string | null;
};
type Probe = {
  grow(height: number): void;
  sample(): Sample;
  scrollOnly(): void;
  finish(): void;
  anchorStyles(): { id: string; value: string; priority: string }[];
  replaceAnchorStyle(): void;
  queueScrollOnCorrection(): void;
  events: {
    type: string;
    scrollTop: number;
    activeId: string;
    targetId: string | null;
  }[];
  capabilities: {
    overflowAnchor: boolean;
    scrollbarWidth: number;
    resizeObserver: boolean;
  };
};

declare global {
  interface Window {
    bounceAnchorPrototype: Probe;
  }
}

async function layoutCheckpoint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function mount(page: Page, candidate: Candidate): Promise<void> {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
    <title>Bounce native anchoring experiment</title><style>
    * { box-sizing: border-box; } body { margin: 0; }
    #outside { margin: 8px; } #page { margin: 16px; height: 320px;
      width: min(360px, calc(100vw - 32px)); overflow: auto;
      scrollbar-gutter: stable; border: 1px solid; }
    #column { display: flex; flex-direction: column; gap: 16px; }
    #episode { height: 500px; flex: none; }
    #transcript h2 { margin: 0; height: 24px; }
    #late { height: 0; } #bounce { height: 160px; flex: none; }
    #status { height: 80px; } #footer { height: 500px; flex: none; }
    </style></head><body><div id="stage" tabindex="-1"><button id="outside">Another action</button>
    <div id="page" tabindex="0" aria-label="Static Deliver scroller">
    <div id="column"><section id="episode">Episode</section>
    <section id="transcript"><h2>Transcript</h2><div id="late"></div></section>
    <section id="bounce"><button id="start">Bounce</button>
    <div id="status" hidden>Bouncing <button id="cancel">Cancel</button>
    <p id="reason">The bounce is still starting.</p></div></section>
    <section id="footer">Other content</section></div></div></div></body></html>`);
  await page.evaluate((candidate) => {
    const scroller = document.querySelector<HTMLElement>("#page")!;
    const column = document.querySelector<HTMLElement>("#column")!;
    const bounce = document.querySelector<HTMLElement>("#bounce")!;
    const late = document.querySelector<HTMLElement>("#late")!;
    const status = document.querySelector<HTMLElement>("#status")!;
    let armed = false;
    let capturedPosition = 0;
    let ownWrites = 0;
    let releaseReason: string | null = null;
    let scrollOnCorrection = false;
    const events: Probe["events"] = [];
    const priorStyles = new Map<
      HTMLElement,
      { value: string; priority: string }
    >();
    const activeId = () => document.activeElement?.id ?? "";
    const record = (type: string, targetId: string | null = null) =>
      events.push({
        type,
        scrollTop: scroller.scrollTop,
        activeId: activeId(),
        targetId,
      });
    const exclude = (element: HTMLElement) => {
      priorStyles.set(element, {
        value: element.style.getPropertyValue("overflow-anchor"),
        priority: element.style.getPropertyPriority("overflow-anchor"),
      });
      element.style.setProperty("overflow-anchor", "none");
    };
    const release = (reason: string) => {
      armed = false;
      releaseReason ??= reason;
      for (const [element, prior] of priorStyles) {
        if (
          element.style.getPropertyValue("overflow-anchor") === "none" &&
          element.style.getPropertyPriority("overflow-anchor") === ""
        ) {
          if (prior.value)
            element.style.setProperty(
              "overflow-anchor",
              prior.value,
              prior.priority,
            );
          else element.style.removeProperty("overflow-anchor");
        }
      }
      priorStyles.clear();
    };
    const sample = (): Sample => {
      const p = scroller.getBoundingClientRect();
      const c = document.querySelector("#cancel")!.getBoundingClientRect();
      const r = document.querySelector("#reason")!.getBoundingClientRect();
      const pageTop = Math.max(p.top + scroller.clientTop, 0);
      const pageBottom = Math.min(pageTop + scroller.clientHeight, innerHeight);
      return {
        scrollTop: scroller.scrollTop,
        lateHeight: late.getBoundingClientRect().height,
        cancelTop: c.top,
        cancelBottom: c.bottom,
        reasonTop: r.top,
        reasonBottom: r.bottom,
        pageTop,
        pageBottom,
        activeId: activeId(),
        reachable:
          c.top >= pageTop &&
          c.bottom <= pageBottom &&
          r.top >= pageTop &&
          r.bottom <= pageBottom,
        ownWrites,
        releaseReason,
      };
    };
    const correctOnce = () => {
      if (!armed || candidate !== "first-correction") return;
      if (scroller.scrollTop !== capturedPosition) {
        release("position-changed-before-observer");
        return;
      }
      const s = sample();
      const top = Math.min(s.cancelTop, s.reasonTop);
      const bottom = Math.max(s.cancelBottom, s.reasonBottom);
      const delta =
        bottom > s.pageBottom
          ? bottom - s.pageBottom
          : top < s.pageTop
            ? top - s.pageTop
            : 0;
      if (delta) {
        scroller.scrollTop += delta;
        ownWrites += 1;
        record("own-correction");
        if (scrollOnCorrection) {
          scroller.scrollTop = 0;
          record("probe-scroll-only-after-own-write-before-event-delivery");
          scrollOnCorrection = false;
        }
        release("first-correction-complete");
      }
    };
    const observer = new ResizeObserver(correctOnce);
    observer.observe(column);
    scroller.addEventListener("scroll", () => {
      record("scroll");
      if (armed && candidate === "first-correction") release("any-scroll");
    });
    for (const type of [
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
      "focusin",
    ]) {
      document.addEventListener(
        type,
        (event) => {
          record(
            type,
            event.target instanceof HTMLElement ? event.target.id : null,
          );
          if (armed && candidate === "first-correction") release(type);
        },
        { capture: true, passive: true },
      );
    }
    document.querySelector<HTMLButtonElement>("#start")!.onclick = () => {
      status.hidden = false;
      document.querySelector<HTMLButtonElement>("#start")!.disabled = true;
      document
        .querySelector<HTMLElement>("#stage")!
        .focus({ preventScroll: true });
      record("setup-disabled-action-focus-recovery");
      armed = true;
      capturedPosition = scroller.scrollTop;
      if (candidate === "exclude-transcript")
        exclude(document.querySelector<HTMLElement>("#transcript")!);
      if (candidate === "exclude-other-sections") {
        for (const section of column.children)
          if (section !== bounce) exclude(section as HTMLElement);
      }
      if (candidate === "first-correction") exclude(scroller);
      record("start");
      correctOnce();
    };
    window.bounceAnchorPrototype = {
      grow: (height) => {
        late.style.height = `${height}px`;
        record("grow");
      },
      sample,
      scrollOnly: () => {
        scroller.scrollTop = 0;
      },
      finish: () => {
        observer.disconnect();
        release("finish");
      },
      anchorStyles: () =>
        [scroller, ...Array.from(column.children)].map((el) => ({
          id: el.id,
          value: (el as HTMLElement).style.getPropertyValue("overflow-anchor"),
          priority: (el as HTMLElement).style.getPropertyPriority(
            "overflow-anchor",
          ),
        })),
      replaceAnchorStyle: () => {
        for (const element of priorStyles.keys())
          element.style.setProperty("overflow-anchor", "auto", "important");
      },
      queueScrollOnCorrection: () => {
        scrollOnCorrection = true;
      },
      events,
      capabilities: {
        overflowAnchor: CSS.supports("overflow-anchor", "none"),
        scrollbarWidth:
          scroller.offsetWidth - scroller.clientWidth - 2 * scroller.clientLeft,
        resizeObserver: typeof ResizeObserver === "function",
      },
    };
    scroller.scrollTop = 450;
  }, candidate);
  await layoutCheckpoint(page);
  await page.getByRole("button", { name: "Bounce", exact: true }).click();
  await layoutCheckpoint(page);
}

async function nativeDeparture(
  page: Page,
  departure: Departure,
): Promise<boolean> {
  if (departure === "keyboard") {
    await page.locator("#page").focus();
    await page.keyboard.press("Home");
  } else if (departure === "pointer") {
    await page.getByRole("button", { name: "Another action" }).click();
  } else if (departure === "scrollbar") {
    const rail = await page.locator("#page").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const box = el as HTMLElement;
      const width = box.offsetWidth - box.clientWidth - 2 * box.clientLeft;
      const thumb = (box.clientHeight * box.clientHeight) / box.scrollHeight;
      return {
        width,
        x: r.right - box.clientLeft - width / 2,
        y:
          r.top +
          box.clientTop +
          ((box.clientHeight - thumb) * box.scrollTop) /
            (box.scrollHeight - box.clientHeight) +
          thumb / 2,
        top: r.top + box.clientTop + thumb / 2,
      };
    });
    if (rail.width <= 0) return false;
    await page.mouse.move(rail.x, rail.y);
    await page.mouse.down();
    await page.mouse.move(rail.x, rail.top, { steps: 5 });
    await page.mouse.up();
  }
  return true;
}

export async function recordBounceAnchorPrototype(
  page: Page,
  browserName: string,
  browserVersion: string,
  info: TestInfo,
): Promise<void> {
  const results: unknown[] = [];
  const lifecycle: unknown[] = [];
  const candidates: Candidate[] = [
    "baseline",
    "exclude-transcript",
    "exclude-other-sections",
    "first-correction",
  ];
  const cases: {
    departure: Departure;
    timing: "before-first" | "after-first" | "own-write-queued";
  }[] = [
    { departure: "none", timing: "before-first" },
    ...(["before-first", "after-first"] as const).flatMap((timing) =>
      (
        [
          "scroll-only-queued",
          "scroll-only-delivered",
          "keyboard",
          "pointer",
          "scrollbar",
        ] as const
      ).map((departure) => ({ departure, timing })),
    ),
    { departure: "scroll-only-queued", timing: "own-write-queued" },
  ];
  let harnessError: string | null = null;
  let currentScenario: string | null = null;
  try {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const candidate of candidates) {
        for (const { departure, timing } of cases) {
          currentScenario = `${width}/${candidate}/${departure}/${timing}`;
          await mount(page, candidate);
          try {
            const before = await page.evaluate(() =>
              window.bounceAnchorPrototype.sample(),
            );
            expect(before.reachable).toBe(true);
            const capabilities = await page.evaluate(
              () => window.bounceAnchorPrototype.capabilities,
            );
            let exercised = true;
            let afterDeparture = before;
            const snapshots: Sample[] = [];
            if (timing === "own-write-queued") {
              await page.evaluate(() =>
                window.bounceAnchorPrototype.queueScrollOnCorrection(),
              );
            }
            for (const height of [250, 350]) {
              const departNow =
                departure !== "none" &&
                timing !== "own-write-queued" &&
                height === (timing === "before-first" ? 250 : 350);
              const beforeDeparture = await page.evaluate(() =>
                window.bounceAnchorPrototype.sample(),
              );
              if (departNow) {
                exercised = await nativeDeparture(page, departure);
                if (departure === "scroll-only-delivered") {
                  await page.evaluate(() =>
                    window.bounceAnchorPrototype.scrollOnly(),
                  );
                  await layoutCheckpoint(page);
                }
              }
              const snapshot = await page.evaluate(
                ({ height, departNow, departure }) => {
                  if (departNow && departure === "scroll-only-queued")
                    window.bounceAnchorPrototype.scrollOnly();
                  const sample = window.bounceAnchorPrototype.sample();
                  window.bounceAnchorPrototype.grow(height);
                  return sample;
                },
                { height, departNow, departure },
              );
              if (departNow) {
                afterDeparture = snapshot;
                if (departure !== "pointer")
                  exercised &&= snapshot.scrollTop < beforeDeparture.scrollTop;
              }
              await layoutCheckpoint(page);
              snapshots.push(
                await page.evaluate(() =>
                  window.bounceAnchorPrototype.sample(),
                ),
              );
            }
            const [firstGrowth, secondGrowth] = snapshots as [Sample, Sample];
            expect(firstGrowth.lateHeight).toBe(250);
            expect(secondGrowth.lateHeight).toBe(350);
            const events = await page.evaluate(
              () => window.bounceAnchorPrototype.events,
            );
            if (timing === "own-write-queued") {
              exercised = events.some(
                (event) =>
                  event.type ===
                  "probe-scroll-only-after-own-write-before-event-delivery",
              );
            }
            const navigationApplies = departure !== "none" && exercised;
            const afterNavigation =
              timing === "after-first" ? [secondGrowth] : snapshots;
            results.push({
              scenario: currentScenario,
              width,
              candidate,
              departure,
              timing,
              exercised,
              capabilities,
              before,
              afterDeparture,
              firstGrowth,
              secondGrowth,
              events,
              requirements: {
                twoGrowthReachability:
                  departure === "none"
                    ? snapshots.every((s) => s.reachable)
                    : null,
                noUnsolicitedFocus:
                  departure === "none"
                    ? snapshots.every((s) => s.activeId === before.activeId)
                    : null,
                noOwnCorrectionAfterDeparture: navigationApplies
                  ? timing === "own-write-queued"
                    ? events
                        .slice(
                          events.findIndex(
                            (event) =>
                              event.type ===
                              "probe-scroll-only-after-own-write-before-event-delivery",
                          ) + 1,
                        )
                        .every((event) => event.type !== "own-correction")
                    : secondGrowth.ownWrites === afterDeparture.ownWrites
                  : null,
                scrollDepartureRemainsAtTop:
                  navigationApplies && departure !== "pointer"
                    ? afterNavigation.every((s) => s.scrollTop === 0)
                    : null,
                pointerDepartureRetainsFocus:
                  navigationApplies && departure === "pointer"
                    ? afterNavigation.every(
                        (s) => s.activeId === afterDeparture.activeId,
                      )
                    : null,
              },
            });
          } finally {
            await page.evaluate(() => window.bounceAnchorPrototype.finish());
          }
        }
        for (const phase of [
          "settlement",
          "unmount",
          "foreign-style",
        ] as const) {
          currentScenario = `${width}/${candidate}/${phase}`;
          await mount(page, candidate);
          try {
            const before = await page.evaluate(() => ({
              sample: window.bounceAnchorPrototype.sample(),
              styles: window.bounceAnchorPrototype.anchorStyles(),
            }));
            const expectedForeign = await page.evaluate((phase) => {
              window.bounceAnchorPrototype.grow(250);
              if (phase === "foreign-style")
                window.bounceAnchorPrototype.replaceAnchorStyle();
              const foreign = window.bounceAnchorPrototype
                .anchorStyles()
                .filter((style) => style.priority === "important");
              window.bounceAnchorPrototype.finish();
              if (phase === "unmount")
                document.querySelector("#status")!.remove();
              window.bounceAnchorPrototype.grow(350);
              return foreign;
            }, phase);
            await layoutCheckpoint(page);
            const after = await page.evaluate(() => ({
              styles: window.bounceAnchorPrototype.anchorStyles(),
              events: window.bounceAnchorPrototype.events,
              activeId: document.activeElement?.id ?? "",
            }));
            const ownWritesAfterRelease = after.events.filter(
              (event) => event.type === "own-correction",
            ).length;
            lifecycle.push({
              scenario: currentScenario,
              width,
              candidate,
              phase,
              before,
              after,
              expectedForeign,
              requirements: {
                noWriteAfterRelease:
                  ownWritesAfterRelease === before.sample.ownWrites,
                noFocusAfterRelease: after.activeId === before.sample.activeId,
                stylesRestoredOrForeignPreserved: after.styles.every(
                  (style) => {
                    const foreign = expectedForeign.find(
                      (value) => value.id === style.id,
                    );
                    return foreign
                      ? style.value === foreign.value &&
                          style.priority === foreign.priority
                      : style.value === "" && style.priority === "";
                  },
                ),
              },
            });
          } finally {
            await page.evaluate(() => window.bounceAnchorPrototype.finish());
          }
        }
      }
    }
    expect(results).toHaveLength(96);
    expect(lifecycle).toHaveLength(24);
    expect(
      new Set(
        results.map((result) => (result as { scenario: string }).scenario),
      ).size,
    ).toBe(96);
  } catch (error) {
    harnessError =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw error;
  } finally {
    const receipt = {
      kind: "STATIC_DOM_EXPERIMENT_NOT_APP_ACCEPTANCE",
      browserName,
      browserVersion,
      project: info.project.name,
      retry: info.retry,
      workflowSha: process.env.GITHUB_SHA ?? null,
      completed: harnessError === null,
      currentScenario,
      harnessError,
      resultMeaning:
        "Harness completion only. Applicable false requirements reject candidates; null requirements do not apply. Unexercised input capability is missing evidence. own-write-queued injects scroll-only API navigation synchronously inside the prototype correction, not real assistive input.",
      results,
      lifecycle,
    };
    const destination = path.join(
      "playwright-report",
      `bounce-anchor-${browserName}-${info.project.name}-retry${info.retry}.json`,
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`);
    await info.attach("static-bounce-anchor-observations", {
      body: Buffer.from(JSON.stringify(receipt)),
      contentType: "application/json",
    });
  }
}
