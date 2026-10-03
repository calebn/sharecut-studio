import fs from "node:fs";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { setTheme } from "./theme";
import { zoomTimelineIn } from "./timelineZoom";

type Clip = {
  id: string;
  track_id: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
};
type Project = {
  timeline: { clips: Clip[]; tracks: { id: string }[] };
  editorial: {
    chapters: { time: number; title: string }[];
    edit_decisions: {
      id: string;
      track_id: string;
      type: string;
      start: number;
      end: number;
      applied: boolean;
      review_required: boolean;
    }[];
  };
  social: {
    clip_candidates: {
      id: string;
      track_id: string;
      start: number;
      end: number;
      score: number;
      title_suggestion: string;
    }[];
  };
};
type Command = { type: string; payload: unknown };
const profiles = [
  {
    id: "desktop-light",
    width: 1440,
    height: 900,
    theme: "light",
    motion: "no-preference",
  },
  {
    id: "tablet-dark",
    width: 820,
    height: 1024,
    theme: "dark",
    motion: "reduce",
  },
  {
    id: "phone-light",
    width: 390,
    height: 844,
    theme: "light",
    motion: "reduce",
  },
  {
    id: "desktop-dark",
    width: 1440,
    height: 900,
    theme: "dark",
    motion: "reduce",
  },
  {
    id: "tablet-light",
    width: 820,
    height: 1024,
    theme: "light",
    motion: "no-preference",
  },
  {
    id: "phone-dark",
    width: 390,
    height: 844,
    theme: "dark",
    motion: "no-preference",
  },
] as const;
function read(projectPath: string): Project {
  return JSON.parse(fs.readFileSync(projectPath, "utf8")) as Project;
}
function saved(projectPath: string) {
  const project = read(projectPath);
  const file = path.join(path.dirname(projectPath), "history", "index.json");
  return {
    timeline: {
      clips: project.timeline.clips.map(
        ({ id, track_id, source_start, source_end, timeline_start }) => ({
          id,
          track_id,
          source_start,
          source_end,
          timeline_start,
        }),
      ),
    },
    chapters: project.editorial.chapters.map(({ time, title }) => ({
      time,
      title,
    })),
    pending: project.editorial.edit_decisions.map(
      ({ id, track_id, type, start, end, applied, review_required }) => ({
        id,
        track_id,
        type,
        start,
        end,
        applied,
        review_required,
      }),
    ),
    social: {
      clip_candidates: project.social.clip_candidates.map(
        ({ id, track_id, start, end, score, title_suggestion }) => ({
          id,
          track_id,
          start,
          end,
          score,
          title_suggestion,
        }),
      ),
    },
    history: fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown)
      : null,
  };
}
function factory(movable: boolean) {
  return (prefix: string) => {
    const fixture = createRelocatedE2eProject(prefix);
    const project = read(fixture.projectPath);
    const track = project.timeline.tracks[0].id;
    if (movable) {
      const clip = project.timeline.clips.find(
        (row) => row.track_id === track,
      )!;
      clip.id = "inventory-move";
      clip.source_start = 0;
      clip.source_end = 10;
      clip.timeline_start = 5;
    }
    project.editorial.chapters = [{ time: 12, title: "Inventory chapter" }];
    project.editorial.edit_decisions = movable
      ? []
      : [
          {
            id: "inventory-pending",
            track_id: track,
            type: "remove",
            start: 8,
            end: 24,
            applied: false,
            review_required: true,
          },
        ];
    project.social.clip_candidates = [
      {
        id: "inventory-social",
        track_id: track,
        start: 18,
        end: 24,
        score: 0.8,
        title_suggestion: "Inventory social",
      },
    ];
    fs.writeFileSync(
      fixture.projectPath,
      `${JSON.stringify(project, null, 2)}\n`,
    );
    return fixture;
  };
}
async function center(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("Audit target has no bounding box");
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    width: box.width,
  };
}
async function prepareMoveBody(page: Page, info: TestInfo, block: Locator) {
  await expect(block).toHaveCount(1);
  const fit = await drawn(block);
  let zoomSteps = 0;
  while ((await drawn(block)).width < 120 && zoomSteps < 12) {
    const width = (await drawn(block)).width;
    await page.getByRole("slider", { name: "Timeline position" }).focus();
    await page.keyboard.press("=");
    await expect
      .poll(async () => (await drawn(block)).width)
      .toBeGreaterThan(width);
    zoomSteps += 1;
  }
  await expect
    .poll(async () => (await drawn(block)).width)
    .toBeGreaterThanOrEqual(120);
  const hit = block.locator(".clip-hit");
  const point = await center(hit);
  const actualHit = await hit.evaluate((element, point) => {
    const actual = document.elementFromPoint(point.x, point.y);
    return {
      owned: actual === element || actual?.closest(".clip-hit") === element,
      hit: actual?.outerHTML,
      owner: element.outerHTML,
    };
  }, point);
  fs.writeFileSync(
    info.outputPath("clip-body-preparation.json"),
    `${JSON.stringify({ fit, prepared: await drawn(block), zoomSteps, zoomPxPerSec: (await drawn(block)).width / 10, zoomChanged: zoomSteps > 0, input: "native keyboard = with existing ruler focused", actualHit }, null, 2)}\n`,
  );
  expect(
    actualHit.owned,
    "native mouse start must hit clip body, without pending or edge overlay interception",
  ).toBe(true);
  return { point };
}
async function drawn(target: Locator) {
  return target.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      left: (element as HTMLElement).style.left,
    };
  });
}
async function evidence(
  page: Page,
  info: TestInfo,
  name: string,
  value: unknown,
) {
  fs.writeFileSync(
    info.outputPath(`${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}
async function audit(
  page: Page,
  info: TestInfo,
  profile: (typeof profiles)[number],
  movable: boolean,
  run: (projectPath: string, commands: Command[]) => Promise<void>,
) {
  await withShareableProject(
    async (projectPath) => {
      const commands: Command[] = [];
      const listener = (request: import("@playwright/test").Request) => {
        if (
          request.method() === "POST" &&
          request.url().includes("/api/document/command")
        )
          commands.push(request.postDataJSON() as Command);
      };
      page.on("request", listener);
      try {
        await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
        await expect(page.locator(".daw-shell")).toBeVisible();
        if (profile.width < 720) await openPhoneTimeline(page);
        await setTheme(page, profile.theme);
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          profile.theme,
        );
        await run(projectPath, commands);
      } finally {
        await evidence(page, info, "audit-final", {
          profile,
          ownerNative: true,
          syntheticForeign: false,
          physicalDevice: false,
          saved: saved(projectPath),
          commands,
        });
        page.off("request", listener);
      }
    },
    undefined,
    factory(movable),
  );
}
for (const profile of profiles) {
  test.describe(`878 supplemental ${profile.id}`, () => {
    test.use({
      viewport: { width: profile.width, height: profile.height },
      reducedMotion: profile.motion,
    });
    test("F01 native clip move previews reversal, commits once, and Undo restores origin", async ({
      page,
    }, info) => {
      await audit(page, info, profile, true, async (projectPath, commands) => {
        const block = page.locator(
          '[data-testid="timeline-clip"][data-clip-id="inventory-move"]',
        );
        const { point: start } = await prepareMoveBody(page, info, block);
        const before = saved(projectPath);
        const origin = await drawn(block);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 30, start.y, { steps: 6 });
        await expect
          .poll(async () => (await drawn(block)).x)
          .not.toBe(origin.x);
        const forward = await drawn(block);
        expect(saved(projectPath)).toEqual(before);
        await page.mouse.move(start.x + 16, start.y, { steps: 4 });
        await expect
          .poll(async () => (await drawn(block)).x)
          .toBeLessThan(forward.x);
        const preview = await drawn(block);
        expect(saved(projectPath)).toEqual(before);
        await evidence(page, info, "clip-preview", {
          origin,
          forward,
          preview,
          before,
        });
        await page.mouse.up();
        await expect
          .poll(() => commands.filter((c) => c.type === "MoveClips").length)
          .toBe(1);
        await expect
          .poll(
            () =>
              read(projectPath).timeline.clips.find(
                (c) => c.id === "inventory-move",
              )!.timeline_start,
          )
          .not.toBe(5);
        const after = read(projectPath).timeline.clips.find(
          (c) => c.id === "inventory-move",
        )!;
        expect(after.source_start).toBe(0);
        expect(after.source_end).toBe(10);
        await page.keyboard.press("ControlOrMeta+z");
        await expect
          .poll(
            () =>
              saved(projectPath).timeline.clips.find(
                (c) => c.id === "inventory-move",
              )!,
          )
          .toEqual(
            before.timeline.clips.find((c) => c.id === "inventory-move"),
          );
        const restored = await center(block.locator(".clip-hit"));
        await page.mouse.move(restored.x, restored.y);
        await page.mouse.down();
        await page.mouse.up();
        expect(commands.filter((c) => c.type === "MoveClips")).toHaveLength(1);
        expect(saved(projectPath).timeline.clips).toEqual(
          before.timeline.clips,
        );
      });
    });
    test("F01 native clip move Escape restores preview before later release", async ({
      page,
    }, info) => {
      await audit(page, info, profile, true, async (projectPath, commands) => {
        const block = page.locator(
          '[data-testid="timeline-clip"][data-clip-id="inventory-move"]',
        );
        const { point: start } = await prepareMoveBody(page, info, block);
        const before = saved(projectPath);
        const beforeSelection = await drawn(block);
        const keys: { key: string; trusted: boolean; prevented: boolean }[] =
          [];
        await page.exposeFunction(
          "recordClipRecovery",
          (event: (typeof keys)[number]) => keys.push(event),
        );
        await page.evaluate(() => {
          const report = (
            window as unknown as {
              recordClipRecovery: (event: {
                key: string;
                trusted: boolean;
                prevented: boolean;
              }) => Promise<void>;
            }
          ).recordClipRecovery;
          document.addEventListener(
            "keydown",
            (event) => {
              setTimeout(() => {
                void report({
                  key: event.key,
                  trusted: event.isTrusted,
                  prevented: event.defaultPrevented,
                });
              }, 0);
            },
            true,
          );
        });
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await expect(block).toHaveClass(/selected/);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        const origin = await drawn(block);
        await evidence(page, info, "clip-selected-layout", {
          beforeSelection,
          origin,
          saved: saved(projectPath),
          commands,
        });
        expect(saved(projectPath)).toEqual(before);
        expect(commands).toEqual([]);
        await page.mouse.move(start.x + 24, start.y, { steps: 5 });
        await expect
          .poll(async () => (await drawn(block)).x)
          .not.toBe(origin.x);
        await page.keyboard.press("Escape");
        await expect.poll(() => drawn(block)).toEqual(origin);
        await expect(page.locator(".clip-moving,.clip-move-ghost")).toHaveCount(
          0,
        );
        await page.mouse.move(start.x + 40, start.y);
        await expect.poll(() => drawn(block)).toEqual(origin);
        await page.mouse.up();
        expect(saved(projectPath)).toEqual(before);
        expect(commands).toEqual([]);
        expect(keys).toContainEqual({
          key: "Escape",
          trusted: true,
          prevented: true,
        });
        await evidence(page, info, "clip-cancel-layout", {
          beforeSelection,
          origin,
          canceled: await drawn(block),
          keys,
          saved: saved(projectPath),
          commands,
        });
      });
    });
    test("F10 native chapter and social body drag preview then one commit and Undo", async ({
      page,
    }, info) => {
      await audit(page, info, profile, false, async (projectPath, commands) => {
        for (const item of [
          {
            label: "Chapter Inventory chapter",
            type: "UpdateChapter",
            social: false,
          },
          { label: "Inventory social", type: "UpdateSocialClip", social: true },
        ]) {
          const target = page.getByRole("button", {
            name: item.label,
            exact: true,
          });
          await expect(target).toBeVisible();
          const before = saved(projectPath);
          const tap = await center(target);
          const beforeTap = await drawn(target);
          const count = commands.filter((c) => c.type === item.type).length;
          await page.mouse.move(tap.x, tap.y);
          await page.mouse.down();
          await page.mouse.up();
          expect(saved(projectPath)).toEqual(before);
          expect(commands.filter((c) => c.type === item.type)).toHaveLength(
            count,
          );
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          const start = await center(target);
          const origin = await drawn(target);
          const hit = await target.evaluate(
            (element, point) => ({
              owned: element.contains(
                document.elementFromPoint(point.x, point.y),
              ),
              hit: document.elementFromPoint(point.x, point.y)?.outerHTML,
            }),
            start,
          );
          expect(hit.owned).toBe(true);
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          const owner = await target.evaluate((element) => {
            for (let id = 1; id < 32; id++)
              if (element.hasPointerCapture(id)) return id;
            return null;
          });
          expect(owner).not.toBeNull();
          await page.mouse.move(start.x + 26, start.y, { steps: 5 });
          await expect
            .poll(async () => (await drawn(target)).x)
            .not.toBe(origin.x);
          const forward = await drawn(target);
          expect(saved(projectPath)).toEqual(before);
          await page.mouse.move(start.x + 14, start.y, { steps: 4 });
          await expect
            .poll(async () => (await drawn(target)).x)
            .toBeLessThan(forward.x);
          await evidence(page, info, item.type, {
            beforeTap,
            hit,
            owner,
            origin,
            forward,
            before,
            preview: await drawn(target),
          });
          await page.mouse.up();
          await expect
            .poll(() => commands.filter((c) => c.type === item.type).length)
            .toBe(count + 1);
          await expect
            .poll(() =>
              item.social
                ? saved(projectPath).social
                : saved(projectPath).chapters,
            )
            .not.toEqual(item.social ? before.social : before.chapters);
          await page.keyboard.press("ControlOrMeta+z");
          await expect
            .poll(() =>
              item.social
                ? saved(projectPath).social
                : saved(projectPath).chapters,
            )
            .toEqual(item.social ? before.social : before.chapters);
        }
      });
    });
    test("F10 native chapter and social Escape cancel held movement and release", async ({
      page,
    }, info) => {
      await audit(page, info, profile, false, async (projectPath, commands) => {
        for (const label of ["Chapter Inventory chapter", "Inventory social"]) {
          const target = page.getByRole("button", { name: label, exact: true });
          const start = await center(target);
          const origin = await drawn(target);
          const before = saved(projectPath);
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(start.x + 20, start.y, { steps: 5 });
          await expect
            .poll(async () => (await drawn(target)).x)
            .not.toBe(origin.x);
          await page.keyboard.press("Escape");
          await expect.poll(() => drawn(target)).toEqual(origin);
          await page.mouse.move(start.x + 40, start.y);
          await expect.poll(() => drawn(target)).toEqual(origin);
          await page.mouse.up();
          expect(saved(projectPath)).toEqual(before);
          expect(commands).toEqual([]);
        }
      });
    });
    test("F10 exposed pending drag or constrained exact timing restores with Undo", async ({
      page,
    }, info) => {
      await audit(page, info, profile, false, async (projectPath, commands) => {
        const region = page.locator(
          '.pending-overlay[data-pending-id="inventory-pending"]',
        );
        await region.locator(".pending-hit").click();
        const handle = region.locator(".pending-handle.end");
        const handleCount = await handle.count();
        const handleHit =
          handleCount > 0
            ? await handle.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  rect.x + rect.width / 2,
                  rect.y + rect.height / 2,
                );
                return {
                  owned: element.contains(hit),
                  hit: hit?.outerHTML,
                  rect: rect.toJSON(),
                };
              })
            : null;
        if (!handleHit?.owned) {
          if (handleCount === 0)
            await region
              .getByRole("button", { name: "Edit timing", exact: true })
              .click();
          const before = saved(projectPath);
          const end = page.getByLabel("Source end", { exact: true });
          await expect(end).toBeVisible();
          await page
            .getByRole("checkbox", { name: "Snap to silence", exact: true })
            .uncheck();
          await end.fill("25");
          expect(saved(projectPath)).toEqual(before);
          expect(commands).toEqual([]);
          await page
            .getByRole("button", { name: "Apply timing", exact: true })
            .click();
          await expect
            .poll(
              () =>
                commands.filter((c) => c.type === "UpdatePendingEdit").length,
            )
            .toBe(1);
          await expect.poll(() => saved(projectPath).pending[0].end).toBe(25);
          expect(saved(projectPath).pending[0].start).toBe(8);
          await page.keyboard.press("ControlOrMeta+z");
          await expect
            .poll(() => saved(projectPath).pending)
            .toEqual(before.pending);
          await evidence(page, info, "pending-numeric-alternative", {
            draggable: false,
            reason:
              handleCount === 0
                ? "Current dense geometry exposes Edit timing"
                : "Inspector covers the inline handle center",
            handleHit,
            before,
            restored: saved(projectPath).pending,
            commands,
          });
          return;
        }
        const start = await center(handle);
        const origin = await drawn(region);
        const before = saved(projectPath);
        await handle.focus();
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 12, start.y, { steps: 4 });
        await expect
          .poll(async () => (await drawn(region)).width)
          .not.toBe(origin.width);
        expect(saved(projectPath)).toEqual(before);
        await page.keyboard.press("Escape");
        await expect
          .poll(async () => (await drawn(region)).width)
          .toBe(origin.width);
        await page.mouse.up();
        expect(saved(projectPath)).toEqual(before);
        expect(
          commands.filter((c) => c.type === "UpdatePendingEdit"),
        ).toHaveLength(0);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 18, start.y, { steps: 4 });
        await expect
          .poll(async () => (await drawn(region)).width)
          .not.toBe(origin.width);
        const forward = await drawn(region);
        await page.mouse.move(start.x + 12, start.y, { steps: 3 });
        await expect
          .poll(async () => (await drawn(region)).width)
          .toBeLessThan(forward.width);
        expect(saved(projectPath)).toEqual(before);
        await evidence(page, info, "pending-edge-preview", {
          origin,
          forward,
          preview: await drawn(region),
          before,
        });
        await page.mouse.up();
        await expect
          .poll(
            () => commands.filter((c) => c.type === "UpdatePendingEdit").length,
          )
          .toBe(1);
        await expect
          .poll(() => saved(projectPath).pending)
          .not.toEqual(before.pending);
        expect(saved(projectPath).pending[0].start).toBe(8);
        await page.keyboard.press("ControlOrMeta+z");
        await expect
          .poll(() => saved(projectPath).pending)
          .toEqual(before.pending);
      });
    });
    test("F06 native passage drag and Shift click select literal word endpoints without writes", async ({
      page,
    }, info) => {
      await audit(page, info, profile, false, async (projectPath, commands) => {
        if (profile.width < 720)
          await page
            .getByRole("navigation", { name: "Primary" })
            .getByRole("button", { name: "Text", exact: true })
            .click();
        else
          await page
            .getByLabel("Editor panels")
            .getByRole("button", { name: "Transcript", exact: true })
            .click();
        await expect(
          page.getByRole("button", { name: /^Correct:/ }),
        ).toBeEnabled();
        await page.getByRole("button", { name: /^Select:/ }).click();
        const words = page.locator(
          '.transcript-list button[data-transcript-word][data-track-id="reference"]',
        );
        const first = words.nth(0),
          third = words.nth(2);
        const a = await center(first),
          b = await center(third);
        const before = saved(projectPath);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 8 });
        await page.mouse.up();
        await expect(first).toHaveClass(/selected/);
        await expect(words.nth(1)).toHaveClass(/selected/);
        await expect(third).toHaveClass(/selected/);
        await expect(words.nth(3)).not.toHaveClass(/selected/);
        expect(saved(projectPath)).toEqual(before);
        expect(commands).toHaveLength(0);
        await evidence(page, info, "passage-native", {
          first: await first.getAttribute("data-word-index"),
          third: await third.getAttribute("data-word-index"),
          before,
        });
        await first.click();
        await third.click({ modifiers: ["Shift"] });
        await expect(first).toHaveClass(/selected/);
        await expect(words.nth(1)).toHaveClass(/selected/);
        await expect(third).toHaveClass(/selected/);
        await expect(words.nth(3)).not.toHaveClass(/selected/);
        expect(saved(projectPath)).toEqual(before);
        expect(commands).toHaveLength(0);
        await page.keyboard.press("Escape");
        await expect(first).not.toHaveClass(/selected/);
        expect(saved(projectPath)).toEqual(before);
      });
    });
  });
}

test("F10 native fractional chapter preview cancels to exact assigned CSS", async ({
  page,
}, info) => {
  await audit(page, info, profiles[0], false, async (projectPath, commands) => {
    const zoom = await zoomTimelineIn(page, { maxSteps: 2 });
    const target = page.getByRole("button", {
      name: "Chapter Inventory chapter",
      exact: true,
    });
    const origin = await drawn(target);
    expect(Number.parseFloat(origin.left) % 1).not.toBe(0);
    const start = await center(target);
    const hit = await target.evaluate(
      (element, point) =>
        element.contains(document.elementFromPoint(point.x, point.y)),
      start,
    );
    expect(hit).toBe(true);
    const before = saved(projectPath);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 23, start.y, { steps: 5 });
    await expect
      .poll(async () => (await drawn(target)).left)
      .not.toBe(origin.left);
    const preview = await drawn(target);
    await page.keyboard.press("Escape");
    await expect.poll(() => drawn(target)).toEqual(origin);
    await page.mouse.move(start.x + 37, start.y);
    await expect.poll(() => drawn(target)).toEqual(origin);
    await page.mouse.up();
    expect(saved(projectPath)).toEqual(before);
    expect(commands).toEqual([]);
    await evidence(page, info, "fractional-chapter-cancel", {
      zoom,
      origin,
      preview,
      restored: await drawn(target),
      hit,
      commands,
    });
  });
});
