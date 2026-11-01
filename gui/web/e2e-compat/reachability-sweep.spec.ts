import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  openEnvelopePoint,
  showEnvelope,
} from "../e2e/envelopeCreationEvidence";
import { createRelocatedE2eProject } from "../e2e/liveProject";
import { openHostProject } from "../e2e/overlayReachability";
import { openSuggestedPendingEdit } from "../e2e/pendingEdit";
import {
  openPhoneTimeline,
  rememberInspectorDetent,
} from "../e2e/phoneTimeline";
import { describeReach, type Reach, reachFailures } from "../e2e/reachability";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import {
  armRange,
  inspectSelection,
  openPanel,
  phone as stagePhone,
} from "../e2e/stageNav";
import { setTheme, type Theme, withAppearance } from "../e2e/theme";

test.use({ hasTouch: true, actionTimeout: 15_000 });
test.describe.configure({ timeout: 600_000 });

/**
 * One sweep over the touch surfaces at the shell boundaries and two text
 * scales: every interactive control is at least 44 CSS px, sits inside the
 * visual viewport once scrolled to, and is not under another element or a
 * scrim. Sizes are layout boxes, so a transition cannot shrink one (#1418).
 *
 * The selection surfaces (sheet, armed range), the shell chrome, Review and the
 * Script and Prepare stages are swept whole, at every cell. A control inside a
 * closed <details> is not a control until it opens. Transcript words and their
 * timestamps are inline text and wait on the dense-target decision (DENSE).
 */
type Cell = {
  name: string;
  width: number;
  height: number;
  rootPx: number;
};

const PHONES: readonly Cell[] = [
  { name: "phone 360", width: 360, height: 780, rootPx: 16 },
  {
    name: "phone 360, 200% text",
    width: 360,
    height: 780,
    rootPx: 32,
  },
  { name: "phone 390", width: 390, height: 844, rootPx: 16 },
  {
    name: "phone 390, 200% text",
    width: 390,
    height: 844,
    rootPx: 32,
  },
  { name: "phone max 767", width: 767, height: 1000, rootPx: 16 },
];

const TABLETS: readonly Cell[] = [
  { name: "tablet min 768", width: 768, height: 1024, rootPx: 16 },
  { name: "tablet 820", width: 820, height: 1180, rootPx: 16 },
  {
    name: "tablet 820, 200% text",
    width: 820,
    height: 1180,
    rootPx: 32,
  },
  { name: "tablet max 1194", width: 1194, height: 800, rootPx: 16 },
  {
    name: "desktop min 1195",
    width: 1195,
    height: 800,
    rootPx: 16,
  },
];

const LANDSCAPES: readonly Cell[] = [
  {
    name: "phone landscape 844",
    width: 844,
    height: 390,
    rootPx: 16,
  },
  {
    name: "iPad landscape 1180",
    width: 1180,
    height: 834,
    rootPx: 16,
  },
  {
    name: "iPad Pro 11 landscape 1194",
    width: 1194,
    height: 834,
    rootPx: 16,
  },
  {
    name: "iPad landscape short Safari",
    width: 1180,
    height: 620,
    rootPx: 16,
  },
];

const REACHABILITY_CELLS = [...PHONES, ...TABLETS, ...LANDSCAPES];

/**
 * Canvas targets reach 44 px through the dense-target pattern
 * (docs/communication-philosophy.md): their hit area grows invisibly and the
 * selected target is editable from 44 px inspector controls. The tab strip
 * carries the same actions.
 */
const DENSE = [
  ".fade-corner",
  ".trim-handle",
  ".clip-hit",
  ".sys-ruler-body",
  ".track-headers-well",
  // Transcript text: inline words in running text, where a taller hit area would take
  // the neighbouring line's taps (docs/communication-philosophy.md, #1602). The speaker
  // button holds the floor.
  ".sys-script-word",
  ".sys-script-time",
  // The drawer's detent range is the keyboard route; a finger swipes the header or
  // taps the resize buttons.
  ".bottom-sheet-detent",
];

