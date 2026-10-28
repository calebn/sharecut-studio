import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { armRange, openPanel } from "./stageNav";

function repeatedProject(prefix: string) {
  const copy = createRelocatedE2eProject(prefix);
  const data = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
  const clip = {
    track_id: "reference",
    source_start: 0,
    source_end: 5,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
  };
  data.timeline.clips = [
    { ...clip, id: "first-copy", timeline_start: 0 },
    { ...clip, id: "second-copy", timeline_start: 10 },
    {
      ...clip,
      id: "peer",
      track_id: "guest",
      source_end: 20,
      timeline_start: 0,
    },
  ];
  data.timeline.duration_sec = 20;
  data.editorial.edit_decisions = [];
  data.editorial.edit_log = [];
  fs.writeFileSync(copy.projectPath, `${JSON.stringify(data, null, 2)}\n`);
  return copy;
}

async function selectRange(page: Page) {
  await armRange(page);
  const range = page.getByRole("region", { name: "Range fields" });
  await range.getByRole("spinbutton", { name: "In", exact: true }).fill("11");
  await range.getByRole("spinbutton", { name: "Out", exact: true }).fill("12");
  await range.getByRole("checkbox", { name: "reference", exact: true }).check();
  await range
    .getByRole("button", { name: "Select range", exact: true })
    .click();
  await expect(range).toContainText("11.00–12.00 s");
  return range;
}

function geometry(projectPath: string) {
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  return project.timeline.clips.map(
    (clip: {
      id: string;
      track_id: string;
      source_start: number;
      source_end: number;
      timeline_start: number;
      mute_regions?: {
        start_s: number;
        end_s: number;
        fade_in_ms: number;
        fade_out_ms: number;
        fill: unknown;
      }[];
    }) => ({
      id: clip.id,
      track_id: clip.track_id,
      source_start: clip.source_start,
      source_end: clip.source_end,
      timeline_start: clip.timeline_start,
      mute_regions: clip.mute_regions ?? [],
    }),
  );
}

async function undo(page: Page) {
  await page.locator(".timeline-scroll").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
}

async function slowHostDocument(page: Page, delayMs: number) {
  await page.route("**/api/document/state*", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ response });
  });
  await page.routeWebSocket(/\/api\/host\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => setTimeout(() => ws.send(message), delayMs));
    ws.onMessage((message) => server.send(message));
  });
}

async function rangeAxe(page: Page) {
  const result = await new AxeBuilder({ page })
    .include(".range-actions")
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual(
    [],
  );
}

test("idle desktop reaches an edit in removed audio through the Review queue", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openHostShare(page, projectPath);
      await expect(page.locator(".edit-workspace")).not.toHaveClass(
        /edit-workspace--inspector/,
      );
      // The old status chip is gone: the Review queue lists the edit, and
      // Open in Edit opens the Inspector on the Edit stage.
      await openPanel(page, "queue");
      await page.locator(".sys-queue-main").first().click();
      await page.getByRole("button", { name: "Open in Edit" }).click();
      await expect(page.locator(".edit-workspace")).toHaveClass(
        /edit-workspace--inspector/,
      );
      await expect(
        page.getByRole("button", { name: "Reject", exact: true }),
      ).toBeVisible();
    },
    undefined,
    (prefix) => {
      const copy = repeatedProject(prefix);
      const data = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
      data.editorial.edit_decisions = [
        {
          id: "orphan",
          proposal_origin: "programmatic",
          boundary_intent: "programmatic",
          track_id: "reference",
          type: "remove",
          start: 30,
          end: 31,
          applied: false,
          review_required: true,
          reason: "Removed source passage",
        },
      ];
      fs.writeFileSync(copy.projectPath, `${JSON.stringify(data, null, 2)}\n`);
      return copy;
    },
  );
});

test("editor guest cuts a range and one host Undo restores every occurrence", async ({
  browser,
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      const before = geometry(projectPath);
      const token = await createReviewShare(page, projectPath, "editor");
      const guestContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      try {
        const guest = await guestContext.newPage();
        await openGuestShare(guest, token);
        const range = await selectRange(guest);
        await expect(
          range.getByRole("button", { name: "Suggest cut", exact: true }),
        ).toHaveCount(0);
        await rangeAxe(guest);
        await range.getByRole("button", { name: "Cut", exact: true }).click();
        await expect
          .poll(() =>
            geometry(projectPath)
              .filter((c: { track_id: string }) => c.track_id === "reference")
              .map(
                (c: {
                  source_start: number;
                  source_end: number;
                  timeline_start: number;
                }) => [c.source_start, c.source_end, c.timeline_start],
              ),
          )
          .toEqual([
            [0, 5, 0],
            [0, 1, 10],
            [2, 5, 12],
          ]);
        expect(
          JSON.parse(fs.readFileSync(projectPath, "utf8")).editorial
            .edit_decisions,
        ).toHaveLength(0);
        await slowHostDocument(page, 1500);
        await page.reload();
        await expect(page.locator(".clip-block")).toHaveCount(4);
        await undo(page);
        await expect.poll(() => geometry(projectPath)).toEqual(before);
      } finally {
        await guestContext.close();
      }
    },
    undefined,
    repeatedProject,
  );
});

