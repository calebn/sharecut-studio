import fs from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { type Command, read, snapshot } from "./lifecycleAudit";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { setTheme, withAppearance } from "./theme";

function placementFixture(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = read(fixture.projectPath);
  const source = project.timeline.clips[0];
  project.timeline.clips = [
    {
      ...source,
      id: "placement-first",
      source_start: 0,
      source_end: 2,
      timeline_start: 7.02,
    },
    {
      ...source,
      id: "placement-second",
      source_start: 2,
      source_end: 4,
      timeline_start: 27.02,
    },
  ];
  project.mix.automation_envelopes = [];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}
const cells = [
  {
    name: "desktop host mouse",
    viewport: { width: 1440, height: 900 },
    touch: false,
    role: "host",
    large: false,
  },
  {
    name: "tablet Editor touch",
    viewport: { width: 1024, height: 768 },
    touch: true,
    role: "editor",
    large: false,
  },
  {
    name: "phone host touch",
    viewport: { width: 390, height: 844 },
    touch: true,
    role: "host",
    large: false,
  },
  {
    name: "desktop short large text Editor",
    viewport: { width: 1280, height: 600 },
    touch: false,
    role: "editor",
    large: true,
  },
  {
    name: "tablet Commenter touch",
    viewport: { width: 1024, height: 600 },
    touch: true,
    role: "commenter",
    large: true,
  },
  {
    name: "phone Viewer touch",
    viewport: { width: 390, height: 667 },
    touch: true,
    role: "viewer",
    large: false,
  },
] as const;

async function activate(control: Locator, touch: boolean) {
  if (touch) await control.tap();
  else await control.click();
}
const clipBlock = (page: Page, id: string, track = "reference") =>
  page.locator(
    `.lane-row[data-track-id="${track}"] .clip-block[data-clip-id="${id}"]`,
  );

