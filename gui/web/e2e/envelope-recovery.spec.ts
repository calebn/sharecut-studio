import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import { setTheme } from "./theme";

type Point = { id: string; time: number; value: number };
type Project = {
  timeline: { tracks: Array<{ id: string }> };
  mix: {
    automation_envelopes: Array<{
      track_id: string;
      parameter: string;
      points: Point[];
    }>;
  };
};

function seedEnvelope(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = JSON.parse(
    fs.readFileSync(fixture.projectPath, "utf8"),
  ) as Project;
  const trackId = project.timeline.tracks[0]?.id;
  if (!trackId) throw new Error("Disposable fixture has no track");
  project.mix.automation_envelopes = [
    {
      track_id: trackId,
      parameter: "volume",
      points: [
        { id: "escape-first", time: 2, value: 0.6 },
        { id: "escape-second", time: 10, value: 0.9 },
      ],
    },
  ];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}

function savedState(projectPath: string) {
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8")) as Project;
  const historyPath = path.join(
    path.dirname(projectPath),
    "history",
    "index.json",
  );
  const history = fs.existsSync(historyPath)
    ? (JSON.parse(fs.readFileSync(historyPath, "utf8")) as {
        entries: unknown[];
      })
    : { entries: [] };
  return {
    points: project.mix.automation_envelopes[0]?.points,
    historyEntries: history.entries.length,
  };
}

test("Escape restores an active envelope draft without a saved edit or history entry", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withShareableProject(
    async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      await expect(page.locator(".daw-shell--desktop")).toBeVisible();
      await setTheme(page, "light");
      await page.getByRole("button", { name: "View", exact: true }).click();
      const menu = page.getByRole("menu", { name: "View menu" });
      const layer = menu.getByRole("menuitemcheckbox", {
        name: "Volume envelope",
        exact: true,
      });
      if ((await layer.getAttribute("aria-checked")) !== "true")
        await layer.click();
      if (await menu.isVisible()) await page.keyboard.press("Escape");
      const first = page
        .locator(".lane-row")
        .first()
        .locator('circle[aria-label^="Envelope point 1 at"]');
      await expect(first).toBeVisible();
      const geometry = () =>
        first.evaluate((element) => ({
          cx: element.getAttribute("cx"),
          cy: element.getAttribute("cy"),
        }));
      const before = savedState(projectPath);
      const original = await geometry();
      const box = await first.boundingBox();
      if (!box) throw new Error("Envelope point has no bounding box");
      const commands: unknown[] = [];
      const responses: Array<Promise<unknown>> = [];
      page.on("request", (request) => {
        if (
          request.method() !== "POST" ||
          !request.url().includes("/api/document/command")
        )
          return;
        const payload = request.postDataJSON() as { type?: string };
        if (payload.type !== "SetEnvelope") return;
        commands.push(payload);
        responses.push(request.response());
      });
      await first.focus();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2 + 45,
        box.y + box.height / 2 - 12,
        { steps: 5 },
      );
      await expect.poll(geometry).not.toEqual(original);
      const draft = await geometry();
      expect(savedState(projectPath)).toEqual(before);
      await page.screenshot({
        path: testInfo.outputPath("envelope-draft-before-escape.png"),
      });
      await page.keyboard.press("Escape");
      const afterEscape = await geometry();
      await page.screenshot({
        path: testInfo.outputPath("envelope-after-escape.png"),
      });
      expect
        .soft(afterEscape, "Escape must restore the saved point before release")
        .toEqual(original);
      await page.mouse.up();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await Promise.all(responses);
      const afterRelease = savedState(projectPath);
      await page.screenshot({
        path: testInfo.outputPath("envelope-after-cancelled-release.png"),
      });
      await testInfo.attach("envelope-recovery-evidence", {
        body: JSON.stringify(
          { before, original, draft, afterEscape, afterRelease, commands },
          null,
          2,
        ),
        contentType: "application/json",
      });
      expect
        .soft(commands, "A release after Escape must not dispatch SetEnvelope")
        .toHaveLength(0);
      expect
        .soft(
          afterRelease.points,
          "Cancellation must preserve durable envelope points",
        )
        .toEqual(before.points);
      expect
        .soft(
          afterRelease.historyEntries,
          "Cancellation must not append history",
        )
        .toBe(before.historyEntries);
    },
    undefined,
    seedEnvelope,
  );
});