/** The peek strip is a BottomSheet; every other selection surface is the Inspector sheet. */
const SHEET = ".bottom-sheet, .sys-inspector";
const SHEET_BODY = ".bottom-sheet-body, .sys-inspector-scroll";

const SIZE_EXEMPT = [".sys-marker-hit"];

/** The Script pane, which the Edit stage's own scan leaves to its own sweep. */
const PANELS = [".edit-script", ".phone-edit-script"];

/** What a stage other than Edit shows between the header and the Player. */
const STAGE_BODY = ".stage-frame-body";

async function arrive(
  page: Page,
  cell: Cell,
  open: (page: Page) => Promise<void> = openHostProject,
) {
  await page.setViewportSize({ width: cell.width, height: cell.height });
  await open(page);
  if (cell.width <= 767) await openPhoneTimeline(page);
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, cell.rootPx);
  await expect
    .poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches))
    .toBe(true);
}

async function settle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .getAnimations()
          .every((a) => a.playState === "finished" || a.playState === "idle"),
      ),
    )
    .toBe(true);
}

/** Select the first clip with a tap and sweep the surface that opens for it. */
async function clipSurface(page: Page, sheet: boolean): Promise<Reach[]> {
  const hit = page.locator(".lane-row .clip-hit").first();
  await hit.scrollIntoViewIfNeeded();
  const point = await hit.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const scroll = el.closest(".timeline-scroll")!.getBoundingClientRect();
    const left = Math.max(box.left, scroll.left);
    const right = Math.min(box.right, scroll.right, innerWidth);
    const top = Math.max(box.top, scroll.top);
    const bottom = Math.min(box.bottom, scroll.bottom, innerHeight);
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  });
  await page.touchscreen.tap(point.x, point.y);
  await inspectSelection(page);
  // A phone selection opens the drawer at its strip; the body shows from half height.
  const expand = page.getByRole("button", { name: /^Expand to/ });
  while (await expand.isVisible()) {
    await expand.click();
    await settle(page);
    if (await page.locator(".modifier-badge").isVisible()) break;
  }
  await expect(page.locator(".modifier-badge")).toHaveText("Clip");
  const surface = sheet ? SHEET : "aside.inspector";
  await expect(page.locator(surface)).toBeVisible();
  await settle(page);
  const failures = await reachFailures(page, {
    scope: surface,
    dense: DENSE,
    sizeExempt: SIZE_EXEMPT,
  });
  if (sheet) {
    await page.locator(SHEET).getByRole("button", { name: "Close" }).click();
    await expect(page.locator(SHEET)).toHaveCount(0);
  }
  return failures;
}

