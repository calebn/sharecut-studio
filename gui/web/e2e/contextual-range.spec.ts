import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { repoRoot } from "./env";
import { podcastCommand } from "./guiCommand";
import { createRelocatedE2eProject } from "./liveProject";
import { openTransportMenu } from "./overlayReachability";
import { openPhoneTimeline } from "./phoneTimeline";
import { e2eRuntimeEnv } from "./runtimeEnv";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";

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
  await openTransportMenu(page);
  await page
    .getByRole("menuitem", { name: "Select a range", exact: true })
    .click();
  const range = page.getByRole("region", { name: "Range actions" });
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

async function observePendingPlayback(page: Page) {
  const evidence = await page.evaluateHandle(() => {
    const played: Array<{ url: string; duration: number }> = [];
    const nativePlay: unknown = Reflect.get(HTMLMediaElement.prototype, "play");
    if (typeof nativePlay !== "function")
      throw new Error("Media playback is unavailable");
    HTMLMediaElement.prototype.play = function () {
      if (this.src.startsWith("blob:")) {
        this.addEventListener(
          "playing",
          () => played.push({ url: this.src, duration: this.duration }),
          { once: true },
        );
      }
      return nativePlay.call(this);
    };
    return played;
  });
  return async () => {
    await expect
      .poll(() =>
        evidence.evaluate((played) =>
          played.some(
            (item) => item.url.startsWith("blob:") && item.duration > 0,
          ),
        ),
      )
      .toBe(true);
    await evidence.dispose();
  };
}

async function createSuggestOnlyShare(page: Page, projectPath: string) {
  const published = await page.request.post("/api/shares", {
    data: { path: projectPath, role: "editor" },
  });
  expect(published.ok(), await published.text()).toBeTruthy();
  const publishedBody: unknown = await published.json();
  if (
    typeof publishedBody !== "object" ||
    publishedBody === null ||
    !("share" in publishedBody) ||
    typeof publishedBody.share !== "object" ||
    publishedBody.share === null ||
    !("review_version_id" in publishedBody.share) ||
    typeof publishedBody.share.review_version_id !== "string" ||
    !("token" in publishedBody.share) ||
    typeof publishedBody.share.token !== "string"
  ) {
    throw new Error("Host share response omitted version or token");
  }
  const { review_version_id: versionId, token: setupToken } =
    publishedBody.share;
  const revoked = await page.request.post(
    `/api/shares/${encodeURIComponent(setupToken)}/revoke`,
    { data: { path: projectPath } },
  );
  expect(revoked.ok(), await revoked.text()).toBeTruthy();
  const [command, ...commandArgs] = podcastCommand({
    ci: Boolean(process.env.CI),
  });
  const output = execFileSync(
    command,
    [
      ...commandArgs,
      "review",
      "share",
      "--project",
      projectPath,
      "--version",
      versionId,
      "--capabilities",
      "play,view,suggest,comment",
      "--base-url",
      new URL(page.url()).origin,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: e2eRuntimeEnv(process.env, `share-${process.pid}`),
    },
  );
  const created: unknown = JSON.parse(output);
  if (
    typeof created !== "object" ||
    created === null ||
    !("token" in created) ||
    typeof created.token !== "string"
  ) {
    throw new Error("CLI share response omitted token");
  }
  return created.token;
}

async function undo(page: Page) {
  await page.locator(".timeline-scroll").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
}

async function rangeAxe(page: Page) {
  const result = await new AxeBuilder({ page })
    .include(".range-actions")
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual(
    [],
  );
}