test("host cuts and mutes the repeated copy and arms a phone clip-body range", async ({
  page,
  browser,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openHostShare(page, projectPath);
      const before = geometry(projectPath);
      await expect(page.locator(".edit-workspace")).not.toHaveClass(
        /edit-workspace--inspector/,
      );
      let range = await selectRange(page);
      await expect(page.locator(".range-overlay")).toHaveCount(1);
      await rangeAxe(page);
      if (process.env.RANGE_SCREENSHOTS)
        await page.screenshot({
          path: path.join(process.env.RANGE_SCREENSHOTS, "desktop-range.png"),
          fullPage: true,
        });
      await range.getByRole("button", { name: "Cut", exact: true }).click();
      await expect.poll(() => geometry(projectPath).length).toBe(4);
      expect(
        geometry(projectPath).find(
          (c: { id: string }) => c.id === "first-copy",
        ),
      ).toEqual(before[0]);
      await undo(page);
      await expect.poll(() => geometry(projectPath)).toEqual(before);
      range = await selectRange(page);
      await range.getByRole("button", { name: "Mute", exact: true }).click();
      await expect
        .poll(
          () =>
            geometry(projectPath).find(
              (c: { id: string }) => c.id === "second-copy",
            )?.mute_regions,
        )
        .toEqual([
          {
            start_s: 1,
            end_s: 2,
            fade_in_ms: 5,
            fade_out_ms: 5,
            fill: null,
            gain_db: null,
          },
        ]);
      expect(
        geometry(projectPath).find(
          (c: { id: string }) => c.id === "first-copy",
        ),
      ).toEqual(before[0]);
      await undo(page);
      await expect.poll(() => geometry(projectPath)).toEqual(before);
      const phoneContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const phone = await phoneContext.newPage();
        await openHostShare(phone, projectPath);
        await openPhoneTimeline(phone);
        await phone
          .getByRole("button", { name: "Select range", exact: true })
          .tap();
        await expect(
          phone.getByRole("button", {
            name: "Cancel range selection",
            exact: true,
          }),
        ).toBeVisible();
        await expect(phone.locator(".range-actions--sheet")).toHaveCSS(
          "overflow-y",
          "visible",
        );
        const body = phone.locator('[data-clip-id="first-copy"] .clip-hit');
        const bounds = await body.boundingBox();
        expect(bounds).toBeTruthy();
        for (const [event, fraction] of [
          ["pointerdown", 0.2],
          ["pointermove", 0.8],
          ["pointerup", 0.8],
        ] as const) {
          await body.dispatchEvent(event, {
            pointerId: 31,
            pointerType: "touch",
            clientX: bounds!.x + bounds!.width * fraction,
            clientY: bounds!.y + bounds!.height * 0.5,
            bubbles: true,
          });
        }
        await expect(
          phone
            .getByRole("region", { name: "Range fields" })
            .getByRole("button", { name: "Cut", exact: true }),
        ).toBeVisible();
        await rangeAxe(phone);
        expect(geometry(projectPath)).toEqual(before);
        if (process.env.RANGE_SCREENSHOTS)
          await phone.screenshot({
            path: path.join(process.env.RANGE_SCREENSHOTS, "phone-range.png"),
            fullPage: true,
          });
      } finally {
        await phoneContext.close();
      }
    },
    undefined,
    repeatedProject,
  );
});

function gapProject(prefix: string) {
  const copy = createRelocatedE2eProject(prefix);
  const data = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
  const clip = {
    track_id: "reference",
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
  };
  data.timeline.clips = [
    {
      ...clip,
      id: "before-gap",
      source_start: 0,
      source_end: 5,
      timeline_start: 0,
    },
    {
      ...clip,
      id: "after-gap",
      source_start: 5,
      source_end: 10,
      timeline_start: 8,
    },
    {
      ...clip,
      id: "peer",
      track_id: "guest",
      source_start: 0,
      source_end: 13,
      timeline_start: 0,
    },
  ];
  data.timeline.duration_sec = 13;
  data.editorial.edit_decisions = [];
  data.editorial.edit_log = [];
  fs.writeFileSync(copy.projectPath, `${JSON.stringify(data, null, 2)}\n`);
  return copy;
}

test("host gets a plain reason when a range has no room tone to fill with", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openHostShare(page, projectPath);
      const before = geometry(projectPath);
      await armRange(page);
      const range = page.getByRole("region", { name: "Range fields" });
      await range
        .getByRole("spinbutton", { name: "In", exact: true })
        .fill("5.5");
      await range
        .getByRole("spinbutton", { name: "Out", exact: true })
        .fill("7.5");
      await range
        .getByRole("checkbox", { name: "reference", exact: true })
        .check();
      await range
        .getByRole("button", { name: "Select range", exact: true })
        .click();
      await expect(range).toContainText("5.50–7.50 s");
      await rangeAxe(page);
      await range
        .getByRole("button", { name: "Fill room tone", exact: true })
        .click();
      await expect(
        page
          .getByText("No usable room tone on this track to fill with")
          .first(),
      ).toBeVisible();
      expect(geometry(projectPath)).toEqual(before);
    },
    undefined,
    gapProject,
  );
});

test.describe("a phone with a touch screen", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("a range on an unbroken clip explains why Fill room tone is off", async ({
    page,
  }) => {
    await withShareableProject(
      async (projectPath) => {
        await openHostShare(page, projectPath);
        await openPhoneTimeline(page);
        await page
          .getByRole("button", { name: "Select range", exact: true })
          .tap();
        const range = page.getByRole("region", { name: "Range fields" });
        await range
          .getByRole("spinbutton", { name: "In", exact: true })
          .fill("1");
        await range
          .getByRole("spinbutton", { name: "Out", exact: true })
          .fill("2");
        await range
          .getByRole("checkbox", { name: "reference", exact: true })
          .check();
        await range
          .getByRole("button", { name: "Select range", exact: true })
          .click();
        await expect(
          range.getByRole("button", { name: "Fill room tone", exact: true }),
        ).toBeDisabled();
        await expect(range).toContainText("No gap between clips in this range");
        await rangeAxe(page);
      },
      undefined,
      gapProject,
    );
  });
});
