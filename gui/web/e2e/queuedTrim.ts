import { expect, type Page, type Route } from "@playwright/test";
import { hostOfflineQueueCount } from "./offlineQueue";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { zoomTimelineIn } from "./timelineZoom";

type TrimCommand = {
  command_id: string;
  type: string;
  payload: {
    clip_id: string;
    edge: "in" | "out";
    source_sec: number;
    mode: string;
    expected_token: string;
  };
};

type Layout = string;
type Sampled = { frames: Layout[]; releasedAt: number | null };

/**
 * Every painted clip as `left|width|title`, per lane, so a ripple on another
 * lane counts too. The title carries the clip's length, which a timeline that
 * refits to a shorter episode does not hide in pixels.
 */
const LAYOUT = `Array.from(document.querySelectorAll('.lane-row')).map((lane) =>
  Array.from(lane.querySelectorAll('[data-testid="timeline-clip"]'))
    .map((el) => el.style.left + '|' + el.style.width + '|' + el.title.split(' · ')[0])
    .sort()
    .join(',')
).join(' / ')`;

function layout(page: Page): Promise<Layout> {
  return page.evaluate(LAYOUT);
}

async function serverClips(page: Page, projectPath: string) {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const saved = (await response.json()) as {
    clips: {
      tracks: Record<
        string,
        Array<{
          id: string;
          source_start: number;
          source_end: number;
          timeline_start: number;
          timeline_end: number;
        }>
      >;
    };
  };
  return Object.fromEntries(
    Object.entries(saved.clips.tracks).map(([track, lane]) => [
      track,
      lane.map((c) => [
        c.source_start,
        c.source_end,
        c.timeline_start,
        c.timeline_end,
      ]),
    ]),
  );
}

function recordFrames(page: Page) {
  return page.evaluate((layoutSource) => {
    const read = new Function(`return ${layoutSource}`) as () => string;
    const sampled: Sampled = { frames: [], releasedAt: null };
    window.addEventListener(
      "pointerup",
      () => {
        sampled.releasedAt ??= sampled.frames.length;
      },
      { capture: true, once: true },
    );
    const sample = () => {
      sampled.frames.push(read());
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    (window as unknown as { __trimFrames: Sampled }).__trimFrames = sampled;
  }, LAYOUT);
}

function frames(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __trimFrames: Sampled }).__trimFrames,
  );
}

/**
 * Trim a clip's out edge while its command cannot reach the server, and check
 * the painted bounds on every frame until the one retry lands.
 */
export async function expectQueuedTrimHoldsUntilItSyncs(page: Page) {
  await withShareableProject(async (projectPath) => {
    const commands: TrimCommand[] = [];
    let offline = true;
    await page.route("**/api/document/command?*", async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const command = route.request().postDataJSON() as TrimCommand;
      if (command.type !== "TrimClipEdge") return route.continue();
      commands.push(command);
      return offline ? route.abort("failed") : route.continue();
    });
    await openProject(page, projectPath);
    const block = page
      .locator(".lane-row")
      .first()
      .locator('[data-testid="timeline-clip"]');
    await expect(block).toHaveCount(1);
    const slider = page.getByRole("slider", { name: "Timeline position" });
    await slider.press("Home");
    await slider.focus();
    let presses = 0;
    while ((await block.boundingBox())!.width < 160 && presses < 24) {
      presses += (await zoomTimelineIn(page, { maxSteps: 1 })).steps;
      await slider.press("Home");
    }
    const savedLayout = await layout(page);
    const savedClips = await serverClips(page, projectPath);

    await block.locator(".clip-hit").click();
    const handle = block.locator(".trim-handle.out");
    await expect(handle).toHaveCSS("opacity", "1");
    const box = (await handle.boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x - 60, at.y, { steps: 10 });
    await expect(block).toHaveClass(/trim-dragging/);
    await expect.poll(() => layout(page)).not.toBe(savedLayout);
    const dragged = await layout(page);
    await recordFrames(page);
    await page.mouse.up();

    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]!.payload.edge).toBe("out");
    expect(commands[0]!.payload.mode).toBe("ripple");
    const target = commands[0]!.payload.source_sec;
    await expect.poll(() => hostOfflineQueueCount(page, projectPath)).toBe(1);
    await expect(block).not.toHaveClass(/trim-dragging/);
    await expect
      .poll(() => layout(page), { message: "the queued trim is shown" })
      .not.toBe(savedLayout);
    const held = await layout(page);
    const length = (laid: Layout) => laid.split(" / ")[0]!.split("|")[2];
    expect(
      length(held),
      "the trimmed clip keeps the length it was put at",
    ).toBe(length(dragged));
    expect(length(held)).not.toBe(length(savedLayout));
    expect(await serverClips(page, projectPath)).toEqual(savedClips);

    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => commands.length).toBeGreaterThanOrEqual(2);
    expect(commands[1]?.command_id).toBe(commands[0]?.command_id);
    await expect.poll(() => hostOfflineQueueCount(page, projectPath)).toBe(0);
    await expect
      .poll(async () => {
        const clips = await serverClips(page, projectPath);
        return JSON.stringify(clips) === JSON.stringify(savedClips);
      })
      .toBe(false);
    const clipId = commands[0]!.payload.clip_id;
    expect(clipId).toBeTruthy();
    expect(target).toBeLessThan(
      savedClips[Object.keys(savedClips)[0]!]![0]![1]!,
    );
    expect(commands, "exactly one retry").toHaveLength(2);
    expect(commands.map((c) => c.command_id)).toEqual(
      Array(2).fill(commands[0]!.command_id),
    );
    await expect.poll(() => layout(page)).toBe(held);

    const { frames: seen, releasedAt } = await frames(page);
    expect(releasedAt, "pointerup was sampled").not.toBeNull();
    const afterRelease = seen.slice(releasedAt!);
    expect(
      afterRelease.length,
      "frames were sampled after release",
    ).toBeGreaterThan(0);
    expect(
      afterRelease.filter((frame) => frame !== dragged && frame !== held),
      "every frame after release paints the dragged or the held bounds, never the saved ones",
    ).toEqual([]);
    const firstHeld = afterRelease.indexOf(held);
    expect(firstHeld, "the held bounds were painted").toBeGreaterThanOrEqual(0);
    expect(
      afterRelease.slice(firstHeld).filter((frame) => frame !== held),
      "once held, the bounds never change again, not even when the retry lands",
    ).toEqual([]);
  });
}
