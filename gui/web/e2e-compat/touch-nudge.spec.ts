import { AxeBuilder } from "@axe-core/playwright";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { STUDIO_AXE_DISABLED_RULES } from "../e2e/axe";
import { postDocumentCommand } from "../e2e/documentCommand";
import { e2eProjectPath } from "../e2e/env";
import { type Finger, newFinger, type Point } from "../e2e/finger";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { setTheme } from "../e2e/theme";
import {
  buildFixture,
  type CaseFixtures,
  centerOf,
  json,
  lane,
  save,
  setZoom,
  TRACK,
  watchCommands,
} from "../e2e/touchTimeline";

/*
 * #1051 round 4: strip nudges repeat while held and save the run as one
 * edit; a held run stops at a soft boundary (a clip edge, the next pending
 * edit) with a cue, and a fresh press goes past it. Pending edits and
 * envelope points get the same nudge rows as a clip's fade and trim. Real
 * timeline, Chromium (CDP touch) and WebKit (touch-typed pointer events).
 * Frames for the GIFs go to the test output and TOUCH_CHOOSER_EVIDENCE_DIR.
 */

const CLIENT_ID = "e2e-touch-nudge";
const SIZES = {
  "portrait-360": { width: 360, height: 800 },
  "landscape-844": { width: 844, height: 390 },
} as const;
type SizeName = keyof typeof SIZES;

test.use({ hasTouch: true });
test.describe.configure({ timeout: 300_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-touch-nudge-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

type Saved = {
  envelopes: {
    track_id: string;
    points: { id: string; time: number; value: number }[];
  }[];
  pending_edits: { id: string; source_start: number; source_end: number }[];
};

async function saved(page: Page): Promise<Saved> {
  const res = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  return (await res.json()) as Saved;
}

const pointTime = async (page: Page, id: string) =>
  (await saved(page)).envelopes
    .find((e) => e.track_id === TRACK)
    ?.points.find((p) => p.id === id)?.time;

/**
 * The shared fixture plus a point 0.3 s before the clip edge at 50 s and a
 * pending cut whose start is 0.5 s after the next one's end (28 s).
 */
async function fixture(page: Page) {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  const points = (await saved(page)).envelopes.find(
    (e) => e.track_id === TRACK,
  )?.points;
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SetEnvelope",
    {
      track_id: TRACK,
      expected_points: points,
      points: [...(points ?? []), { id: "env-near", time: 49.7, value: 1 }],
    },
    projectPath,
  );
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SuggestPendingEdit",
    { track_id: TRACK, start: 28.5, end: 30 },
    projectPath,
  );
}

async function open(page: Page, size: SizeName, theme: "dark" | "light") {
  await page.setViewportSize(SIZES[size]);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (SIZES[size].width < 768) await openPhoneTimeline(page);
  await setTheme(page, theme);
  await setZoom(page, 3);
}

async function centerOfBox(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox({ timeout: 5000 });
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tap(page: Page, finger: Finger, at: Point) {
  await finger.down(at);
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(700);
}

/** Holds a finger on `button` for `ms`, saving a frame every `everyMs`. */
async function hold(
  page: Page,
  finger: Finger,
  button: Locator,
  ms: number,
  frame?: (n: number) => Promise<void>,
  everyMs = 120,
) {
  await finger.down(await centerOfBox(button));
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < ms) {
    if (frame) await frame(n++);
    await page.waitForTimeout(frame ? everyMs : ms);
  }
  await finger.up();
  await page.waitForTimeout(800);
}

const rowValue = (page: Page, label: string) =>
  page
    .locator(".nudge-row", { hasText: label })
    .locator(".nudge-row-value")
    .textContent();

test("a held nudge repeats, saves once, and one Undo restores it", async ({
  page,
  context,
  browserName,
}, info) => {
  await fixture(page);
  await open(page, "portrait-360", "dark");
  const finger = await newFinger(context, page, browserName);
  await tap(
    page,
    finger,
    await centerOf(page, `${lane} [data-hit-id="env-c"]`),
  );
  const commands = watchCommands(page);
  const values: string[] = [];
  await hold(
    page,
    finger,
    page.getByRole("button", { name: "Envelope point 0.01 s later" }),
    1500,
    async (n) => {
      values.push((await rowValue(page, "Time")) ?? "");
      save(
        info,
        `hold-repeat-${browserName}-${String(n).padStart(2, "0")}.png`,
        await page.screenshot(),
      );
    },
  );
  const after = await pointTime(page, "env-c");
  const types = commands.map((c) => c.type);
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "UndoHistory",
    { rerender: false },
    projectPath,
  );
  const undone = await pointTime(page, "env-c");
  json(info, `hold-repeat-${browserName}`, { values, types, after, undone });
  // The value moves on during the hold, not only on release.
  expect(new Set(values).size).toBeGreaterThan(3);
  expect(types).toEqual(["SetEnvelope"]);
  expect(after).toBeGreaterThan(16.08);
  expect(undone).toBe(16);
});