for (const { cell, theme, reducedMotion } of withAppearance(cells)) {
  test.describe(cell.name, () => {
    test.use({
      viewport: cell.viewport,
      hasTouch: cell.touch,
      isMobile: cell.viewport.width < 768,
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    test("pointer placement and panel preferences", async ({ page }, info) => {
      await rememberInspectorDetent(page, "half");
      await withShareableProject(
        async (projectPath) => {
          const commands: Command[] = [];
          page.on("request", (request) => {
            if (
              request.method() === "POST" &&
              new URL(request.url()).pathname.endsWith("/document/command")
            )
              commands.push(request.postDataJSON());
          });
          if (cell.role === "host") await openHostShare(page, projectPath);
          else {
            const token = await createReviewShare(page, projectPath, cell.role);
            await openGuestShare(page, token);
            await page.waitForLoadState("networkidle");
          }
          await setTheme(page, theme);
          if (cell.large)
            await page.evaluate(() => {
              document.documentElement.style.fontSize = "24px";
            });
          if (cell.viewport.width < 768) await openPhoneTimeline(page);
          await page.evaluate(() => {
            document.addEventListener(
              "pointerdown",
              (event) => {
                document.documentElement.dataset.placementPointer =
                  JSON.stringify({
                    trusted: event.isTrusted,
                    pointerType: event.pointerType,
                  });
              },
              true,
            );
          });
          const before = snapshot(projectPath);
          const bytes = fs.readFileSync(projectPath, "utf8");
          await activate(
            clipBlock(page, "placement-first").locator(".clip-hit"),
            cell.touch,
          );
          const entry = page.getByRole("button", {
            name: "Move clip",
            exact: true,
          });
          if (cell.role === "commenter" || cell.role === "viewer") {
            await expect(entry).toBeDisabled();
            expect(snapshot(projectPath)).toEqual(before);
          } else {
            await activate(entry, cell.touch);
            const pointer = await page
              .locator("html")
              .getAttribute("data-placement-pointer");
            expect(JSON.parse(pointer ?? "null")).toEqual({
              trusted: true,
              pointerType: cell.touch ? "touch" : "mouse",
            });
            const originalLeft = await clipBlock(
              page,
              "placement-first",
            ).evaluate((element) => element.style.left);
            await activate(
              page.getByRole("button", { name: "Earlier 10 ms" }),
              cell.touch,
            );
            await expect(
              page.getByLabel("Timeline start (seconds)"),
            ).toHaveValue("7.01");
            await expect
              .poll(() =>
                clipBlock(page, "placement-first").evaluate(
                  (element) => element.style.left,
                ),
              )
              .not.toBe(originalLeft);
            expect(snapshot(projectPath)).toEqual(before);
            await info.attach("time-preview", {
              body: await page.screenshot({
                path: info.outputPath("time-preview.png"),
              }),
              contentType: "image/png",
            });
            await activate(
              page.getByRole("button", { name: "Cancel", exact: true }),
              cell.touch,
            );
            expect(snapshot(projectPath)).toEqual(before);
            await activate(entry, cell.touch);
            await activate(
              page.getByRole("button", { name: "Apply move", exact: true }),
              cell.touch,
            );
            await expect(entry).toBeVisible();
            expect(
              commands.filter((command) => command.type === "MoveClips"),
            ).toHaveLength(0);
            expect(snapshot(projectPath)).toEqual(before);
            await activate(entry, cell.touch);
            for (let step = 0; step < 2; step++)
              await activate(
                page.getByRole("button", { name: "Earlier 10 ms" }),
                cell.touch,
              );
            await expect(
              page.getByLabel("Timeline start (seconds)"),
            ).toHaveValue("7");
            // Playwright cannot operate the OS option popup with portable pointer coordinates.
            await page
              .getByRole("combobox", { name: "Target track" })
              .selectOption("guest");
            await expect(
              clipBlock(page, "placement-first", "guest"),
            ).toBeVisible();
            expect(snapshot(projectPath)).toEqual(before);
            await expectPageAxeClean(page, ".clip-placement-controls");
            await info.attach("lane-preview", {
              body: await page.screenshot({
                path: info.outputPath("lane-preview.png"),
              }),
              contentType: "image/png",
            });
            await activate(
              page.getByRole("button", { name: "Apply move", exact: true }),
              cell.touch,
            );
            await expect
              .poll(() =>
                read(projectPath).timeline.clips.find(
                  (clip) => clip.id === "placement-first",
                ),
              )
              .toMatchObject({ timeline_start: 7, track_id: "guest" });
            expect(
              commands.filter((command) => command.type === "MoveClips"),
            ).toHaveLength(1);
            const saved = snapshot(projectPath);
            expect(
              saved.history?.entries.filter((entry) => entry.operation !== null)
                .length,
            ).toBe(
              (before.history?.entries.filter(
                (entry) => entry.operation !== null,
              ).length ?? 0) + 1,
            );
            const recoveryPage =
              cell.role === "editor" ? await page.context().newPage() : page;
            try {
              if (recoveryPage !== page)
                await openHostShare(recoveryPage, projectPath);
              await activate(
                recoveryPage
                  .getByRole("button", { name: "Undo", exact: true })
                  .last(),
                cell.touch,
              );
              await expect
                .poll(() => snapshot(projectPath).clips)
                .toEqual(before.clips);
            } finally {
              if (recoveryPage !== page) await recoveryPage.close();
            }
          }
          if (cell.viewport.width < 768) {
            await expect(
              page.getByRole("separator", { name: "Resize editor panels" }),
            ).toHaveCount(0);
            await expect(
              page.getByRole("group", { name: "Panel size", exact: true }),
            ).toHaveCount(0);
          } else {
            const sheet = page.locator(".bottom-sheet");
            if (await sheet.isVisible()) {
              await activate(
                sheet.getByRole("button", { name: "Close", exact: true }),
                cell.touch,
              );
            }
            const panel = page.locator(".bottom-tabs");
            const height = await panel.evaluate(
              (element) => element.getBoundingClientRect().height,
            );
            const rem = await page.evaluate(() =>
              Number.parseFloat(
                getComputedStyle(document.documentElement).fontSize,
              ),
            );
            const prior = snapshot(projectPath);
            const mutations = commands.length;
            await activate(
              page.getByRole("button", { name: "Taller", exact: true }),
              cell.touch,
            );
            await expect
              .poll(() =>
                panel.evaluate(
                  (element) => element.getBoundingClientRect().height,
                ),
              )
              .toBeCloseTo(height + rem, 0);
            const stored = await page.evaluate(() =>
              localStorage.getItem("sharecut.tabsHeight"),
            );
            expect(Number(stored)).toBeCloseTo(height / rem + 1, 4);
            await info.attach("panel-step", {
              body: await page.screenshot({
                path: info.outputPath("panel-step.png"),
              }),
              contentType: "image/png",
            });
            await page.reload();
            expect(
              await page.evaluate(() =>
                localStorage.getItem("sharecut.tabsHeight"),
              ),
            ).toBe(stored);
            await activate(
              page.getByRole("button", { name: "Shorter", exact: true }),
              cell.touch,
            );
            await activate(
              page.getByRole("button", { name: "Reset panel size" }),
              cell.touch,
            );
            expect(
              await page.evaluate(() =>
                localStorage.getItem("sharecut.tabsHeight"),
              ),
            ).toBeNull();
            expect(snapshot(projectPath)).toEqual(prior);
            expect(commands).toHaveLength(mutations);
          }
          if (cell.role === "commenter" || cell.role === "viewer")
            expect(fs.readFileSync(projectPath, "utf8")).toBe(bytes);
          await info.attach("input-provenance.json", {
            body: JSON.stringify({
              shell: cell.name,
              theme,
              reducedMotion,
              nativeInput: cell.touch ? "browser touch" : "mouse",
              physicalDevice: false,
              syntheticAssistance: ["selectOption for native OS popup"],
              commands,
            }),
            contentType: "application/json",
          });
        },
        undefined,
        placementFixture,
      );
    });
  });
}

test("group pointer steps save exact 7/27 placements, refusal recovers and one Undo restores both", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      const before = snapshot(projectPath);
      await activate(
        clipBlock(page, "placement-first").locator(".clip-hit"),
        false,
      );
      await clipBlock(page, "placement-second")
        .locator(".clip-hit")
        .click({ modifiers: ["ControlOrMeta"] });
      await page
        .getByRole("button", { name: "Move clip", exact: true })
        .click();
      await expect(
        page.getByText("Move 2 selected clips", { exact: true }),
      ).toBeVisible();
      for (let step = 0; step < 2; step++)
        await page.getByRole("button", { name: "Earlier 10 ms" }).click();
      await page
        .getByRole("combobox", { name: "Target track" })
        .selectOption("guest");
      for (const id of ["placement-first", "placement-second"])
        await expect(clipBlock(page, id, "guest")).toBeVisible();
      expect(snapshot(projectPath)).toEqual(before);
      let submissions = 0;
      await page.route(/\/api\/document\/command(?:\?|$)/, async (route) => {
        if (route.request().postDataJSON()?.type !== "MoveClips") {
          await route.continue();
          return;
        }
        submissions++;
        if (submissions === 1)
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              detail: "Save refused for placement recovery proof",
            }),
          });
        else await route.continue();
      });
      await page
        .getByRole("button", { name: "Apply move", exact: true })
        .click();
      await expect(
        page.locator(".clip-placement-controls").getByRole("alert"),
      ).toContainText("Save refused");
      expect(snapshot(projectPath)).toEqual(before);
      await info.attach("refused-move", {
        body: await page.screenshot({
          path: info.outputPath("refused-move.png"),
        }),
        contentType: "image/png",
      });
      await page
        .getByRole("button", { name: "Apply move", exact: true })
        .click();
      await expect
        .poll(() =>
          read(projectPath).timeline.clips.map((clip) => [
            clip.id,
            clip.timeline_start,
            clip.track_id,
          ]),
        )
        .toEqual([
          ["placement-first", 7, "guest"],
          ["placement-second", 27, "guest"],
        ]);
      expect(submissions).toBe(2);
      expect(
        snapshot(projectPath).history?.entries.filter(
          (entry) => entry.operation !== null,
        ).length,
      ).toBe(
        (before.history?.entries.filter((entry) => entry.operation !== null)
          .length ?? 0) + 1,
      );
      await page
        .getByRole("button", { name: "Undo", exact: true })
        .first()
        .click();
      await expect
        .poll(() => snapshot(projectPath).clips)
        .toEqual(before.clips);
      await info.attach("provenance.txt", {
        body: "Native mouse initiation, time steps, Apply and Undo. Modifier-assisted multi-selection. selectOption supplies the native select value. HTTP 409 refusal is injected. No physical-device proof.",
        contentType: "text/plain",
      });
    },
    undefined,
    placementFixture,
  );
});
