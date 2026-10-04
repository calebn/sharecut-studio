import fs from "node:fs";
import { expect, type Request } from "@playwright/test";
import { test } from "./interactionEvidence";
import { type Command, read, snapshot } from "./lifecycleAudit";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setTheme } from "./theme";

async function drainResponses(responses: Promise<void>[]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(responses),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Command response retention timed out")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function keyboardFixture(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = read(fixture.projectPath);
  const clip = project.timeline.clips[0];
  clip.id = "keyboard-recovery";
  clip.source_start = 10;
  clip.source_end = 20;
  clip.timeline_start = 5;
  clip.fade_in_ms = 0;
  clip.fade_out_ms = 0;
  project.mix.automation_envelopes = [];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}

for (const edge of [
  {
    cell: "F07-keyboard-draft-escape",
    kind: "trim",
    selector: ".trim-handle.in",
    command: "TrimClipEdge",
    field: "source_start",
    expected: 10.03,
  },
  {
    cell: "F08-fade-keyboard-escape",
    kind: "fade",
    selector: ".fade-corner.in",
    command: "SetClipFade",
    field: "fade_in_ms",
    expected: 3,
  },
] as const) {
  test(`${edge.kind} held keyboard Escape restores draft before inert keyup and a fresh save`, {
    annotation: { type: "878-cell", description: edge.cell },
  }, async ({ page, receipts }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await withShareableProject(
      async (projectPath) => {
        const commands: Command[] = [];
        const responseStatuses: number[] = [];
        const responseReplies: unknown[] = [];
        const pendingResponses: Promise<void>[] = [];
        const listener = (request: Request) => {
          if (
            request.method() !== "POST" ||
            !request.url().includes("/api/document/command")
          )
            return;
          commands.push(request.postDataJSON() as Command);
          pendingResponses.push(
            request.response().then(async (response) => {
              if (response) {
                responseStatuses.push(response.status());
                responseReplies.push(await response.json());
              }
            }),
          );
        };
        page.on("request", listener);
        try {
          await openHostShare(page, projectPath);
          await setTheme(page, "light");
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            "light",
          );
          const block = page.locator(
            '[data-testid="timeline-clip"][data-clip-id="keyboard-recovery"]',
          );
          await block.locator(".clip-hit").click();
          const handle = block.locator(edge.selector);
          await handle.focus();
          await expect(handle).toBeFocused();
          const geometry = () =>
            block.evaluate((element) => ({
              left: (element as HTMLElement).style.left,
              width: (element as HTMLElement).style.width,
              fadeLeft: (
                element.querySelector(".fade-corner.in") as HTMLElement
              ).style.left,
            }));
          const trackOrder = () =>
            page
              .locator(".lane-row[data-track-id]")
              .evaluateAll((lanes) =>
                lanes.map((lane) => lane.getAttribute("data-track-id")),
              );
          const ruler = page.getByRole("slider", { name: "Timeline position" });
          const before = snapshot(projectPath);
          const origin = await geometry();
          const order = await trackOrder();
          expect(order.length).toBeGreaterThanOrEqual(2);
          const clock = await ruler.getAttribute("aria-valuenow");
          for (let repeat = 0; repeat < 3; repeat++)
            await page.keyboard.down("ArrowRight");
          await expect(block).toHaveClass(
            edge.kind === "trim" ? /trim-dragging/ : /fade-dragging/,
          );
          if (edge.kind === "trim") {
            await expect
              .poll(async () => (await geometry()).width)
              .not.toBe(origin.width);
          } else {
            await expect(block.locator(".fade-readout.in")).toHaveText("3 ms");
            await expect
              .poll(async () => (await geometry()).fadeLeft)
              .not.toBe(origin.fadeLeft);
          }
          const preview = await geometry();
          expect(snapshot(projectPath)).toEqual(before);
          expect(commands).toEqual([]);
          await expect(ruler).toHaveAttribute("aria-valuenow", clock!);
          expect(await trackOrder()).toEqual(order);
          await page.keyboard.press("Escape");
          await expect(block).not.toHaveClass(/trim-dragging|fade-dragging/);
          await expect.poll(geometry).toEqual(origin);
          await expect(handle).toBeFocused();
          expect(snapshot(projectPath)).toEqual(before);
          expect(commands).toEqual([]);
          await page.keyboard.up("ArrowRight");
          await expect.poll(geometry).toEqual(origin);
          expect(snapshot(projectPath)).toEqual(before);
          expect(commands).toEqual([]);
          await expect(ruler).toHaveAttribute("aria-valuenow", clock!);
          expect(await trackOrder()).toEqual(order);
          receipts.push({
            checkpoint: `cancelled-${edge.kind}`,
            observation: {
              before,
              origin,
              preview,
              restored: await geometry(),
              clock,
              order,
              commands: [...commands],
              input: "native-keyboard",
            },
          });
          for (let repeat = 0; repeat < 3; repeat++)
            await page.keyboard.down("ArrowRight");
          await page.keyboard.up("ArrowRight");
          await expect
            .poll(
              () =>
                read(projectPath).timeline.clips.find(
                  (clip) => clip.id === "keyboard-recovery",
                )?.[edge.field],
            )
            .toBeCloseTo(edge.expected, 6);
          const changed = snapshot(projectPath);
          expect(changed.history).not.toEqual(before.history);
          expect(changed.history?.cursor).toBe(1);
          expect(
            changed.history?.entries
              .filter((entry) => entry.operation !== null)
              .map((entry) => entry.operation),
          ).toEqual([
            edge.kind === "trim" ? "trim_clip_edge" : "set_clip_fade",
          ]);
          expect(
            commands.filter((command) => command.type === edge.command),
          ).toHaveLength(1);
          const payload = commands[0].payload as Record<string, unknown>;
          expect(payload.clip_id).toBe("keyboard-recovery");
          if (edge.kind === "trim") {
            expect(payload.source_sec).toBeCloseTo(10.03, 6);
            expect(payload.edge).toBe("in");
          } else {
            expect(payload.fade_in_ms).toBe(3);
            expect(payload.fade_out_ms).toBe(0);
          }
          await page.keyboard.press("ControlOrMeta+Z");
          await expect
            .poll(() => snapshot(projectPath).clips)
            .toEqual(before.clips);
          const restored = snapshot(projectPath);
          expect(restored.history?.cursor).toBe(0);
          expect(restored.chapters).toEqual(before.chapters);
          expect(restored.social).toEqual(before.social);
          expect(restored.envelopes).toEqual(before.envelopes);
          expect(restored.transcripts).toEqual(before.transcripts);
          expect(
            commands.filter((command) => command.type === "UndoHistory"),
          ).toHaveLength(1);
          await expect.poll(geometry).toEqual(origin);
          await expect(ruler).toHaveAttribute("aria-valuenow", clock!);
          expect(await trackOrder()).toEqual(order);
          await drainResponses(pendingResponses);
          expect(responseStatuses).toEqual([200, 200]);
          receipts.push({
            checkpoint: `next-${edge.kind}-undo`,
            observation: {
              changed,
              restored: snapshot(projectPath),
              commands,
              responseStatuses,
              responseReplies,
              clock,
              order,
            },
          });
        } finally {
          page.off("request", listener);
          receipts.push({
            checkpoint: "terminal-observation",
            observation: { commands, responseStatuses, responseReplies },
          });
        }
      },
      undefined,
      keyboardFixture,
    );
  });
}
