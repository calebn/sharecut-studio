import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { hostOfflineQueueCount } from "./offlineQueue";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { zoomTimelineIn } from "./timelineZoom";

type MoveCommand = {
  command_id: string;
  type: string;
  payload: {
    clips: Array<{ clip_id: string; track_id: string; timeline_start: number }>;
  };
};

type Frames = Array<number | "missing">;

function leftOf(block: Locator): Promise<number> {
  return block.evaluate((el) =>
    Number.parseFloat((el as HTMLElement).style.left),
  );
}

async function widen(page: Page, block: Locator) {
  const slider = page.getByRole("slider", { name: "Timeline position" });
  await slider.press("Home");
  await slider.focus();
  let presses = 0;
  while ((await block.boundingBox())!.width < 120 && presses < 24) {
    const result = await zoomTimelineIn(page, { maxSteps: 1 });
    presses += result.steps;
    await slider.press("Home");
  }
  expect((await block.boundingBox())!.width).toBeGreaterThanOrEqual(120);
}

async function serverStart(page: Page, projectPath: string, clipId: string) {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const saved = (await response.json()) as {
    clips: {
      tracks: Record<string, Array<{ id: string; timeline_start: number }>>;
    };
  };
  return Object.values(saved.clips.tracks)
    .flat()
    .find((row) => row.id === clipId)?.timeline_start;
}

function recordFrames(page: Page, clipId: string) {
  return page.evaluate((id) => {
    const select = `[data-testid="timeline-clip"][data-clip-id="${CSS.escape(id)}"]`;
    const frames: Frames = [];
    const sample = () => {
      const el = document.querySelector<HTMLElement>(select);
      frames.push(el ? Number.parseFloat(el.style.left) : "missing");
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    (window as unknown as { __moveFrames: Frames }).__moveFrames = frames;
  }, clipId);
}

function frames(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __moveFrames: Frames }).__moveFrames,
  );
}

function distinct(values: number[]) {
  const runs: number[] = [];
  for (const value of values) {
    if (runs.length === 0 || Math.abs(value - runs[runs.length - 1]!) > 0.5) {
      runs.push(value);
    }
  }
  return runs;
}

test("a clip move that queues offline stays where it was dropped, then saves once online", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    const commands: MoveCommand[] = [];
    let offline = true;
    await page.route("**/api/document/command?*", async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const command = route.request().postDataJSON() as MoveCommand;
      if (command.type !== "MoveClips") return route.continue();
      commands.push(command);
      return offline ? route.abort("failed") : route.continue();
    });
    await openProject(page, projectPath);
    const block = page
      .locator(".lane-row")
      .first()
      .locator('[data-testid="timeline-clip"]');
    await expect(block).toHaveCount(1);
    const clipId = (await block.getAttribute("data-clip-id"))!;
    const originStart = await serverStart(page, projectPath, clipId);
    await widen(page, block);
    const origin = await leftOf(block);

    const box = (await block.locator(".clip-hit").boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 40, at.y, { steps: 8 });
    await expect(block).toHaveClass(/clip-moving/);
    await expect.poll(() => leftOf(block)).toBeGreaterThan(origin + 20);
    await recordFrames(page, clipId);
    await page.mouse.up();

    await expect.poll(() => commands.length).toBe(1);
    const target = commands[0]!.payload.clips.find(
      (c) => c.clip_id === clipId,
    )!.timeline_start;
    expect(target).toBeGreaterThan(originStart!);
    await expect.poll(() => hostOfflineQueueCount(page, projectPath)).toBe(1);
    const dropped = await leftOf(block);
    expect(
      Math.abs(dropped - origin),
      "the queued move holds its dropped position",
    ).toBeGreaterThan(20);
    expect(await serverStart(page, projectPath, clipId)).toBe(originStart);

    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]?.command_id).toBe(commands[0]?.command_id);
    await expect.poll(() => hostOfflineQueueCount(page, projectPath)).toBe(0);
    await expect
      .poll(() => serverStart(page, projectPath, clipId))
      .toBeCloseTo(target, 6);
    expect(commands, "exactly one retry").toHaveLength(2);
    await expect(block).toHaveCount(1);
    expect(await leftOf(block)).toBeCloseTo(dropped, 0);

    const seen = await frames(page);
    expect(seen, "the block never disappears").not.toContain("missing");
    const painted = seen as number[];
    expect(
      painted.some((x) => Math.abs(x - origin) <= 0.5),
      "the block never paints its origin after release",
    ).toBe(false);
    const runs = distinct(painted);
    expect(runs.length, "one visible update after release").toBeLessThanOrEqual(
      2,
    );
    expect(runs.at(-1)).toBeCloseTo(dropped, 0);
  });
});
