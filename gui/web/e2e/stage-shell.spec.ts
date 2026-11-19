import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { ProjectView } from "../src/types/project";
import { expectPageAxeClean } from "./axe";
import { registerE2eCleanupWorkspace } from "./cleanupManifest";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";
import { createEpisodeFromHome, openHome } from "./home";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import {
  silenceWav,
  switchE2eProject,
  withShareableProject,
} from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import {
  altClickSplit,
  closeViewPopover,
  deliverPage,
  goToStage,
  openProjectDialog,
  openProjectMenu,
  openProject as openStageProject,
  openViewPopover,
  phone,
  type Stage,
  setAudition,
  stageTab,
} from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

const CASE_PHASES = [
  "never_started",
  "entered",
  "host_ready",
  "share_ready",
  "editor_ready",
  "composer_ready",
  "comment_saved",
  "derived_checked",
  "undo_checked",
  "body_complete",
] as const;
type CompletedCasePhase = Exclude<
  (typeof CASE_PHASES)[number],
  "never_started"
>;

const diagnosticTest = test.extend<
  { caseProgress: (phase: CompletedCasePhase) => void },
  { privateDiagnostic: void }
>({
  caseProgress: [
    async ({ privateDiagnostic: _privateDiagnostic }, runFixture, testInfo) => {
      let index = 0;
      try {
        await runFixture((phase) => {
          const next = CASE_PHASES.indexOf(phase);
          if (index === 0 && next === 1) {
            index = 1;
            return;
          }
          if (testInfo.status !== "passed") return;
          index = index >= 0 && next === index + 1 ? next : -1;
        });
      } finally {
        try {
          testInfo.annotations.push({
            type: "sharecut.functional-last-completed.v1",
            description: CASE_PHASES[index] ?? "unknown",
          });
        } catch {
          // A missing diagnostic remains unknown; it cannot change the test result.
        }
      }
    },
    { auto: true },
  ],
  trace: "off",
  screenshot: "off",
  video: "off",
  privateDiagnostic: [
    async ({ browserName }, runFixture) => {
      if (!browserName)
        throw new Error("Diagnostic browser configuration missing");
      const previous = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
      try {
        await runFixture();
      } finally {
        if (previous === undefined)
          delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previous;
      }
    },
    { scope: "worker", auto: true },
  ],
});

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

  for (const actor of ["Script focus", "frame folding"] as const) {
    test(`dismisses View when ${actor} hides its eye`, async ({ page }) => {
      await openProject(page);
      const timeline = page.locator(".edit-timeline-main");
      const retained = await timeline.elementHandle();
      const popover = await openViewPopover(page);
      await popover
        .getByRole("button", { name: "Prosody", exact: true })
        .focus();
      const eye = page.getByRole("button", {
        name: "View options",
        exact: true,
      });
      if (actor === "Script focus") {
        await page.keyboard.press("Shift+T");
        await expect(page.locator(".edit-timeline-col")).toBeHidden();
        await expect(
          page.getByRole("button", { name: "Find in transcript", exact: true }),
        ).toBeFocused();
      } else {
        await page.setViewportSize({ width: 1280, height: 220 });
        await expect(page.locator("html")).toHaveAttribute(
          "data-frame-short",
          "",
        );
        await expect(
          page.getByRole("button", { name: "Tools", exact: true }),
        ).toBeFocused();
      }
      await expect(eye).toBeHidden();
      await expect(popover).toHaveCount(0);
      expect(await retained?.evaluate((el) => el.isConnected)).toBe(true);
      if (actor === "Script focus") await page.keyboard.press("Shift+T");
      else await page.setViewportSize({ width: 1280, height: 800 });
      await expect(eye).toBeVisible();
      await expect(eye).toHaveAttribute("aria-expanded", "false");
      await expect(
        page.getByRole("dialog", { name: "View options" }),
      ).toHaveCount(0);
      await eye.click();
      await expect(
        page.getByRole("dialog", { name: "View options" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(eye).toBeFocused();
    });
  }

  test("keeps the Tools corner independent when folding and Script focus overlap", async ({
    page,
  }) => {
    await openProject(page);
    const popover = await openViewPopover(page);
    await popover.getByRole("button", { name: "Prosody", exact: true }).focus();
    await page.keyboard.press("Shift+T");
    await expect(popover).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 220 });
    const tools = page.getByRole("button", { name: "Tools", exact: true });
    await expect(tools).toBeVisible();
    await tools.click();
    const sheet = page.getByRole("dialog", { name: "Tools", exact: true });
    await expect(sheet).toBeVisible();
    const eye = sheet.getByRole("button", {
      name: "View options",
      exact: true,
    });
    await eye.click();
    await expect(
      page.getByRole("dialog", { name: "View options" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "View options" }),
    ).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(eye).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(tools).toBeFocused();
  });

  test("hides the Player's Comment when a desktop frame folds", async ({
    page,
  }) => {
    await openProject(page);
    await expect(
      player(page).getByRole("button", { name: "Comment" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 220 });
    await expect(page.locator("html")).toHaveAttribute("data-frame-short", "");
    await expect(
      player(page).getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();
    await expect(
      player(page).getByRole("button", { name: "Comment" }),
    ).toBeHidden();
  });

  test("opens a project into Edit and is axe-clean", async ({ page }) => {
    await openProject(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect(
      page.getByRole("tablist", { name: "Stages" }).getByRole("tab"),
    ).toHaveCount(5);
    await expect(
      page.getByRole("group", { name: "Timeline view" }),
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

  test("saves a chapter added in Deliver to the project", async ({ page }) => {
    const chapterCount = async () => {
      const response = await page.request.get(
        `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
      );
      expect(response.ok()).toBe(true);
      return ((await response.json()) as ProjectView).chapters.length;
    };
    const before = await chapterCount();
    await openProject(page);
    await goToStage(page, "deliver");
    await page.getByRole("button", { name: "Add at playhead" }).click();
    await expect.poll(chapterCount).toBe(before + 1);
    await page.getByRole("button", { name: /^Remove Chapter/ }).click();
    await expect.poll(chapterCount).toBe(before);
  });

  test("keeps the timeline zoom across a stage round trip", async ({
    page,
  }) => {
    await openProject(page);
    const popover = await openViewPopover(page);
    await expect(popover).toBeVisible();
    await closeViewPopover(page, popover);
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
    const compose = page.locator(".rv-compose");
    await compose
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Stage shell comment");
    await compose.getByRole("button", { name: "Post", exact: true }).click();
    await expect(review.getByText("Stage shell comment").first()).toBeVisible();
    // The posted comment waits for review, so the tab badge counts it.
    await expect.poll(waiting).toBeGreaterThan(0);
  });

  test("opens the Record stage from where it lives, and Export is on Deliver while Bounce is not", async ({
    page,
  }) => {
    await openProject(page);
    await goToStage(page, "deliver");
    await expect(
      deliverPage(page).getByRole("button", { name: "Export", exact: true }),
    ).toBeVisible();
    await expect(
      deliverPage(page).getByRole("button", { name: "Bounce", exact: true }),
    ).toHaveCount(0);
    await openProjectDialog(page, "record");
    await expect(stageTab(page, "record")).toHaveAttribute(
      "aria-selected",
      "true",
    );
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

for (const width of [1024, 1440]) {
  test.describe(`Alt-click Split at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    // The cut stays in the project, so it runs on a copy: a cut left in the
    // shared fixture shows up as joins and short clips in every later spec.
    let projectPath: string;
    let workspaceDir: string;

    test.beforeEach(async () => {
      const fixture = createRelocatedE2eProject("sharecut-e2e-alt-split-");
      projectPath = fixture.projectPath;
      workspaceDir = fixture.workspaceDir;
      await switchE2eProject(projectPath);
    });

    test.afterEach(async () => {
      await switchE2eProject(e2eProjectPath);
      if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
    });

    const clipCounter = (page: Page) => async () => {
      const res = await page.request.get(
        `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
      );
      const body = (await res.json()) as {
        clips: { tracks: Record<string, unknown[]> };
      };
      return Object.values(body.clips.tracks).reduce(
        (sum, clips) => sum + clips.length,
        0,
      );
    };

    test("a plain click on a clip selects it and never splits", async ({
      page,
    }) => {
      await openStageProject(page, projectPath);
      const clipCount = clipCounter(page);
      const before = await clipCount();
      const clip = page.locator(".clip-hit").first();
      await clip.click();
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".split-guide")).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: /^Cut at/ })).toHaveCount(
        0,
      );
      expect(await clipCount()).toBe(before);
    });

    test("holding Alt over the lanes shows the split guide, and releasing Alt takes it away", async ({
      page,
    }) => {
      await openStageProject(page, projectPath);
      const clip = page.locator(".clip-hit").first();
      await clip.hover();
      await expect(page.locator(".split-guide")).toHaveCount(0);
      await page.keyboard.down("Alt");
      const guide = page.locator(".split-guide").first();
      await expect(guide).toBeVisible();
      const box = (await clip.boundingBox())!;
      const guideBox = (await guide.boundingBox())!;
      expect(guideBox.x).toBeGreaterThanOrEqual(box.x - 2);
      expect(guideBox.x).toBeLessThanOrEqual(box.x + box.width + 2);
      await page.keyboard.up("Alt");
      await expect(page.locator(".split-guide")).toHaveCount(0);
    });

    test("an Alt drag across the lanes never splits at the release point", async ({
      page,
    }) => {
      await openStageProject(page, projectPath);
      const clipCount = clipCounter(page);
      const before = await clipCount();
      const box = (await page.locator(".clip-hit").first().boundingBox())!;
      const y = box.y + box.height / 2;
      await page.keyboard.down("Alt");
      await page.mouse.move(box.x + 20, y);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, y, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up("Alt");
      await expect(page.getByRole("dialog", { name: /^Cut at/ })).toHaveCount(
        0,
      );
      expect(await clipCount()).toBe(before);
    });

    test("the split guide stays visible under forced colors", async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: "active" });
      await openStageProject(page, projectPath);
      await page.locator(".clip-hit").first().hover();
      await page.keyboard.down("Alt");
      const guide = page.locator(".split-guide").first();
      await expect(guide).toBeVisible();
      const paint = await guide.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          width: Number.parseFloat(style.borderLeftWidth),
          color: style.borderLeftColor,
        };
      });
      const canvas = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "Canvas";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      expect(paint.width).toBeGreaterThan(0);
      expect(paint.color).not.toBe(canvas);
      await page.keyboard.up("Alt");
    });

    test("takes a real Alt-click on a clip and adds a clip", async ({
      page,
    }) => {
      await openStageProject(page, projectPath);
      const clipCount = clipCounter(page);
      const before = await clipCount();
      const clip = page.locator(".clip-hit").first();
      await altClickSplit(page, clip);
      await expect.poll(clipCount).toBeGreaterThan(before);
      await expect(page.locator(".clip-hit").first()).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });
}

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

  test("a host's folded phone frame has no Comment in the Player bar", async ({
    page,
  }) => {
    await openProject(page);
    await page.setViewportSize({ width: 667, height: 375 });
    await expect(page.locator("html")).toHaveAttribute("data-frame-short", "");
    await expect(page.locator("html")).toHaveAttribute("data-shell", "phone");
    await expect(
      player(page).getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();
    await expect(
      player(page).getByRole("button", { name: "Comment" }),
    ).toBeHidden();
  });

  test("a host's phone sheet keeps the Expand button's link colour", async ({
    page,
  }) => {
    await openProject(page);
    await openProjectDialog(page, "share");
    const sheet = page.getByRole("dialog", { name: "Invite", exact: true });
    await expect(sheet).toBeVisible();
    const resize = sheet.locator(".bottom-sheet-resize-action").first();
    await expect(resize).toBeVisible();
    const colours = await resize.evaluate((button) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-accent-fg)";
      document.body.append(probe);
      const link = getComputedStyle(probe).color;
      probe.remove();
      return { button: getComputedStyle(button).color, link };
    });
    expect(colours.button).toBe(colours.link);
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

diagnosticTest(
  "an Editor's comment survives a normal reload-derived save and Undo/Redo restores only that comment",
  async ({ page, browser, caseProgress }) => {
    caseProgress("entered");
    let workspaceDir = "";
    let projectPath = "";
    let guestContext: BrowserContext | undefined;
    const digest = (value: string | Buffer) =>
      createHash("sha256").update(value).digest("hex");
    type Saved = {
      history: {
        cursor: number;
        entries: { id: string; author?: string | null }[];
      };
      review: { comments: { id: string; body: string }[] };
      render: {
        proxy_manifests?: {
          revision: string;
          project_basis: { history_head_id: string };
          tracks: Record<string, unknown>;
        }[];
      };
    };
    const read = () => {
      const bytes = fs.readFileSync(projectPath);
      const project = JSON.parse(bytes.toString("utf8")) as Saved;
      const stat = fs.statSync(projectPath, { bigint: true });
      return {
        project,
        bytes: digest(bytes),
        history: digest(JSON.stringify(project.history)),
        index: digest(
          fs.readFileSync(path.join(workspaceDir, "history", "index.json")),
        ),
        certificate: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
      };
    };
    const classificationOf = (
      error: unknown,
    ): "assertion" | "timeout" | "error" | "non-error" | "unclassified" => {
      try {
        if (
          error !== null &&
          typeof error === "object" &&
          "matcherResult" in error
        )
          return "assertion";
        if (error instanceof Error)
          return error.name === "TimeoutError" ? "timeout" : "error";
        return "non-error";
      } catch {
        return "unclassified";
      }
    };
    let phase = "fixture-setup";
    let bodyFailed = false;
    let bodyClassification = "unclassified";
    const cleanupErrors: Error[] = [];
    try {
      workspaceDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "sharecut-e2e-derived-"),
      );
      if (!registerE2eCleanupWorkspace(workspaceDir))
        throw new Error("Owned cleanup registration required");
      projectPath = path.join(workspaceDir, "episode.sharecut");
      assertDisposableE2eProject(projectPath);
      guestContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      phase = "open-home";
      await openHome(page);
      phase = "create-episode";
      await createEpisodeFromHome(page, {
        name: "Derived save QA",
        workspaceDir,
      });
      phase = "wait-record-invite";
      await expect(page.getByRole("dialog", { name: "Invite" })).toBeVisible();
      phase = "dismiss-record-invite";
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Invite" })).toBeHidden();
      caseProgress("host_ready");
      phase = "open-prepare";
      await goToStage(page, "prepare");
      phase = "choose-audio";
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: /^Import audio/ })
        .first()
        .click();
      phase = "import-audio";
      await (await chooser).setFiles({
        name: "synthetic.wav",
        mimeType: "audio/wav",
        buffer: silenceWav(2),
      });
      phase = "open-host-edit";
      await goToStage(page, "edit");
      phase = "wait-imported-clip";
      await expect(page.locator(".clip-block").first()).toBeVisible();

      phase = "open-review-invite";
      await openProjectDialog(page, "share");
      phase = "choose-editor-role";
      await page
        .getByRole("button", { name: "Editor: can edit", exact: true })
        .click();
      phase = "copy-editor-link";
      await page
        .getByRole("button", { name: "Copy new Editor link", exact: true })
        .click();
      phase = "refresh-mix";
      await page
        .getByRole("button", { name: "Refresh mix", exact: true })
        .click();
      phase = "wait-ui-mix-recovery";
      // The completed UI invitation witnesses actual mix recovery. Its public
      // relay address is not the isolated GUI's navigation address.
      const made = page.locator(".sys-link").filter({
        has: page.getByRole("img", { name: "Editor: can edit", exact: true }),
      });
      await expect(made).toBeVisible();
      await page.keyboard.press("Escape");

      caseProgress("share_ready");
      phase = "create-local-editor-role";
      // Use the established host-authorized fixture on this same application.
      // The UI-created invitation stays unused; neither address is forwarded.
      const token = await createReviewShare(page, projectPath, "editor");
      phase = "open-local-editor-role";
      const guest = await guestContext.newPage();
      await openGuestShare(guest, token);
      await guest.getByRole("tab", { name: "Edit", exact: true }).click();
      await expect
        .poll(
          () =>
            Object.keys(
              read().project.render.proxy_manifests?.[0]?.tracks ?? {},
            ).length,
        )
        .toBeGreaterThan(0);
      caseProgress("editor_ready");
      phase = "observe-initial-manifest";
      const originalComments = digest(
        JSON.stringify(read().project.review.comments),
      );
      const commentBody = "Derived save authorship QA";
      const comment = guest
        .locator('.sys-queue-row[data-kind="comment"]')
        .filter({ hasText: commentBody });
      phase = "post-editor-comment";
      await guest.getByRole("tab", { name: "Review", exact: true }).click();
      const composer = guest.locator(".rv-compose");
      await composer
        .getByRole("textbox", { name: "Comment", exact: true })
        .fill(commentBody);
      await composer
        .getByRole("textbox", { name: "Your name", exact: true })
        .fill("Synthetic editor");
      caseProgress("composer_ready");
      await composer.getByRole("button", { name: "Post", exact: true }).click();
      await expect(comment).toHaveCount(1);
      await expect
        .poll(
          () =>
            read().project.review.comments.filter(
              (row) => row.body === commentBody,
            ).length,
        )
        .toBe(1);
      caseProgress("comment_saved");
      await expect(
        guest.getByRole("button", { name: "Undo", exact: true }),
      ).toBeEnabled();
      phase = "capture-before-reload";
      const before = read();
      const own = before.project.history.entries[before.project.history.cursor];
      expect(
        typeof own?.author === "string" && own.author.startsWith("share:"),
      ).toBe(true);

      const previousGeneration = before.project.render.proxy_manifests?.[0];
      expect(typeof previousGeneration?.revision === "string").toBe(true);
      expect(
        previousGeneration?.project_basis.history_head_id === own?.id,
      ).toBe(false);

      phase = "reload-guest";
      await guest.reload();
      await expect(guest.locator(".stage-frame--guest")).toBeVisible();
      await expect
        .poll(
          () =>
            read().project.render.proxy_manifests?.[0]?.project_basis
              .history_head_id,
        )
        .toBe(own?.id);
      phase = "assert-derived-save-preserved-history";
      const after = read();
      expect(
        after.project.render.proxy_manifests?.[0]?.revision ===
          previousGeneration?.revision,
      ).toBe(false);
      expect(after.bytes === before.bytes).toBe(false);
      expect(after.certificate === before.certificate).toBe(false);
      expect(after.history === before.history).toBe(true);
      expect(after.index === before.index).toBe(true);
      caseProgress("derived_checked");
      await guest.getByRole("tab", { name: "Review", exact: true }).click();
      await expect(comment).toHaveCount(1);
      phase = "undo-editor-comment";
      await guest.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(comment).toHaveCount(0);
      await expect
        .poll(() => digest(JSON.stringify(read().project.review.comments)))
        .toBe(originalComments);
      caseProgress("undo_checked");
      phase = "redo-editor-comment";
      await guest.getByRole("button", { name: "Redo", exact: true }).click();
      await expect(comment).toHaveCount(1);
      await expect
        .poll(() => digest(JSON.stringify(read().project.review.comments)))
        .toBe(digest(JSON.stringify(before.project.review.comments)));
      caseProgress("body_complete");
    } catch (error) {
      bodyFailed = true;
      bodyClassification = classificationOf(error);
    }
    try {
      if (guestContext) await guestContext.close();
    } catch (error) {
      cleanupErrors.push(
        new Error(`Guest context cleanup failed [${classificationOf(error)}]`),
      );
    }
    try {
      await page.close();
    } catch (error) {
      cleanupErrors.push(
        new Error(`Host page cleanup failed [${classificationOf(error)}]`),
      );
    }
    try {
      await switchE2eProject(e2eProjectPath);
    } catch (error) {
      cleanupErrors.push(
        new Error(
          `Host project restoration failed [${classificationOf(error)}]`,
        ),
      );
    }
    const errors = bodyFailed
      ? [
          new Error(`Scenario failed at ${phase} [${bodyClassification}]`),
          ...cleanupErrors,
        ]
      : cleanupErrors;
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        "Guest derived-save scenario or cleanup failed",
      );
    process.stdout.write("sharecut-3923-ui-derived-save: case completed\n");
  },
);
