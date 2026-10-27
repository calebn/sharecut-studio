import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import {
  goToStage,
  openProjectDialog,
  openProjectMenu,
  openProject as openStageProject,
  openViewSheet,
  phone,
  type Stage,
  selectTool,
  setAudition,
  stageTab,
} from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

const STAGES: readonly Stage[] = [
  "record",
  "prepare",
  "edit",
  "review",
  "deliver",
];

const player = (page: Page) => page.getByRole("group", { name: "Player" });

async function openProject(page: Page): Promise<void> {
  await openStageProject(page, e2eProjectPath);
}

/** Playback needs a rendered mix; the fixture ships none. */
async function renderPreview(page: Page): Promise<void> {
  const started = await page.request.post("/api/pipeline/render-preview", {
    data: { path: e2eProjectPath },
  });
  expect(started.ok(), await started.text()).toBeTruthy();
  const jobId = ((await started.json()) as { job: { id: string } }).job.id;
  await expect
    .poll(
      async () => {
        const status = await page.request.get("/api/pipeline/status");
        const body = (await status.json()) as {
          jobs?: { id: string; status: string }[];
          job?: { id: string; status: string };
        };
        const jobs = body.jobs ?? (body.job ? [body.job] : []);
        return jobs.find((job) => job.id === jobId)?.status;
      },
      { timeout: 60_000 },
    )
    .toBe("ok");
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

test.describe("Stage shell on desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("opens a project into Edit and is axe-clean", async ({ page }) => {
    await openProject(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect(
      page.getByRole("tablist", { name: "Stages" }).getByRole("tab"),
    ).toHaveCount(5);
    await expect(
      page.getByRole("group", { name: "Editing tools" }),
    ).toBeVisible();
    await expect(player(page)).toBeVisible();
    await expectPageAxeClean(page);
  });

  test("switches stages from the Stage bar and the keys", async ({ page }) => {
    await openProject(page);
    for (const stage of STAGES) {
      await goToStage(page, stage);
      if (stage === "record") {
        await expect(player(page)).toBeHidden();
      } else {
        await expect(player(page)).toBeVisible();
      }
    }
    await page.keyboard.press("ControlOrMeta+4");
    await expect(page.getByRole("main", { name: "Review" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+3");
    await expect(page.getByRole("main", { name: "Edit" })).toBeVisible();
  });

  test("keeps the timeline zoom across a stage round trip", async ({
    page,
  }) => {
    await openProject(page);
    const sheet = await openViewSheet(page);
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Zoom in/ }).click();
    const ruler = page.getByRole("slider", { name: /ime/ }).first();
    const before = await ruler.getAttribute("aria-valuemax");
    await goToStage(page, "review");
    await goToStage(page, "edit");
    await expect(ruler).toHaveAttribute("aria-valuemax", before ?? "");
  });

  test("plays and pauses from the Player and picks what it plays", async ({
    page,
  }) => {
    await renderPreview(page);
    await openProject(page);
    const play = player(page).getByRole("button", { name: /Play|Pause/ });
    await play.click();
    await expect(play).toHaveAttribute("aria-label", /Pause/);
    await play.click();
    await expect(play).toHaveAttribute("aria-label", /Play/);
    await setAudition(page, "raw");
    await setAudition(page, "mix");
    await selectTool(page, "blade");
    await selectTool(page, "select");
  });

  test("adds a comment from the Player and sees it in Review", async ({
    page,
  }) => {
    await openProject(page);
    const reviewTab = page
      .getByRole("tablist", { name: "Stages" })
      .getByRole("tab", { name: /Review/ });
    const waiting = async () =>
      Number(
        /Review\s*(\d+)/.exec((await reviewTab.textContent()) ?? "")?.[1] ?? 0,
      );
    await player(page).getByRole("button", { name: "Comment" }).click();
    const review = page.getByRole("main", { name: "Review" });
    await expect(review).toBeVisible();
    await page.getByPlaceholder("Add a comment…").fill("Stage shell comment");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(review.getByText("Stage shell comment")).toBeVisible();
    // The posted comment waits for review, so the tab badge counts it.
    await expect.poll(waiting).toBeGreaterThan(0);
  });

  test("opens Export, Bounce and the Record room from where they live", async ({
    page,
  }) => {
    await openProject(page);
    await openProjectDialog(page, "export");
    await expect(
      page.getByRole("dialog", { name: "Export deliverables" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await openProjectDialog(page, "bounce");
    await expect(page.getByRole("dialog", { name: /Bounce/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await openProjectDialog(page, "record");
    await expect(
      page.getByRole("dialog", { name: "Record room" }),
    ).toBeVisible();
  });

  test("the Project menu goes Home and carries Appearance", async ({
    page,
  }) => {
    await openProject(page);
    const menu = await openProjectMenu(page);
    await expect(
      menu.getByRole("menuitemradio", { name: "Dark" }),
    ).toBeVisible();
    await menu.getByRole("menuitem", { name: "All projects" }).click();
    await expect(page).not.toHaveURL(/project=/);
  });
});

test.describe("Stage shell on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("keeps the tab bar on every stage, Record included", async ({
    page,
  }) => {
    await openProject(page);
    for (const stage of STAGES) {
      await stageTab(page, stage).click();
      await expect(page.getByRole("main", { name: /./ }).first()).toBeVisible();
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-frame-short",
        /.*/,
      );
      await expect(
        page
          .locator(".stage-frame-tabs")
          .getByRole("tab", { name: new RegExp(`^${stage}`, "i") }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(".stage-frame-tabs")).toBeVisible();
    }
  });

  test("shows the tab bar and switches Edit surfaces", async ({ page }) => {
    await openProject(page);
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await expect(
      page
        .locator(".stage-frame-tabs")
        .getByRole("tablist", { name: "Stages" }),
    ).toBeVisible();
    await phone.showText(page);
    await phone.showTimeline(page);
    for (const stage of STAGES) {
      await goToStage(page, stage);
    }
    await expectNoHorizontalScroll(page);
    await goToStage(page, "edit");
    await expectPageAxeClean(page);
  });
});

test.describe("Stage shell on a guest link", () => {
  test("a commenter link opens Review only", async ({ browser }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [{}, { viewport: { width: 1280, height: 800 } }],
        async ([host, guest]) => {
          await openHostShare(host, projectPath);
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);
          await expect(
            guest.getByRole("main", { name: "Review" }),
          ).toBeVisible();
          await expect(
            guest.getByRole("tablist", { name: "Stages" }),
          ).toHaveCount(0);
          await expect(
            guest.getByRole("button", { name: "Invite" }),
          ).toHaveCount(0);
          await expect(
            guest.getByRole("button", { name: "Hear options" }),
          ).toHaveCount(0);
          await expectPageAxeClean(guest);
        },
      );
    });
  });
});
