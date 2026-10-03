import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { setTheme, type Theme } from "./theme";

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
        { id: "recovery-first", time: 2, value: 0.6 },
        { id: "recovery-second", time: 10, value: 0.9 },
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

export async function exerciseEnvelopeRecovery(
  page: Page,
  theme: Theme,
  info: TestInfo,
): Promise<void> {
  await withShareableProject(
    async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      const width = page.viewportSize()!.width;
      const shell = width < 720 ? "phone" : width < 1100 ? "tablet" : "desktop";
      await expect(page.locator(`.daw-shell--${shell}`)).toBeVisible();
      if (shell === "phone") await openPhoneTimeline(page);
      const lane = page.locator(".lane-row").first();
      const owner = lane.locator('circle[aria-label^="Envelope point 1 at"]');
      await expect(owner).toBeVisible();
      if (shell !== "desktop") {
        await owner.click();
        await expect(
          page.getByRole("dialog", { name: "Inspector", exact: true }),
        ).toBeVisible();
        await expect(
          page
            .getByRole("dialog", { name: "Inspector", exact: true })
            .getByRole("button", { name: "Close", exact: true }),
        ).toBeFocused();
      }
      await setTheme(page, theme);
      const otherControl = page.getByRole("button", {
        name: "Menu",
        exact: true,
      });
      const geometry = () =>
        owner.evaluate((element) => ({
          cx: Number(element.getAttribute("cx")),
          cy: Number(element.getAttribute("cy")),
        }));
      const scroll = () =>
        owner.evaluate((element) => {
          const offsets: number[] = [window.scrollX, window.scrollY];
          for (
            let node: Element | null = element;
            node;
            node = node.parentElement
          )
            offsets.push(node.scrollLeft, node.scrollTop);
          return offsets;
        });
      const before = savedState(projectPath);
      const original = await geometry();
      const commands: unknown[] = [];
      const responses: Array<Promise<unknown>> = [];
      page.on("request", (request) => {
        if (
          request.method() !== "POST" ||
          !request.url().includes("/api/document/command")
        )
          return;
        const command = request.postDataJSON() as { type?: string };
        if (command.type !== "SetEnvelope") return;
        commands.push(command);
        responses.push(request.response());
      });
      const events = await owner.evaluateHandle((element) => {
        const events: Array<{
          type: string;
          pointerId: number;
          trusted: boolean;
          pointerType: string;
        }> = [];
        for (const type of [
          "pointerdown",
          "pointermove",
          "pointerup",
          "gotpointercapture",
          "lostpointercapture",
        ]) {
          element.addEventListener(
            type,
            (event) => {
              const pointer = event as PointerEvent;
              events.push({
                type,
                pointerId: pointer.pointerId,
                trusted: event.isTrusted,
                pointerType: pointer.pointerType,
              });
            },
            true,
          );
        }
        return events;
      });
      const ownerId = () =>
        events.evaluate(
          (events) =>
            events.findLast(
              (event) => event.type === "pointerdown" && event.trusted,
            )!.pointerId,
        );
      const begin = async () => {
        await otherControl.focus();
        await expect(otherControl).toBeFocused();
        const box = await owner.boundingBox();
        if (!box) throw new Error("Envelope owner has no geometry");
        const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(start.x, start.y);
        const beforeFocus = await scroll();
        await page.mouse.down();
        await expect(owner).toBeFocused();
        expect(await scroll()).toEqual(beforeFocus);
        await page.mouse.move(start.x + 32, start.y - 8, { steps: 4 });
        await expect(async () => {
          const preview = await geometry();
          expect(preview.cx).toBeCloseTo(original.cx + 32, 4);
          expect(preview.cy).toBeCloseTo(original.cy - 8, 4);
        }).toPass();
        const pointerId = await ownerId();
        expect(
          await owner.evaluate(
            (element, id) => element.hasPointerCapture(id),
            pointerId,
          ),
        ).toBe(true);
        await expect(owner).toHaveAttribute("aria-pressed", "true");
        return { start, pointerId };
      };
      const settle = async () => {
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await Promise.all(responses);
      };

      const laneBefore = await lane.boundingBox();
      const escape = await begin();
      expect(await lane.boundingBox()).toEqual(laneBefore);
      expect(savedState(projectPath)).toEqual(before);
      await page.keyboard.press("Escape");
      await expect.poll(geometry).toEqual(original);
      await expect(owner).toHaveAttribute("aria-pressed", "true");
      await expect(owner).toBeFocused();
      expect(
        await owner.evaluate(
          (element, id) => element.hasPointerCapture(id),
          escape.pointerId,
        ),
      ).toBe(false);
      await page.mouse.up();
      await settle();
      expect(commands).toHaveLength(0);
      expect(savedState(projectPath)).toEqual(before);

      await begin();
      await otherControl.focus();
      await expect(otherControl).toBeFocused();
      await expect.poll(geometry).toEqual(original);
      await page.mouse.up();
      await settle();
      expect(commands).toHaveLength(0);
      expect(savedState(projectPath)).toEqual(before);

      const normal = await begin();
      const ownerDraft = await geometry();
      await owner.dispatchEvent("pointermove", {
        pointerId: 99,
        pointerType: "touch",
        clientX: normal.start.x + 110,
        clientY: normal.start.y + 15,
        bubbles: true,
        buttons: 1,
      });
      expect(await geometry()).toEqual(ownerDraft);
      await owner.dispatchEvent("pointerup", {
        pointerId: 99,
        pointerType: "touch",
        bubbles: true,
        buttons: 0,
      });
      await settle();
      expect(commands).toHaveLength(0);
      expect(savedState(projectPath)).toEqual(before);
      expect(await geometry()).toEqual(ownerDraft);
      expect(
        await owner.evaluate(
          (element, id) => element.hasPointerCapture(id),
          normal.pointerId,
        ),
      ).toBe(true);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect
        .poll(() =>
          page.evaluate(
            () => getComputedStyle(document.documentElement).colorScheme,
          ),
        )
        .toBe(theme);
      await page.screenshot({
        path: info.outputPath("envelope-owner-draft.png"),
      });
      await page.mouse.up();
      await expect.poll(() => commands.length).toBe(1);
      await Promise.all(responses);
      await expect
        .poll(() => savedState(projectPath).points)
        .not.toEqual(before.points);
      const afterOwner = savedState(projectPath);
      expect(afterOwner.points?.[1]).toEqual(before.points?.[1]);
      expect(afterOwner.historyEntries).toBeGreaterThan(before.historyEntries);
      await page.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(() => savedState(projectPath).points)
        .toEqual(before.points);
      expect(commands).toHaveLength(1);
      const pointerEvents = await events.jsonValue();
      expect(
        pointerEvents.some(
          (event) => event.type === "gotpointercapture" && event.trusted,
        ),
      ).toBe(true);
      expect(
        pointerEvents
          .filter((event) => event.pointerId === 99 && !event.trusted)
          .map((event) => event.type),
      ).toEqual(["pointermove", "pointerup"]);
      const evidencePath = info.outputPath("envelope-recovery.json");
      fs.writeFileSync(
        evidencePath,
        `${JSON.stringify({ ownerNative: true, syntheticForeign: true, physicalDevice: false, theme, original, ownerDraft, before, afterOwner, afterUndo: savedState(projectPath), commands, pointerEvents }, null, 2)}\n`,
      );
      await info.attach("native-owner-synthetic-foreign-envelope-recovery", {
        path: evidencePath,
        contentType: "application/json",
      });
      await events.dispose();
    },
    undefined,
    seedEnvelope,
  );
}