test("idle desktop reaches an edit in removed audio through the status chip", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openHostShare(page, projectPath);
      await expect(page.locator(".daw-main")).toHaveClass(
        /inspector-collapsed/,
      );
      await page
        .getByRole("button", {
          name: "Edits in removed audio (1)",
          exact: true,
        })
        .click();
      await page.locator('[data-pending-id="orphan"]').click();
      await expect(page.locator(".daw-main")).not.toHaveClass(
        /inspector-collapsed/,
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
        await page.reload();
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

test("suggest-only guest proposes a range, host approves, and one Undo restores every occurrence", async ({
  browser,
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      const before = geometry(projectPath);
      const token = await createSuggestOnlyShare(page, projectPath);
      const guestContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      try {
        const guest = await guestContext.newPage();
        await openGuestShare(guest, token);
        const range = await selectRange(guest);
        await expect(
          range.getByRole("button", { name: "Suggest cut", exact: true }),
        ).toBeEnabled();
        await expect(
          range.getByRole("button", { name: "Bounce", exact: true }),
        ).toBeDisabled();
        await rangeAxe(guest);
        await range
          .getByRole("button", { name: "Suggest cut", exact: true })
          .click();
        await expect
          .poll(
            () =>
              JSON.parse(fs.readFileSync(projectPath, "utf8")).editorial
                .edit_decisions.length,
          )
          .toBe(1);
        expect(geometry(projectPath)).toEqual(before);
        await page.reload();
        await page.locator(".pending-overlay").first().click();
        const expectHostPlayback = await observePendingPlayback(page);
        const previewResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/pending-preview",
        );
        await page
          .getByRole("button", { name: "Play around", exact: true })
          .click();
        const audio = await previewResponse;
        expect(audio.status()).toBe(200);
        expect(audio.headers()["content-type"]).toBe("audio/wav");
        await expectHostPlayback();
        expect(geometry(projectPath)).toEqual(before);
        if (process.env.RANGE_CONFIRMATION_SCREENSHOTS) {
          await page.locator(".pending-overlay").first().hover();
          await page.screenshot({
            path: path.join(
              process.env.RANGE_CONFIRMATION_SCREENSHOTS,
              "host-exact-preview-desktop.png",
            ),
            fullPage: true,
          });
        }
        await guest.reload();
        await guest.locator(".pending-overlay").first().click();
        await expect(
          guest
            .getByText(
              "Only the host or an edit guest can review exact range proposals.",
            )
            .first(),
        ).toBeVisible();
        if (process.env.RANGE_CONFIRMATION_SCREENSHOTS) {
          await guest.locator(".pending-overlay").first().hover();
          await guest.screenshot({
            path: path.join(
              process.env.RANGE_CONFIRMATION_SCREENSHOTS,
              "guest-exact-pending-desktop.png",
            ),
            fullPage: true,
          });
        }
        await guest.setViewportSize({ width: 390, height: 844 });
        await openPhoneTimeline(guest);
        await guest.locator(".pending-overlay").first().click();
        const inspector = guest.locator(".modifier-inspector");
        const previewFooter = inspector.locator(".modifier-footer");
        const footerBounds = await previewFooter.boundingBox();
        expect(footerBounds).not.toBeNull();
        for (const fact of [
          inspector.getByText(
            "Only the host or an edit guest can review exact range proposals.",
            { exact: true },
          ),
          inspector.getByText("0:11.000 – 0:12.000", { exact: true }),
          inspector.locator("dd").filter({ hasText: /^reference$/ }),
        ]) {
          await expect(fact).toBeVisible();
          const bounds = await fact.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
            footerBounds!.y + 1,
          );
        }
        await expect(
          previewFooter.getByRole("button", {
            name: "Play around",
            exact: true,
          }),
        ).toBeEnabled();
        if (process.env.RANGE_CONFIRMATION_SCREENSHOTS) {
          await guest.screenshot({
            path: path.join(
              process.env.RANGE_CONFIRMATION_SCREENSHOTS,
              "guest-exact-pending-phone.png",
            ),
            fullPage: true,
          });
        }
        await page
          .locator(".modifier-inspector")
          .getByRole("button", { name: "Approve", exact: true })
          .click();
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
          geometry(projectPath).find((c: { id: string }) => c.id === "peer"),
        ).toEqual(before.find((c: { id: string }) => c.id === "peer"));
        await undo(page);
        await expect.poll(() => geometry(projectPath)).toEqual(before);
        expect(
          JSON.parse(fs.readFileSync(projectPath, "utf8")).editorial
            .edit_decisions,
        ).toHaveLength(1);
      } finally {
        await guestContext.close();
      }
    },
    undefined,
    repeatedProject,
  );
});

