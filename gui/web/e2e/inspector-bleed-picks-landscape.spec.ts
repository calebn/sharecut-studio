import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { rememberInspectorDetent } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { inspectSelection } from "./stageNav";

// The Inspector card for an automatic reduction must not cover a band's pick:
// the picks exist only while the card is open, so the card has to make room.
const CLIENT_ID = "e2e-inspector-bleed-picks-landscape";
const BAND = { fade_out_ms: 5, fade_in_ms: 5 };
const JOINS_S = [8, 14, 15.5, 20, 26, 32];

test.use({
  hasTouch: true,
  isMobile: false,
  viewport: { width: 844, height: 390 },
});

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject(
    "sharecut-e2e-inspector-bleed-picks-",
  );
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
});

test.afterEach(async ({ page }) => {
  await page.close();
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

type Box = { x: number; y: number; width: number; height: number };

const picks = (page: Page) =>
  page.locator('[data-hit-kind="bleed-attenuation"]');
const card = (page: Page) => page.locator(".sys-inspector--card");
const inspector = (page: Page) =>
  page.getByRole("dialog", { name: "Inspector" });

function readProject() {
  return JSON.parse(fs.readFileSync(projectPath, "utf8"));
}

function writeProject(project: unknown) {
  fs.writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
}

/** The reference track's clip is split at `joinS`; the right half carries the bands. */
function splitAtJoin(joinS: number) {
  const project = readProject();
  const left = project.timeline.clips[0];
  left.source_end = joinS;
  left.off_speaker_mute_regions = [{ start_s: 4, end_s: joinS, ...BAND }];
  project.timeline.clips.splice(1, 0, {
    ...left,
    id: "bleed-right",
    source_start: joinS,
    source_end: 60,
    timeline_start: joinS,
    fade_in_ms: 500,
    fade_out_ms: 500,
    off_speaker_mute_regions: [
      { start_s: joinS, end_s: joinS + 6, ...BAND },
      { start_s: 54, end_s: 60, ...BAND },
    ],
  });
  writeProject(project);
}

/** The guest track is the lower lane: its whole clip carries two bands. */
function bandsOnLowerLane() {
  const project = readProject();
  const guest = project.timeline.clips.find(
    (clip: { track_id: string }) => clip.track_id === "guest",
  );
  guest.off_speaker_mute_regions = [
    { start_s: 10, end_s: 16, ...BAND },
    { start_s: 54, end_s: 60, ...BAND },
  ];
  writeProject(project);
  return guest.id as string;
}

async function openCard(page: Page, clip: string, withComment: number | null) {
  await switchE2eProject(projectPath);
  await rememberInspectorDetent(page, "half");
  if (withComment !== null)
    await postDocumentCommand(
      page,
      CLIENT_ID,
      "AddComment",
      { body: "Ada at the join", author: "Ada", timeline_start: withComment },
      projectPath,
    );
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await page.locator(`[data-clip-id="${clip}"]`).first().click();
  await inspectSelection(page);
  await page
    .getByRole("button", { name: "Inspect automatic audio reduction" })
    .click();
  await expect(picks(page)).toHaveCount(2);
  await expect(inspector(page)).toBeVisible();
  // The card places itself when the bands arrive; let it settle.
  await page.waitForTimeout(400);
}

async function boxes(page: Page) {
  return page.evaluate(() => {
    const read = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };
    return {
      card: read(document.querySelector(".sys-inspector--card")),
      bar: read(document.querySelector(".sys-actions--floating")),
    };
  });
}

async function everyPickIsHit(page: Page): Promise<boolean[]> {
  return picks(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return (
        document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        ) === el
      );
    }),
  );
}

const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0;

async function expectCardClearOfPicks(page: Page) {
  // Hit-testable at the centre, and the whole pick clear of the card's box.
  await expect.poll(() => everyPickIsHit(page)).toEqual([true, true]);
  const pickBoxes = await picks(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  const { card: cardBox, bar } = await boxes(page);
  if (cardBox) {
    for (const pick of pickBoxes) expect(overlaps(cardBox, pick)).toBe(false);
    // Inside the frame the card is placed in.
    const frame = await card(page).evaluate((el: HTMLElement) => {
      const r = (
        el.offsetParent ?? document.documentElement
      ).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    expect(cardBox.x).toBeGreaterThanOrEqual(frame.x - 0.5);
    expect(cardBox.y).toBeGreaterThanOrEqual(frame.y - 0.5);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(
      frame.x + frame.width + 0.5,
    );
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(
      frame.y + frame.height + 0.5,
    );
    // The Action bar is not covered by the card.
    if (bar) expect(overlaps(cardBox, bar)).toBe(false);
  }
  if (bar) {
    const top = await page.evaluate(
      (at) => {
        const el = document.elementFromPoint(at.x, at.y);
        return !!el?.closest(".sys-actions--floating");
      },
      { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 },
    );
    expect(top).toBe(true);
  }
}

async function expectCardCloses(page: Page) {
  await inspector(page)
    .getByRole("button", { name: /^(Close|Done)$/ })
    .first()
    .tap();
  await expect(inspector(page)).toHaveCount(0);
}

for (const joinS of JOINS_S) {
  test(`the card for a join at ${joinS} s leaves both picks tappable, stays in the frame and closes`, async ({
    page,
  }) => {
    splitAtJoin(joinS);
    await openCard(page, "bleed-right", joinS);
    await expectCardClearOfPicks(page);
    await expectCardCloses(page);
  });
}

test("the card for bands on the lower lane leaves both picks tappable, stays in the frame and closes", async ({
  page,
}) => {
  const clip = bandsOnLowerLane();
  await openCard(page, clip, null);
  await expectCardClearOfPicks(page);
  await expectCardCloses(page);
});