test("a held nudge stops at a soft boundary with a cue; a fresh press goes past", async ({
  page,
  context,
  browserName,
}, info) => {
  await fixture(page);
  await open(page, "portrait-360", "dark");
  const finger = await newFinger(context, page, browserName);
  const rows: Record<string, unknown>[] = [];
  const announced = () =>
    page.evaluate(
      () =>
        document.querySelector(".daw-shell [role='status'][aria-live]")
          ?.textContent ?? null,
    );

  // An envelope point 0.3 s before the clip edge at 50 s.
  await tap(
    page,
    finger,
    await centerOf(page, `${lane} [data-hit-id="env-near"]`),
  );
  const later = page.getByRole("button", {
    name: "Envelope point 0.1 s later",
  });
  let n = 0;
  await hold(page, finger, later, 2500, async () => {
    save(
      info,
      `boundary-stop-${browserName}-${String(n++).padStart(2, "0")}.png`,
      await page.screenshot(),
    );
  });
  rows.push({
    case: "held point stops at the clip edge",
    saved: await pointTime(page, "env-near"),
    note: await announced(),
  });
  await tap(page, finger, await centerOfBox(later));
  rows.push({
    case: "fresh press crosses it",
    saved: await pointTime(page, "env-near"),
  });

  // A pending cut whose start is 0.5 s after the previous cut's end.
  const pending = (await saved(page)).pending_edits.find(
    (e) => e.source_start === 28.5,
  );
  if (!pending) throw new Error("pending 28.5 s missing");
  await tap(
    page,
    finger,
    await centerOf(page, `${lane} [data-pending-id="${pending.id}"]`),
  );
  const earlier = page.getByRole("button", {
    name: "Pending remove start 0.1 s earlier",
  });
  await hold(page, finger, earlier, 2500);
  const start = async () =>
    (await saved(page)).pending_edits.find((e) => e.id === pending.id)
      ?.source_start;
  rows.push({
    case: "held pending start stops at the previous cut's end",
    saved: await start(),
    note: await announced(),
  });
  await tap(page, finger, await centerOfBox(earlier));
  rows.push({ case: "fresh press crosses it", saved: await start() });
  json(info, `boundary-stop-${browserName}`, rows);
  expect(rows.map((r) => r.saved)).toEqual([50, 50.1, 28, 27.9]);
  expect(rows[0].note).toBe("Envelope point saved at a clip edge");
  expect(rows[2].note).toBe("Pending edit timing saved at the pending remove");
});

async function pendingAndEnvelopeStrips(
  size: SizeName,
  { page, context, browserName }: CaseFixtures,
  info: TestInfo,
): Promise<void> {
  await fixture(page);
  const rows: Record<string, unknown>[] = [];
  for (const theme of ["dark", "light"] as const) {
    await open(page, size, theme);
    const finger = await newFinger(context, page, browserName);
    for (const [name, selector] of [
      ["envelope", `${lane} [data-hit-id="env-c"]`],
      ["pending", `${lane} [data-pending-id] >> nth=0`],
    ] as const) {
      await tap(page, finger, await centerOf(page, selector));
      await expect(page.locator(".nudge-row").first()).toBeVisible();
      save(
        info,
        `strip-${name}-${size}-${theme}-${browserName}.png`,
        await page.screenshot(),
      );
      const axe = await new AxeBuilder({ page })
        .disableRules([...STUDIO_AXE_DISABLED_RULES])
        .include(".bottom-sheet")
        .analyze();
      rows.push({
        name,
        theme,
        rows: await page.locator(".nudge-row").evaluateAll((els) =>
          els.map((row) => ({
            label: row.querySelector(".nudge-row-label")?.textContent,
            value: row.querySelector(".nudge-row-value")?.textContent,
            buttons: [...row.querySelectorAll("button")].map((b) => {
              const r = b.getBoundingClientRect();
              return {
                label: b.getAttribute("aria-label"),
                w: Math.round(r.width),
                h: Math.round(r.height),
                inView: r.top >= 0 && r.bottom <= innerHeight,
              };
            }),
          })),
        ),
        axe: axe.violations.map((v) => v.id),
      });
    }
  }
  json(info, `strip-rows-${size}-${browserName}`, rows);
  for (const row of rows as {
    name: string;
    rows: {
      label: string;
      buttons: { w: number; h: number; inView: boolean }[];
    }[];
    axe: string[];
  }[]) {
    expect(row.axe).toEqual([]);
    expect(row.rows.map((r) => r.label)).toEqual(
      row.name === "envelope" ? ["Time", "Level"] : ["Start", "End"],
    );
    for (const button of row.rows.flatMap((r) => r.buttons)) {
      expect(Math.min(button.w, button.h)).toBeGreaterThanOrEqual(44);
      expect(button.inView).toBe(true);
    }
  }
}

test("pending and envelope strips: nudge rows, targets and axe (portrait-360)", ({
  page,
  context,
  browserName,
}, info) =>
  pendingAndEnvelopeStrips(
    "portrait-360",
    { page, context, browserName },
    info,
  ));

test("pending and envelope strips: nudge rows, targets and axe (landscape-844)", ({
  page,
  context,
  browserName,
}, info) =>
  pendingAndEnvelopeStrips(
    "landscape-844",
    { page, context, browserName },
    info,
  ));
