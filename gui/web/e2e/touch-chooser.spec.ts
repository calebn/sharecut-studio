import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import {
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { STUDIO_AXE_DISABLED_RULES } from "./axe";
import { rulerWidthPx } from "./deepZoom";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { setTheme, type Theme } from "./theme";

/*
 * Touch target chooser (#1051 candidate A, lab "touch-chooser") on the real
 * timeline: fixture clusters of 2-4 targets, CDP touch input at a phone and a
 * tablet size and three zoom levels. Measurements and screenshots go to the
 * test output, and also to TOUCH_CHOOSER_EVIDENCE_DIR when it is set.
 */

const CLIENT_ID = "e2e-touch-chooser";
const TRACK = "reference";
const EVIDENCE_DIR = process.env.TOUCH_CHOOSER_EVIDENCE_DIR;
const SESSION_SEC = 60;

const VIEWPORTS = {
  phone: { width: 360, height: 800 },
  tablet: { width: 820, height: 1180 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
/** `=` presses from Fit. */
const ZOOMS = [0, 3, 6] as const;
const CLUSTERS = ["edge", "join-point", "join", "pending"] as const;
type Cluster = (typeof CLUSTERS)[number];

test.use({ hasTouch: true, isMobile: true });
test.describe.configure({ timeout: 900_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-touch-chooser-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

/**
 * Clusters on the reference track:
 * - edge (t=10): a clip join with a 300 ms fade-in and an envelope point on
 *   the edge, its neighbours, the roll seam and join badge;
 * - join-point (t=40): a join badge, its roll seam and an envelope point;
 * - join (t=50): a join badge over its roll seam;
 * - pending (t=24): two adjacent pending cuts, the first selected (a coarse
 *   pointer shows only the selected edit's edge handles).
 */
async function buildFixture(page: Page): Promise<void> {
  const run = (type: string, payload: Record<string, unknown>) =>
    postDocumentCommand(page, CLIENT_ID, type, payload, projectPath);
  for (const at_time of [10, 40, 50]) {
    await run("SplitAtTime", { at_time, track_ids: [TRACK] });
  }
  const right = (await projectJson(page)).clips.tracks[TRACK].find(
    (c) => c.timeline_start === 10,
  );
  if (!right) throw new Error("split at 10 s missing");
  await run("SetClipFade", {
    clip_id: right.id,
    fade_in_ms: 300,
    fade_out_ms: 0,
  });
  await run("SetEnvelope", {
    track_id: TRACK,
    expected_points: [],
    points: [
      { id: "env-a", time: 5, value: 1 },
      { id: "env-edge", time: 10, value: 0.8 },
      { id: "env-c", time: 16, value: 1 },
      { id: "env-join", time: 40, value: 1.2 },
    ],
  });
  await run("SuggestPendingEdit", { track_id: TRACK, start: 20, end: 24 });
  await run("SuggestPendingEdit", { track_id: TRACK, start: 24, end: 28 });
}

type ProjectJson = {
  clips: { tracks: Record<string, { id: string; timeline_start: number }[]> };
  pending_edits: { id: string; source_start: number }[];
};

async function projectJson(page: Page): Promise<ProjectJson> {
  const res = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  return (await res.json()) as ProjectJson;
}

type Command = { type: string; payload: Record<string, unknown> };

/** Document commands the page posts. */
function watchCommands(page: Page): Command[] {
  const seen: Command[] = [];
  page.on("request", (req) => {
    if (
      req.url().includes("/api/document/command") &&
      req.method() === "POST"
    ) {
      const body = req.postDataJSON() as Partial<Command> | null;
      if (body?.type)
        seen.push({ type: body.type, payload: body.payload ?? {} });
    }
  });
  return seen;
}

/** Chip label prefix → the target kind it names. */
const KIND_BY_LABEL: [string, string][] = [
  ["Envelope point", "envelope-point"],
  ["Pending start", "pending-start"],
  ["Pending end", "pending-end"],
  ["Pending split", "pending-flag"],
  ["Fade in", "fade-in"],
  ["Fade out", "fade-out"],
  ["Trim start", "trim-in"],
  ["Trim end", "trim-out"],
  ["Roll", "roll"],
  ["Join", "join"],
  ["Chapter", "chapter"],
];

function labelTarget(label: string): { kind: string; time: number } {
  const kind = KIND_BY_LABEL.find(([prefix]) => label.startsWith(prefix))?.[1];
  const [, mm, ss] = label.match(/at (\d+):(\d+\.\d+)$/) ?? [];
  if (!kind || mm == null) throw new Error(`unparsed chip label ${label}`);
  return { kind, time: Number(mm) * 60 + Number(ss) };
}

type Point = { x: number; y: number };

async function touch(
  cdp: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  points: Point[] = [],
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
}

function save(info: TestInfo, name: string, data: string | Buffer): void {
  const file = info.outputPath(name);
  fs.writeFileSync(file, data);
  if (EVIDENCE_DIR) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.copyFileSync(file, path.join(EVIDENCE_DIR, name));
  }
}

async function shot(info: TestInfo, page: Page, name: string): Promise<void> {
  save(info, `${name}.png`, await page.screenshot());
}

function json(info: TestInfo, name: string, value: unknown): void {
  save(info, `${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

const chooser = (page: Page) =>
  page.locator(".target-chooser:not(.is-closing)");
const chips = (page: Page) => page.getByRole("menuitemradio");

async function chipLabels(page: Page): Promise<string[]> {
  return chips(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label") ?? ""),
  );
}

async function openTimeline(
  page: Page,
  viewport: ViewportName,
  theme: Theme,
): Promise<void> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.goto(
    `/?project=${encodeURIComponent(projectPath)}&lab=touch-chooser`,
  );
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (viewport === "phone") await openPhoneTimeline(page);
  await setTheme(page, theme);
  await expect(
    page.locator('circle[aria-label^="Envelope point 2"]'),
  ).toBeVisible();
}

/** Fit, then `steps` zoom-ins; returns px per second. */
async function setZoom(page: Page, steps: number): Promise<number> {
  await page
    .locator(".time-ruler")
    .first()
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("\\");
  for (let i = 0; i < steps; i += 1) await page.keyboard.press("=");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  return Math.round((await rulerWidthPx(page)) / SESSION_SEC);
}

async function centerOf(page: Page, selector: string): Promise<Point> {
  const el = page.locator(selector).first();
  await el.evaluate((node) =>
    node.scrollIntoView({ block: "center", inline: "center" }),
  );
  await page.waitForTimeout(100);
  const box = await el.boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const lane = `.lane-row[data-track-id="${TRACK}"]`;

/** Where a finger lands on each cluster. */
async function clusterPoint(page: Page, cluster: Cluster): Promise<Point> {
  if (cluster === "edge") {
    return centerOf(
      page,
      `${lane} [data-hit-kind="envelope-point"][data-hit-id="env-edge"]`,
    );
  }
  if (cluster === "pending") {
    const edits = (await projectJson(page)).pending_edits;
    const region = (start: number) =>
      `${lane} .pending-overlay[data-pending-id="${edits.find((e) => e.source_start === start)?.id}"] .pending-hit`;
    await page.locator(region(20)).first().click();
    const a = await centerOf(page, region(20));
    const first = (await page.locator(region(20)).first().boundingBox())!;
    const second = (await page.locator(region(24)).first().boundingBox())!;
    return { x: (first.x + first.width + second.x) / 2, y: a.y };
  }
  // Between the join badge and the top of its roll seam.
  const time = cluster === "join-point" ? 40 : 50;
  const badge = await centerOf(
    page,
    `${lane} [data-hit-kind="join"][data-hit-time="${time}"]`,
  );
  const seam = (await page
    .locator(`${lane} [data-hit-kind="roll"][data-hit-time="${time}"]`)
    .first()
    .boundingBox())!;
  return { x: badge.x, y: (badge.y + seam.y) / 2 };
}

/** Holds still until the chooser opens, then lifts at the origin. */
async function openAt(
  cdp: CDPSession,
  page: Page,
  at: Point,
): Promise<boolean> {
  await touch(cdp, "touchStart", [at]);
  await page.waitForTimeout(320);
  const opened = (await chooser(page).count()) > 0;
  await touch(cdp, "touchEnd");
  // Let the entrance finish before anything measures or screenshots it.
  await page.waitForTimeout(250);
  return opened;
}

async function closeChooser(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator(".target-chooser")).toHaveCount(0);
}

async function newTouchPage(
  context: BrowserContext,
): Promise<{ page: Page; cdp: CDPSession }> {
  const page = await context.newPage();
  return { page, cdp: await context.newCDPSession(page) };
}

test("clusters open the chooser at every size and zoom", async ({
  page,
  context,
}, info) => {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page);
  const rows: unknown[] = [];
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    const { page: p, cdp } = await newTouchPage(context);
    await openTimeline(p, viewport, "dark");
    for (const zoom of ZOOMS) {
      const pxPerSec = await setZoom(p, zoom);
      for (const cluster of CLUSTERS) {
        const at = await clusterPoint(p, cluster);
        const opened = await openAt(cdp, p, at);
        const labels = opened ? await chipLabels(p) : [];
        rows.push({
          viewport,
          zoom,
          pxPerSec,
          cluster,
          at,
          opened,
          chips: labels,
        });
        if (opened) {
          await shot(info, p, `${viewport}-z${zoom}-${cluster}-dark`);
          await closeChooser(p);
        }
        await p.keyboard.press("Escape");
      }
    }
    await p.close();
  }
  json(info, "clusters", rows);
  const opened = rows.filter((r) => (r as { opened: boolean }).opened);
  expect(opened.length).toBeGreaterThan(0);
});

test("unambiguous touches never open the chooser", async ({
  page,
  context,
}, info) => {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page);
  const rows: {
    viewport: string;
    zoom: number;
    at: Point;
    kind: string;
    opened: boolean;
  }[] = [];
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    const { page: p, cdp } = await newTouchPage(context);
    await openTimeline(p, viewport, "dark");
    for (const zoom of ZOOMS) {
      await setZoom(p, zoom);
      // Clip bodies away from their edges, on both tracks, plus one lane gap.
      const spots = await p.evaluate(() => {
        const out: { x: number; y: number; kind: string }[] = [];
        for (const clip of document.querySelectorAll(".lane-row .clip-block")) {
          const r = clip.getBoundingClientRect();
          if (r.width < 120 || r.right < 0 || r.left > innerWidth) continue;
          const left = Math.max(r.left, 0);
          const right = Math.min(r.right, innerWidth);
          if (right - left < 120) continue;
          for (const t of [0.35, 0.5, 0.65]) {
            out.push({
              x: left + (right - left) * t,
              y: r.top + r.height * 0.75,
              kind: "clip body",
            });
          }
        }
        return out;
      });
      for (const spot of spots) {
        for (const gesture of ["hold", "tap"] as const) {
          await touch(cdp, "touchStart", [spot]);
          await p.waitForTimeout(gesture === "hold" ? 400 : 60);
          const opened = (await chooser(p).count()) > 0;
          await touch(cdp, "touchEnd");
          rows.push({
            viewport,
            zoom,
            at: spot,
            kind: `${spot.kind} ${gesture}`,
            opened,
          });
          if (opened) await closeChooser(p);
          await p.keyboard.press("Escape");
        }
      }
    }
    await p.close();
  }
  json(info, "unambiguous", {
    touches: rows.length,
    opens: rows.filter((r) => r.opened).length,
    rows,
  });
  expect(rows.length).toBeGreaterThan(20);
  expect(rows.filter((r) => r.opened)).toEqual([]);
});

/** What a pick changes: selection, open join popover, focus. */
async function pickState(page: Page) {
  return page.evaluate(() => ({
    pressedPoint:
      document
        .querySelector('circle[aria-pressed="true"]')
        ?.getAttribute("data-hit-id") ?? null,
    selectedClips: [...document.querySelectorAll(".clip-block.selected")].map(
      (el) => el.getAttribute("data-clip-id"),
    ),
    openJoin:
      document
        .querySelector('.join-badge[aria-expanded="true"]')
        ?.getAttribute("data-hit-id") ?? null,
    focused: document.activeElement?.getAttribute("data-hit-kind") ?? null,
  }));
}

test("each chip picks its own target", async ({ page }, info) => {
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page);
  await openTimeline(page, "phone", "dark");
  const results: {
    cluster: string;
    chip: string;
    target: { kind: string; id: string | null };
    after: Awaited<ReturnType<typeof pickState>>;
    picked: boolean;
  }[] = [];
  for (const cluster of ["edge", "join-point"] as const) {
    await setZoom(page, 0);
    const at = await clusterPoint(page, cluster);
    expect(await openAt(cdp, page, at)).toBe(true);
    const count = await chips(page).count();
    for (let i = 0; i < count; i += 1) {
      if (i > 0) {
        await page.reload();
        await openTimeline(page, "phone", "dark");
        await setZoom(page, 0);
        expect(await openAt(cdp, page, await clusterPoint(page, cluster))).toBe(
          true,
        );
      }
      const chip = chips(page).nth(i);
      const label = (await chip.getAttribute("aria-label")) ?? "";
      const want = labelTarget(label);
      const id = await page.evaluate(
        ({ kind, time }) =>
          [...document.querySelectorAll(`[data-hit-kind="${kind}"]`)]
            .find(
              (el) =>
                Math.abs(Number(el.getAttribute("data-hit-time")) - time) <
                0.001,
            )
            ?.getAttribute("data-hit-id") ?? null,
        want,
      );
      const box = (await chip.boundingBox())!;
      await touch(cdp, "touchStart", [
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      ]);
      await touch(cdp, "touchEnd");
      await expect(chooser(page)).toHaveCount(0);
      await page.waitForTimeout(300);
      const after = await pickState(page);
      const picked =
        want.kind === "envelope-point"
          ? after.pressedPoint === id
          : want.kind === "join"
            ? after.openJoin === id
            : after.selectedClips.includes(id);
      results.push({
        cluster,
        chip: label,
        target: { kind: want.kind, id },
        after,
        picked,
      });
    }
  }
  json(info, "selection", results);
  expect(results.length).toBeGreaterThan(3);
  expect(results.filter((r) => !r.picked)).toEqual([]);
});

test("cancel paths close with no change; an early move drags the winner", async ({
  page,
}, info) => {
  const cdp = await page.context().newCDPSession(page);
  const commands = watchCommands(page);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page);
  await openTimeline(page, "phone", "dark");
  await setZoom(page, 0);
  const at = await clusterPoint(page, "edge");
  const before = JSON.stringify(await projectJson(page));
  commands.length = 0;
  const results: Record<string, unknown> = {};

  expect(await openAt(cdp, page, at)).toBe(true);
  await page.keyboard.press("Escape");
  results.escape = (await chooser(page).count()) === 0;
  await page.waitForTimeout(200);

  expect(await openAt(cdp, page, at)).toBe(true);
  await touch(cdp, "touchStart", [{ x: 20, y: 760 }]);
  await touch(cdp, "touchEnd");
  results.tapOutside = (await chooser(page).count()) === 0;
  await page.waitForTimeout(200);

  await touch(cdp, "touchStart", [at]);
  await page.waitForTimeout(320);
  await touch(cdp, "touchStart", [at, { x: at.x + 60, y: at.y + 80 }]);
  results.secondFinger = (await chooser(page).count()) === 0;
  await touch(cdp, "touchEnd");
  await page.waitForTimeout(200);

  await touch(cdp, "touchStart", [at]);
  await page.waitForTimeout(320);
  await touch(cdp, "touchCancel");
  results.pointercancel = (await chooser(page).count()) === 0;
  await page.waitForTimeout(200);

  results.commandsAfterCancels = commands.map((c) => c.type);
  results.projectUnchanged = JSON.stringify(await projectJson(page)) === before;

  await touch(cdp, "touchStart", [at]);
  await touch(cdp, "touchMove", [{ x: at.x, y: at.y - 6 }]);
  await touch(cdp, "touchMove", [{ x: at.x, y: at.y - 20 }]);
  await page.waitForTimeout(320);
  results.earlyMoveOpened = (await chooser(page).count()) > 0;
  await touch(cdp, "touchEnd");
  await expect.poll(() => commands.length).toBeGreaterThan(0);
  results.earlyMoveCommands = commands.map((c) => c.type);

  json(info, "cancel", results);
  expect(results).toMatchObject({
    escape: true,
    tapOutside: true,
    secondFinger: true,
    pointercancel: true,
    commandsAfterCancels: [],
    projectUnchanged: true,
    earlyMoveOpened: false,
  });
});

test("resting on a chip grabs its target and keeps dragging", async ({
  page,
}, info) => {
  const cdp = await page.context().newCDPSession(page);
  const commands = watchCommands(page);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page);
  await openTimeline(page, "phone", "dark");
  await setZoom(page, 0);
  const at = await clusterPoint(page, "edge");
  commands.length = 0;
  await touch(cdp, "touchStart", [at]);
  await page.waitForTimeout(320);
  await page.waitForTimeout(250);
  const chip = page.getByRole("menuitemradio", {
    name: /Envelope point 0\.80×/,
  });
  const box = (await chip.boundingBox())!;
  const onChip = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await touch(cdp, "touchMove", [
    { x: (at.x + onChip.x) / 2, y: (at.y + onChip.y) / 2 },
  ]);
  await touch(cdp, "touchMove", [onChip]);
  await page.waitForTimeout(320);
  const closedOnGrab = (await chooser(page).count()) === 0;
  await touch(cdp, "touchMove", [{ x: onChip.x, y: onChip.y - 10 }]);
  await touch(cdp, "touchMove", [{ x: onChip.x, y: onChip.y - 20 }]);
  await touch(cdp, "touchEnd");
  await expect
    .poll(() => commands.some((c) => c.type === "SetEnvelope"))
    .toBe(true);
  const set = commands.find((c) => c.type === "SetEnvelope");
  const points = (set?.payload.points ?? []) as {
    id: string;
    time: number;
    value: number;
  }[];
  const edge = points.find((pt) => pt.id === "env-edge");
  const pxPerSec = Math.round((await rulerWidthPx(page)) / SESSION_SEC);
  json(info, "grab", { closedOnGrab, pxPerSec, commands, envEdge: edge });
  expect(closedOnGrab).toBe(true);
  // Grabbed from the chip 64 px away, the point keeps its time (to a pixel)
  // and rises with the 20 px drag instead of jumping to the finger.
  expect(Math.abs((edge?.time ?? 0) - 10)).toBeLessThan(1 / pxPerSec);
  expect(edge?.value).toBeGreaterThan(0.8);
});

test("axe, themes and reduced motion with the chooser open", async ({
  browser,
}, info) => {
  const results: Record<string, unknown> = {};
  for (const reduced of [false, true]) {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const { page, cdp } = await newTouchPage(context);
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    if (!reduced) await buildFixture(page);
    for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
      for (const theme of ["dark", "light"] as const) {
        if (reduced && (viewport !== "phone" || theme !== "dark")) continue;
        await openTimeline(page, viewport, theme);
        await setZoom(page, 0);
        const at = await clusterPoint(page, "edge");
        await touch(cdp, "touchStart", [at]);
        await page.waitForTimeout(270);
        const animations = await page.evaluate(() =>
          [...document.querySelectorAll(".target-chip")].reduce(
            (n, el) => n + el.getAnimations().length,
            0,
          ),
        );
        await touch(cdp, "touchEnd");
        if (reduced) {
          await shot(info, page, "phone-reduced-motion-dark");
          results.reducedMotionChipAnimations = animations;
        } else {
          await page.waitForTimeout(250);
          await shot(info, page, `${viewport}-edge-${theme}`);
          const axe = await new AxeBuilder({ page })
            .include(".target-chooser")
            .disableRules([...STUDIO_AXE_DISABLED_RULES])
            .analyze();
          const contrast = await new AxeBuilder({ page })
            .include(".target-chooser-caption")
            .withRules(["color-contrast"])
            .analyze();
          results[`${viewport}-${theme}`] = {
            animationsWhileOpening: animations,
            axeViolations: axe.violations.map((v) => v.id),
            labelContrastViolations: contrast.violations.map((v) => v.id),
          };
        }
        await closeChooser(page);
      }
    }
    await context.close();
  }
  json(info, "a11y-motion", results);
  expect(results.reducedMotionChipAnimations).toBe(0);
  for (const key of [
    "phone-dark",
    "phone-light",
    "tablet-dark",
    "tablet-light",
  ]) {
    expect(results[key]).toMatchObject({
      axeViolations: [],
      labelContrastViolations: [],
    });
  }
});

test("video: open, pick and grab in both themes", async ({ browser }, info) => {
  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: VIEWPORTS.phone,
      recordVideo: {
        dir: info.outputPath(`video-${theme}`),
        size: VIEWPORTS.phone,
      },
    });
    const { page, cdp } = await newTouchPage(context);
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    if (theme === "dark") await buildFixture(page);
    await openTimeline(page, "phone", theme);
    await setZoom(page, 0);
    const at = await clusterPoint(page, "edge");
    await page.waitForTimeout(600);
    expect(await openAt(cdp, page, at)).toBe(true);
    await page.waitForTimeout(700);
    const box = (await chips(page).last().boundingBox())!;
    await touch(cdp, "touchStart", [
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    ]);
    await touch(cdp, "touchEnd");
    await page.waitForTimeout(900);
    await touch(cdp, "touchStart", [at]);
    await page.waitForTimeout(600);
    const env = page.getByRole("menuitemradio", {
      name: /^Envelope point .* at 00:(09\.99|10\.0)/,
    });
    const e = (await env.boundingBox())!;
    const onChip = { x: e.x + e.width / 2, y: e.y + e.height / 2 };
    for (let k = 1; k <= 6; k += 1) {
      await touch(cdp, "touchMove", [
        {
          x: at.x + ((onChip.x - at.x) * k) / 6,
          y: at.y + ((onChip.y - at.y) * k) / 6,
        },
      ]);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(450);
    for (let k = 1; k <= 8; k += 1) {
      await touch(cdp, "touchMove", [{ x: onChip.x, y: onChip.y - k * 3 }]);
      await page.waitForTimeout(50);
    }
    await touch(cdp, "touchEnd");
    await page.waitForTimeout(900);
    const video = page.video();
    await context.close();
    if (video) {
      const file = await video.path();
      save(info, `phone-chooser-${theme}.webm`, fs.readFileSync(file));
    }
  }
});
