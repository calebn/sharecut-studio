import fs from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { deferred } from "../src/test/deferred";
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
import { ensureInspected, openProjectDialog } from "./stageNav";
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
] as const;

async function activate(control: Locator, touch: boolean) {
  if (touch) await control.tap();
  else await control.click();
}
const clipBlock = (page: Page, id: string, track = "reference") =>
  page.locator(
    `.lane-row[data-track-id="${track}"] .clip-block[data-clip-id="${id}"]`,
  );

test("queued Apply retains the exact placement preview until the prior track save settles", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withShareableProject(
    async (projectPath) => {
      const acknowledgement = deferred();
      const routeFinished = deferred();
      const commands: Command[] = [];
      let reorderId: string | undefined;
      let reorderStatus: number | undefined;
      let reorderApplied = false;
      let held = false;
      let released = false;
      let stage = "setup";
      page.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload }) => {
          const frame: unknown = JSON.parse(payload.toString());
          if (
            frame &&
            typeof frame === "object" &&
            "plane" in frame &&
            frame.plane === "document" &&
            "type" in frame &&
            frame.type === "Applied" &&
            "command" in frame &&
            frame.command &&
            typeof frame.command === "object" &&
            "command_id" in frame.command &&
            reorderId !== undefined &&
            frame.command.command_id === reorderId
          )
            reorderApplied = true;
        });
      });
      const commandRoute = (url: URL) =>
        url.pathname === "/api/document/command" &&
        url.searchParams.get("path") === projectPath;
      await page.route(commandRoute, async (route) => {
        const command: Command = route.request().postDataJSON();
        commands.push(command);
        if (command.type !== "ReorderTrack" || held) {
          await route.continue();
          return;
        }
        held = true;
        reorderId = command.command_id;
        try {
          const response = await route.fetch();
          reorderStatus = response.status();
          await acknowledgement.promise;
          await route.fulfill({ response });
        } finally {
          routeFinished.resolve();
        }
      });
      const clip = clipBlock(page, "placement-first");
      const geometry = () =>
        clip.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const lane = element.closest(".lane-row")!.getBoundingClientRect();
          return {
            x: box.x - lane.x,
            width: box.width,
            height: box.height,
          };
        });
      const capture = async (name: string) => {
        const file = info.outputPath(`${name}.json`);
        const present = (await clip.count()) > 0;
        fs.writeFileSync(
          file,
          `${JSON.stringify(
            {
              stage,
              saved: snapshot(projectPath),
              geometry: present ? await geometry() : null,
              label: present
                ? await clip.locator(".clip-hit").getAttribute("aria-label")
                : null,
              controls: await page
                .locator(".clip-placement-controls")
                .allTextContents(),
              commands,
              reorderStatus,
              reorderApplied,
              held,
              released,
            },
            null,
            2,
          )}\n`,
        );
        await info.attach(name, {
          path: file,
          contentType: "application/json",
        });
        const screenshot = info.outputPath(`${name}.png`);
        await page.screenshot({ path: screenshot });
        await info.attach(name, { path: screenshot, contentType: "image/png" });
      };
      try {
        await openHostShare(page, projectPath);
        const before = snapshot(projectPath).clips;
        await capture("before");
        stage = "prior track save";
        await page
          .getByRole("button", {
            name: "Reorder track reference",
            exact: true,
          })
          .click();
        await openProjectDialog(page, "palette");
        await page
          .getByRole("combobox", { name: "Search commands" })
          .fill("Move track down");
        await page.keyboard.press("Enter");
        await expect.poll(() => reorderStatus).toBe(200);
        await expect.poll(() => reorderApplied).toBe(true);
        await expect
          .poll(() =>
            page
              .locator(".lane-row[data-track-id]")
              .evaluateAll((rows) =>
                rows.map((row) => row.getAttribute("data-track-id")),
              ),
          )
          .toEqual(["guest", "reference"]);
        expect(
          read(projectPath).timeline.tracks.map((track) => track.id),
        ).toEqual(["guest", "reference"]);
        // The track's Inspector card floats over the corner controls: close it,
        // then zoom in so a short clip's body stays pressable.
        const card = page.getByRole("dialog", {
          name: "Inspector",
          exact: true,
        });
        if (await card.count())
          await card.getByRole("button", { name: "Close" }).click();
        for (let step = 0; step < 4; step++)
          await page.getByRole("button", { name: /^Zoom in/ }).click();
        await clip.locator(".clip-hit").click();
        await ensureInspected(page);
        stage = "Move clip admission";
        const entry = page.getByRole("button", {
          name: "Move clip",
          exact: true,
        });
        await expect(entry).toBeEnabled();
        await entry.click();
        stage = "preview";
        const original = await geometry();
        await page.getByLabel("Timeline start (seconds)").fill("7");
        await expect(clip.locator(".clip-hit")).toHaveAccessibleName(
          "Select reference clip at 00:07.000, 2s",
        );
        const preview = await geometry();
        await capture("preview");
        expect(preview.x).toBeLessThan(original.x);
        expect(preview.width).toBe(original.width);
        expect(preview.height).toBe(original.height);
        expect(snapshot(projectPath).clips).toEqual(before);
        stage = "queued Apply";
        await page
          .getByRole("button", { name: "Apply move", exact: true })
          .click();
        await capture("queued");
        await expect(
          page.getByRole("button", { name: "Applying move…", exact: true }),
        ).toBeDisabled();
        await expect(
          page.getByLabel("Timeline start (seconds)"),
        ).toBeDisabled();
        await expect(
          page.getByRole("button", { name: "Cancel", exact: true }),
        ).toBeDisabled();
        expect(released).toBe(false);
        expect(
          commands.filter((command) => command.type === "MoveClips"),
        ).toHaveLength(0);
        expect(snapshot(projectPath).clips).toEqual(before);
        await expect
          .soft(clip.locator(".clip-hit"))
          .toHaveAccessibleName("Select reference clip at 00:07.000, 2s");
        expect.soft(await geometry()).toEqual(preview);
        stage = "released acknowledgement";
        released = true;
        acknowledgement.resolve();
        await routeFinished.promise;
        await expect
          .poll(
            () =>
              read(projectPath).timeline.clips.find(
                (row) => row.id === "placement-first",
              )?.timeline_start,
          )
          .toBe(7);
        await expect(entry).toBeVisible();
        expect(
          commands.filter((command) => command.type === "MoveClips"),
        ).toHaveLength(1);
        expect(
          read(projectPath).timeline.clips.find(
            (row) => row.id === "placement-second",
          )?.timeline_start,
        ).toBe(27.02);
        await expect(clip.locator(".clip-hit")).toHaveAccessibleName(
          "Select reference clip at 00:07.000, 2s",
        );
      } finally {
        try {
          await capture("final");
        } finally {
          released = true;
          acknowledgement.resolve();
          if (held) await routeFinished.promise;
          await page.unroute(commandRoute);
        }
      }
    },
    undefined,
    placementFixture,
  );
});

