import fs from "node:fs";
import path from "node:path";
import {
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { rulerWidthPx } from "./deepZoom";
import { postDocumentCommand } from "./documentCommand";
import { openPhoneTimeline } from "./phoneTimeline";
import { setTheme, type Theme } from "./theme";

/*
 * Shared real-timeline touch harness for the #1051 specs: a fixture of
 * crowded and lone targets on the reference track, CDP touch input, and
 * evidence written to the test output and to TOUCH_CHOOSER_EVIDENCE_DIR.
 */

export const TRACK = "reference";
export const SESSION_SEC = 60;
const EVIDENCE_DIR = process.env.TOUCH_CHOOSER_EVIDENCE_DIR;

export const VIEWPORTS = {
  phone: { width: 360, height: 800 },
  tablet: { width: 820, height: 1180 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export type Point = { x: number; y: number };

/**
 * Clusters on the reference track:
 * - edge (t=10): a clip join with a 300 ms fade-in and an envelope point on
 *   the edge, its neighbours, the roll seam and join badge;
 * - join-point (t=40): a join badge, its roll seam and an envelope point;
 * - join (t=50): a join badge over its roll seam;
 * - pending (t=24): two adjacent pending cuts.
 * env-c (t=16) is a lone envelope point.
 */
export async function buildFixture(
  page: Page,
  projectPath: string,
  clientId: string,
): Promise<void> {
  const run = (type: string, payload: Record<string, unknown>) =>
    postDocumentCommand(page, clientId, type, payload, projectPath);
  for (const at_time of [10, 40, 50]) {
    await run("SplitAtTime", { at_time, track_ids: [TRACK] });
  }
  const right = (await projectJson(page, projectPath)).clips.tracks[TRACK].find(
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

export type ProjectJson = {
  clips: { tracks: Record<string, { id: string; timeline_start: number }[]> };
  pending_edits: { id: string; source_start: number }[];
};

export async function projectJson(
  page: Page,
  projectPath: string,
): Promise<ProjectJson> {
  const res = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  return (await res.json()) as ProjectJson;
}

export type Command = { type: string; payload: Record<string, unknown> };

/** Document commands the page posts. */
export function watchCommands(page: Page): Command[] {
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

export async function touch(
  cdp: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  points: Point[] = [],
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
}

/** One finger from `from` by `delta`, in `steps` moves `stepMs` apart. */
export async function touchDrag(
  cdp: CDPSession,
  page: Page,
  from: Point,
  delta: Point,
  { steps = 12, stepMs = 16, holdMs = 0 } = {},
): Promise<void> {
  await touch(cdp, "touchStart", [from]);
  if (holdMs) await page.waitForTimeout(holdMs);
  for (let k = 1; k <= steps; k += 1) {
    await touch(cdp, "touchMove", [
      { x: from.x + (delta.x * k) / steps, y: from.y + (delta.y * k) / steps },
    ]);
    await page.waitForTimeout(stepMs);
  }
  await touch(cdp, "touchEnd");
}

export function save(info: TestInfo, name: string, data: string | Buffer) {
  const file = info.outputPath(name);
  fs.writeFileSync(file, data);
  if (EVIDENCE_DIR) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.copyFileSync(file, path.join(EVIDENCE_DIR, name));
  }
}

export async function shot(info: TestInfo, page: Page, name: string) {
  save(info, `${name}.png`, await page.screenshot());
}

export function json(info: TestInfo, name: string, value: unknown): void {
  save(info, `${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

export async function newTouchPage(
  context: BrowserContext,
): Promise<{ page: Page; cdp: CDPSession }> {
  const page = await context.newPage();
  return { page, cdp: await context.newCDPSession(page) };
}

/** Opens the project's timeline, with `lab` (e.g. "touch-chooser") if set. */
export async function openTimeline(
  page: Page,
  projectPath: string,
  viewport: ViewportName,
  theme: Theme,
  lab: string | null = "touch-chooser",
): Promise<void> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  const query = lab ? `&lab=${lab}` : "";
  await page.goto(`/?project=${encodeURIComponent(projectPath)}${query}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (viewport === "phone") await openPhoneTimeline(page);
  await setTheme(page, theme);
  await expect(
    page.locator('circle[aria-label^="Envelope point 2"]'),
  ).toBeVisible();
}

/** Fit, then `steps` zoom-ins; returns px per second. */
export async function setZoom(page: Page, steps: number): Promise<number> {
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

export async function centerOf(page: Page, selector: string): Promise<Point> {
  const el = page.locator(selector).first();
  await el.evaluate((node) =>
    node.scrollIntoView({ block: "center", inline: "center" }),
  );
  await page.waitForTimeout(100);
  const box = await el.boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export const lane = `.lane-row[data-track-id="${TRACK}"]`;

/** What a press changes: selection, open join popover, focus, sheets. */
export async function pickState(page: Page) {
  return page.evaluate(() => ({
    pressedPoint:
      document
        .querySelector('circle[aria-pressed="true"]')
        ?.getAttribute("aria-label") ?? null,
    pressedPointId:
      document
        .querySelector('circle[aria-pressed="true"]')
        ?.getAttribute("data-hit-id") ?? null,
    openJoinId:
      document
        .querySelector('.join-badge[aria-expanded="true"]')
        ?.getAttribute("data-hit-id") ?? null,
    selectedClips: [...document.querySelectorAll(".clip-block.selected")].map(
      (el) => el.getAttribute("data-clip-id"),
    ),
    openJoin:
      document
        .querySelector('.join-badge[aria-expanded="true"]')
        ?.getAttribute("aria-label") ?? null,
    focused: document.activeElement?.getAttribute("aria-label") ?? null,
    sheet: document.querySelector(".bottom-sheet-root") != null,
    textSelection: document.getSelection()?.toString() ?? "",
  }));
}