async function sweepCell(
  page: Page,
  cell: Cell,
  theme: Theme,
  projectPath: string,
): Promise<string> {
  const phone = cell.width <= 767;
  const sheet = cell.width <= 1194;
  const found: Record<string, Reach[]> = {};
  await arrive(page, cell, (p) => openHostShare(p, projectPath));
  await setTheme(page, theme);

  found["shell chrome"] = await reachFailures(page, {
    skip: [".bottom-sheet-root", ...PANELS],
    dense: DENSE,
    sizeExempt: SIZE_EXEMPT,
  });

  const trigger = page.locator(".sys-track-main").first();
  await trigger.focus();
  await trigger.press("Enter");
  const surface = sheet ? SHEET : "aside.inspector";
  await expect(page.locator(surface)).toBeVisible();
  await settle(page);
  found["track surface"] = await reachFailures(page, {
    scope: surface,
    dense: DENSE,
    sizeExempt: SIZE_EXEMPT,
  });
  if (sheet) {
    await page.locator(SHEET).getByRole("button", { name: "Close" }).click();
    await expect(page.locator(SHEET)).toHaveCount(0);
  }

  found["clip surface"] = await clipSurface(page, sheet);

  if (sheet) {
    await armRange(page);
    await settle(page);
    found["armed range"] = await reachFailures(page, {
      scope: ".range-actions",
      dense: DENSE,
      sizeExempt: SIZE_EXEMPT,
    });
    await page.getByRole("button", { name: "Cancel range selection" }).click();
  }

  if (phone) {
    await stagePhone.showListen(page);
    await expect(page.getByRole("main", { name: "Review" })).toBeVisible();
    found.review = await reachFailures(page, {
      skip: [".bottom-sheet-root"],
      dense: DENSE,
      sizeExempt: SIZE_EXEMPT,
    });
  }

  await stagePhone.showText(page);
  await page
    .getByRole("button", { name: "Find in transcript" })
    .first()
    .click();
  await expect(
    page.getByRole("search", { name: "Find in transcript" }),
  ).toBeVisible();
  found["transcript panel"] = await reachFailures(page, {
    scope: PANELS.join(","),
    skip: [".bottom-sheet-root"],
    dense: DENSE,
    sizeExempt: SIZE_EXEMPT,
  });

  await openPanel(page, "pipeline");
  await expect(page.locator(".sys-prepare")).toBeVisible();
  found["prepare stage"] = await reachFailures(page, {
    scope: STAGE_BODY,
    skip: [".bottom-sheet-root"],
    dense: DENSE,
    sizeExempt: SIZE_EXEMPT,
  });

  // Phones comment from the Review stage, swept above. The Review comment
  // field opens with C and holds the name line.
  if (!phone) {
    await openPanel(page, "comments");
    await page.keyboard.press("c");
    const body = page
      .locator(".rv-compose")
      .getByRole("textbox", { name: "Comment", exact: true });
    await body.fill("Check this join");
    await expect(
      page.getByRole("textbox", { name: "Your name" }),
    ).toBeVisible();
    await settle(page);
    found["review comment field"] = await reachFailures(page, {
      scope: STAGE_BODY,
      skip: [".bottom-sheet-root"],
      dense: DENSE,
      sizeExempt: SIZE_EXEMPT,
    });
  }

  const report = Object.entries(found)
    .filter(([, failures]) => failures.length > 0)
    .map(([state, failures]) => `${state}\n${describeReach(failures)}`)
    .join("\n");
  return report ? `${cell.name}\n${report}` : "";
}

/**
 * A copy of the fixture whose first track carries a volume envelope and an effect
 * chain, so the track surface shows the Bypass toggles and its first point opens in the Inspector.
 */
function seededProject(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = JSON.parse(fs.readFileSync(fixture.projectPath, "utf8"));
  const trackId = project.timeline.tracks[0].id;
  project.mix.automation_envelopes = [
    {
      track_id: trackId,
      parameter: "volume",
      points: [
        { id: "sweep-first", time: 2, value: 0.6 },
        { id: "sweep-second", time: 10, value: 1.4 },
      ],
    },
  ];
  project.mix.processing_chains = [
    {
      track_id: trackId,
      effects: [
        { effect: "highpass", params: { frequency: 80 }, bypass: false },
        { effect: "afftdn", params: {}, bypass: true },
      ],
    },
  ];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}

async function sweepSeededTrack(
  page: Page,
  projectPath: string,
  cells: readonly Cell[],
): Promise<string> {
  const reports: string[] = [];
  await rememberInspectorDetent(page, "half");
  for (const { cell, theme, reducedMotion } of withAppearance(cells)) {
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    await arrive(page, cell, (p) => openHostShare(p, projectPath));
    await setTheme(page, theme);
    const trigger = page.locator(".sys-track-main").first();
    await trigger.focus();
    await trigger.press("Enter");
    const surface = cell.width <= 1194 ? SHEET : "aside.inspector";
    await expect(page.locator(surface)).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /^Bypass / }).first(),
    ).toBeVisible();
    await settle(page);
    const track = await reachFailures(page, {
      scope: surface,
      dense: DENSE,
      sizeExempt: SIZE_EXEMPT,
    });
    await showEnvelope(page);
    await openEnvelopePoint(page, 1);
    await settle(page);
    const envelope = await reachFailures(page, {
      scope: cell.width <= 1194 ? SHEET : ".sys-inspector",
      dense: DENSE,
      sizeExempt: SIZE_EXEMPT,
    });
    const failures = [...track, ...envelope];
    if (failures.length > 0) {
      reports.push(`${cell.name}\n${describeReach(failures)}`);
    }
  }
  return reports.join("\n\n");
}

