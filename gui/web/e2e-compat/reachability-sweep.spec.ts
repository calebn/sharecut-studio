import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { describeReach, type Reach, reachFailures } from "../e2e/reachability";
import { setTheme, type Theme, withAppearance } from "../e2e/theme";

test.use({ hasTouch: true, actionTimeout: 15_000 });
test.describe.configure({ timeout: 600_000 });

/**
 * One sweep over the touch surfaces at the shell boundaries and two text
 * scales: every interactive control is at least 44 CSS px, sits inside the
 * visual viewport once scrolled to, and is not under another element or a
 * scrim. Sizes are layout boxes, so a transition cannot shrink one (#1418).
 *
 * The selection surfaces (sheet, armed range), the shell chrome, Listen and the
 * Transcript and Pipeline panels are swept whole, at every cell. A control inside a
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
  { name: "tablet max 1180", width: 1180, height: 800, rootPx: 16 },
  {
    name: "desktop min 1181",
    width: 1181,
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
    name: "iPad landscape short Safari",
    width: 1180,
    height: 620,
    rootPx: 16,
    rows: true,
  },
];

/**
 * Canvas targets reach 44 px through the dense-target pattern
 * (docs/communication-philosophy.md): their hit area grows invisibly and the
 * selected target is editable from 44 px inspector controls. The track grip
 * has an equivalent control, Move track up and down in the track sheet. The
 * status-bar chips keep the bar one line tall by decision (responsive.css);
 * the tab strip carries the same actions.
 */
const DENSE = [
  ".fade-corner",
  ".trim-handle",
  ".clip-hit",
  ".time-ruler",
  ".track-headers-well",
  ".track-header-open",
  ".track-reorder-handle",
  ".status-bar .status-chip",
  // Transcript text: inline words in running text, where a taller hit area would take
  // the neighbouring line's taps (docs/communication-philosophy.md, #1602). The speaker
  // button holds the floor.
  ".utterance-word",
  ".utterance-seek:not(.utterance-speaker)",
];

/** The panels' interiors, which only the rows below sweep. */
const PANELS = [".tab-content", ".mobile-text-mode", ".mobile-more-mode"];

async function arrive(page: Page, cell: Cell) {
  await page.setViewportSize({ width: cell.width, height: cell.height });
  await openHostProject(page);
  if (cell.width <= 767) await openPhoneTimeline(page);
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, cell.rootPx);
  await expect
    .poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches))
    .toBe(true);
}

async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished)),
  );
}

/** Rows the tool rail's visible controls sit on, by vertical centre. */
function railRows(page: Page) {
  return page.evaluate(
    () =>
      new Set(
        [
          ...document.querySelectorAll<HTMLElement>(
            ".editing-tool-rail-tools .ui-control",
          ),
        ]
          .filter((el) => el.offsetParent !== null)
          .map((el) => {
            const box = el.getBoundingClientRect();
            return Math.round((box.top + box.height / 2) / 8);
          }),
      ).size,
  );
}

async function sweepCell(
  page: Page,
  cell: Cell,
  theme: Theme,
): Promise<string> {
  const phone = cell.width <= 767;
  const sheet = cell.width <= 1180;
  const found: Record<string, Reach[]> = {};
  await arrive(page, cell);
  await setTheme(page, theme);

  found["shell chrome"] = await reachFailures(page, {
    skip: [".bottom-sheet-root", ...PANELS],
    dense: DENSE,
  });
  const rows = sheet ? await railRows(page) : 1;
  if (rows !== 1) {
    found["editing rail"] = [
      {
        failure: "overflows-container",
        control: `rail wraps onto ${rows} rows (#1347)`,
        layout: { width: 0, height: 0 },
        rect: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    ];
  }

  const trigger = page.locator(".track-header-open").first();
  await trigger.focus();
  await trigger.press("Enter");
  const surface = sheet ? ".bottom-sheet" : "aside.inspector";
  await expect(page.locator(surface)).toBeVisible();
  await settle(page);
  found["track surface"] = await reachFailures(page, {
    scope: surface,
    dense: DENSE,
  });
  if (sheet) {
    await page
      .locator(".bottom-sheet")
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.locator(".bottom-sheet")).toHaveCount(0);
  }

  if (sheet) {
    await page
      .getByRole("button", { name: "Select range", exact: true })
      .first()
      .click();
    await expect(page.locator(".range-actions")).toBeVisible();
    await settle(page);
    found["armed range"] = await reachFailures(page, {
      scope: ".range-actions",
      dense: DENSE,
    });
    await page.getByRole("button", { name: "Cancel range selection" }).click();
  }

  if (phone) {
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Listen" })
      .click();
    await expect(page.locator(".mobile-listen")).toBeVisible();
    found.listen = await reachFailures(page, {
      skip: [".bottom-sheet-root"],
      dense: DENSE,
    });
  }

  {
    if (phone) {
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Text" })
        .click();
    } else {
      await page
        .getByRole("button", { name: "Transcript", exact: true })
        .first()
        .click();
    }
    await page
      .getByRole("button", { name: "Find and replace" })
      .first()
      .click();
    await expect(page.locator(".transcript-find-replace")).toBeVisible();
    found["find and replace row"] = await reachFailures(page, {
      scope: ".transcript-find-replace",
      dense: DENSE,
    });
    found["transcript panel"] = await reachFailures(page, {
      scope: PANELS.join(","),
      skip: [".bottom-sheet-root"],
      dense: DENSE,
    });

    if (phone) {
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More" })
        .click();
      await page
        .locator(".mobile-more-item", { hasText: "Pipeline" })
        .first()
        .click();
    } else {
      await page
        .getByRole("button", { name: "Pipeline", exact: true })
        .first()
        .click();
    }
    await expect(
      page.locator(".pipeline-vocabulary-field").first(),
    ).toBeVisible();
    found["pipeline add term row"] = await reachFailures(page, {
      scope: ".pipeline-vocabulary-field form",
      dense: DENSE,
    });
    found["pipeline panel"] = await reachFailures(page, {
      scope: PANELS.join(","),
      skip: [".bottom-sheet-root"],
      dense: DENSE,
    });
  }

  const report = Object.entries(found)
    .filter(([, failures]) => failures.length > 0)
    .map(([state, failures]) => `${state}\n${describeReach(failures)}`)
    .join("\n");
  return report ? `${cell.name}\n${report}` : "";
}

async function sweep(page: Page, cells: readonly Cell[]): Promise<string> {
  const reports: string[] = [];
  for (const { cell, theme, reducedMotion } of withAppearance(cells)) {
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    reports.push(await sweepCell(page, cell, theme));
  }
  return reports.filter(Boolean).join("\n\n");
}

test("phone shells keep every control a finger can use at 360, 390 and 767 wide", async ({
  page,
}) => {
  expect(await sweep(page, PHONES), "controls a finger cannot use").toBe("");
});

test("tablet and desktop shells keep every control a finger can use across 768 to 1181 wide", async ({
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