for (const { cell, theme, reducedMotion } of withAppearance(cells)) {
  test.describe(cell.name, () => {
    test.use({
      viewport: cell.viewport,
      hasTouch: cell.touch,
      isMobile: cell.viewport.width < 768,
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    test("pointer placement", async ({ page }, info) => {
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
          // Large text widens the trim handles over a short clip; zoom until the
          // clip body is wide enough to press without landing on a handle.
          if (cell.large)
            for (let step = 0; step < 4; step++)
              await activate(
                page.getByRole("button", { name: /^Zoom in/ }),
                cell.touch,
              );
          const before = snapshot(projectPath);
          await activate(
            clipBlock(page, "placement-first").locator(".clip-hit"),
            cell.touch,
          );
          await ensureInspected(page);
          const entry = page.getByRole("button", {
            name: "Move clip",
            exact: true,
          });
          {
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
      // The Inspector column narrows a fitted timeline until a short clip is
      // all trim handle; zoom in so the clip body stays pressable.
      for (let step = 0; step < 2; step++)
        await page.getByRole("button", { name: /^Zoom in/ }).click();
      const before = snapshot(projectPath);
      await activate(
        clipBlock(page, "placement-first").locator(".clip-hit"),
        false,
      );
      await clipBlock(page, "placement-second")
        .locator(".clip-hit")
        .click({ modifiers: ["ControlOrMeta"] });
      await ensureInspected(page);
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
      const movedToast = page
        .getByRole("region", { name: "Status messages" })
        .filter({ hasText: "Moved clips" });
      await expect(
        movedToast.getByRole("button", { name: "Undo", exact: true }),
      ).toBeVisible();
      await info.attach("moved-clips-undo", {
        body: await page.screenshot({
          path: info.outputPath("moved-clips-undo.png"),
        }),
        contentType: "image/png",
      });
      await movedToast
        .getByRole("button", { name: "Undo", exact: true })
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