async function sweep(page: Page, cells: readonly Cell[]): Promise<string> {
  return withShareableProject(async (projectPath) => {
    const reports: string[] = [];
    for (const { cell, theme, reducedMotion } of withAppearance(cells)) {
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
      reports.push(await sweepCell(page, cell, theme, projectPath));
    }
    return reports.filter(Boolean).join("\n\n");
  });
}

test("phone shells keep every control a finger can use at 360, 390 and 767 wide", async ({
  page,
}) => {
  expect(await sweep(page, PHONES), "controls a finger cannot use").toBe("");
});

test("loaded tablet Player stays reachable at 200% text", async ({ page }) => {
  await arrive(page, {
    name: "tablet 820, 200% text",
    width: 820,
    height: 1180,
    rootPx: 32,
  });
  await settle(page);
  const play = await page
    .getByRole("button", { name: "Play", exact: true })
    .boundingBox();
  expect(play).not.toBeNull();
  expect(
    describeReach(
      await reachFailures(page, { scope: ".stage-frame-player", dense: DENSE }),
    ),
  ).toBe("");
});

test("tablet and desktop shells keep every control a finger can use across 768 to 1195 wide", async ({
  page,
}) => {
  expect(await sweep(page, TABLETS), "controls a finger cannot use").toBe("");
});

test("a phone held sideways and an iPad keep every control a finger can use", async ({
  page,
}) => {
  expect(await sweep(page, LANDSCAPES), "controls a finger cannot use").toBe(
    "",
  );
});

test("a track with an envelope and an effect chain keeps every control a finger can use", async ({
  page,
}) => {
  const report = await withShareableProject(
    (projectPath) =>
      sweepSeededTrack(page, projectPath, [...REACHABILITY_CELLS]),
    undefined,
    seededProject,
  );
  expect(report, "controls a finger cannot use").toBe("");
});

test("pending-edit and transcript-word Inspector bodies keep every control reachable", async ({
  page,
}) => {
  const report = await withShareableProject(async (projectPath) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSuggestedPendingEdit(page, projectPath);
    const reports: string[] = [];
    const scanSelection = async (
      label: string,
      selectionScreen: "impact" | "text",
    ) => {
      // The surface switch folds into the Tools sheet in the narrow cells,
      // and the selection sheet covers the header there, so the surface is set
      // once, while the switch is still on the screen.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "";
      });
      if (selectionScreen === "impact") {
        await stagePhone.showTimeline(page);
      } else {
        await stagePhone.showText(page);
      }
      for (const cell of PHONES) {
        await page.setViewportSize({ width: cell.width, height: cell.height });
        await page.evaluate((px) => {
          document.documentElement.style.fontSize = `${px}px`;
        }, cell.rootPx);
        const surface = SHEET_BODY;
        const grip = page.getByRole("slider", { name: "Sheet height" });
        if (await grip.count()) {
          await grip.focus();
          await page.keyboard.press("End");
          await settle(page);
        }
        const body = page.locator(surface);
        await expect(body).toBeVisible();
        // A phone selection opens the drawer at its strip; the body shows from
        // half height, and the rest of it from full height.
        const expand = page.getByRole("button", { name: /^Expand to/ });
        while (
          !((await body.textContent()) ?? "").includes(label) &&
          (await expand.isVisible())
        ) {
          await expand.click();
          await settle(page);
        }
        await expect(body, `${cell.name} ${label} body`).toContainText(label);
        await settle(page);
        const failures = await reachFailures(page, {
          scope: surface,
          dense: DENSE,
          sizeExempt: SIZE_EXEMPT,
        });
        if (failures.length > 0) {
          reports.push(`${cell.name}\n${describeReach(failures)}`);
        }
      }
    };

    await scanSelection("Ask", "impact");

    await page.setViewportSize({ width: 390, height: 844 });
    await stagePhone.showText(page);
    const word = page.locator(".sys-script-body .sys-script-word").first();
    await expect(word).toBeVisible();
    await word.click();
    await inspectSelection(page);
    await scanSelection("Suppress", "text");
    return reports.join("\n\n");
  });
  expect(report, "controls a finger cannot use").toBe("");
});