test("suggest-only guest proposes for host review and sees the approved cut", async ({
  browser,
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      const before = geometry(projectPath);
      const token = await createSuggestOnlyShare(page, projectPath);
      const guestContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      try {
        const guest = await guestContext.newPage();
        await openGuestShare(guest, token);
        await expect(
          guest.getByText("Shared suggest view", { exact: true }),
        ).toBeVisible();
        const range = await selectRange(guest);
        await range
          .getByRole("button", { name: "Suggest cut", exact: true })
          .click();
        await expect
          .poll(
            () =>
              JSON.parse(fs.readFileSync(projectPath, "utf8")).editorial
                .edit_decisions.length,
          )
          .toBe(1);
        const pending = JSON.parse(fs.readFileSync(projectPath, "utf8"))
          .editorial.edit_decisions[0];
        expect(pending).toMatchObject({
          applied: false,
          review_required: true,
        });
        expect(geometry(projectPath)).toEqual(before);

        const forbiddenApproval = await guest.request.post(
          `/api/review/${encodeURIComponent(token)}/daw/document/command`,
          {
            data: {
              type: "ApproveEdits",
              payload: { ids: [pending.id] },
              client_id: "e2e-denied-approval",
              role: "guest",
              client_seq: Date.now(),
            },
          },
        );
        expect(forbiddenApproval.status()).toBe(403);
        expect(geometry(projectPath)).toEqual(before);

        await guest.locator(".pending-overlay").first().click();
        const guestInspector = guest.locator(".modifier-inspector");
        const guestApprove = guestInspector.getByRole("button", {
          name: "Approve",
          exact: true,
        });
        const guestReject = guestInspector.getByRole("button", {
          name: "Reject",
          exact: true,
        });
        await expect(guestApprove).toBeDisabled();
        await expect(guestApprove).toHaveAttribute(
          "title",
          "Only the host or an edit guest can review exact range proposals",
        );
        await expect(guestReject).toBeDisabled();
        await guestInspector
          .getByRole("button", { name: "Suggested", exact: true })
          .click();
        await expect(
          guestInspector.getByRole("button", {
            name: "Suggested",
            exact: true,
          }),
        ).toHaveAttribute("aria-pressed", "true");
        const expectGuestPlayback = await observePendingPlayback(guest);
        const suggestedPreview = guest.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === `/api/review/${token}/daw/pending-preview` &&
            url.searchParams.get("edit_id") === pending.id &&
            url.searchParams.get("mode") === "suggested"
          );
        });
        await guestInspector
          .getByRole("button", { name: "Play around", exact: true })
          .click();
        const suggestedAudio = await suggestedPreview;
        expect(suggestedAudio.status()).toBe(200);
        expect(suggestedAudio.headers()["content-type"]).toBe("audio/wav");
        await expectGuestPlayback();

        const panels = page.getByLabel("Editor panels");
        await panels.getByRole("button", { name: "Impact" }).click();
        await panels.locator(`button[data-pending-id="${pending.id}"]`).click();
        const hostInspector = page.locator(".modifier-inspector");
        await expect(
          hostInspector.getByRole("button", { name: "Approve", exact: true }),
        ).toBeEnabled();
        await expect(
          hostInspector.getByRole("button", { name: "Reject", exact: true }),
        ).toBeEnabled();
        await hostInspector
          .getByRole("button", { name: "Approve", exact: true })
          .click();
        const approvedGeometry = [
          [0, 5, 0],
          [0, 1, 10],
          [2, 5, 12],
        ];
        await expect
          .poll(() =>
            geometry(projectPath)
              .filter(
                (clip: { track_id: string }) => clip.track_id === "reference",
              )
              .map(
                (clip: {
                  source_start: number;
                  source_end: number;
                  timeline_start: number;
                }) => [clip.source_start, clip.source_end, clip.timeline_start],
              ),
          )
          .toEqual(approvedGeometry);
        await guest.reload();
        await expect(
          guest.locator('.lane-row[data-track-id="reference"] .clip-block'),
        ).toHaveCount(3);
        await expect(
          guest.locator('.lane-row[data-track-id="guest"] .clip-block'),
        ).toHaveCount(1);
        await expect(guest.locator(".pending-overlay")).toHaveCount(0);
        const guestProject = await guest.request.get(
          `/api/review/${encodeURIComponent(token)}/daw/project?phase=full`,
        );
        expect(guestProject.ok()).toBe(true);
        const guestView: unknown = await guestProject.json();
        if (
          typeof guestView !== "object" ||
          guestView === null ||
          !("clips" in guestView) ||
          typeof guestView.clips !== "object" ||
          guestView.clips === null ||
          !("tracks" in guestView.clips) ||
          typeof guestView.clips.tracks !== "object" ||
          guestView.clips.tracks === null ||
          !("reference" in guestView.clips.tracks) ||
          !Array.isArray(guestView.clips.tracks.reference)
        ) {
          throw new Error("Guest project response omitted reference clips");
        }
        const guestReferenceGeometry = guestView.clips.tracks.reference
          .filter(
            (
              clip: unknown,
            ): clip is {
              source_start: number;
              source_end: number;
              timeline_start: number;
            } =>
              typeof clip === "object" &&
              clip !== null &&
              "source_start" in clip &&
              typeof clip.source_start === "number" &&
              "source_end" in clip &&
              typeof clip.source_end === "number" &&
              "timeline_start" in clip &&
              typeof clip.timeline_start === "number",
          )
          .map((clip) => [
            clip.source_start,
            clip.source_end,
            clip.timeline_start,
          ]);
        expect(guestReferenceGeometry).toEqual(approvedGeometry);
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
      await expect(page.locator(".daw-main")).toHaveClass(
        /inspector-collapsed/,
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
          { start_s: 1, end_s: 2, fade_in_ms: 5, fade_out_ms: 5, fill: null },
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
          .click();
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
            .getByRole("region", { name: "Range actions" })
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
