import fs from "node:fs";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setTheme } from "./theme";
export type Clip = {
  id: string;
  track_id: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
  mute_regions?: unknown[];
  fade_in_ms?: number;
  fade_out_ms?: number;
};
export type Project = {
  timeline: { tracks: { id: string }[]; clips: Clip[] };
  editorial: { chapters: { time: number; title: string }[] };
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
  mix: {
    automation_envelopes: {
      track_id: string;
      parameter: string;
      points: { id: string; time: number; value: number }[];
    }[];
  };
  transcripts: unknown;
  review?: { comments: unknown[] };
};
export type Command = {
  type: string;
  payload: unknown;
  command_id?: string;
  client_id?: string;
  client_seq?: number;
};
export const read = (p: string): Project =>
  JSON.parse(fs.readFileSync(p, "utf8")) as Project;
export function snapshot(p: string) {
  const d = read(p),
    h = path.join(path.dirname(p), "history", "index.json");
  return {
    clips: d.timeline.clips.map(
      ({
        id,
        track_id,
        source_start,
        source_end,
        timeline_start,
        mute_regions,
        fade_in_ms,
        fade_out_ms,
      }) => ({
        id,
        track_id,
        source_start,
        source_end,
        timeline_start,
        mute_regions: mute_regions ?? [],
        fade_in_ms: fade_in_ms ?? 0,
        fade_out_ms: fade_out_ms ?? 0,
      }),
    ),
    chapters: d.editorial.chapters.map(({ time, title }) => ({ time, title })),
    social: d.social.clip_candidates.map(({ id, track_id, start, end }) => ({
      id,
      track_id,
      start,
      end,
    })),
    envelopes: d.mix.automation_envelopes,
    comments: d.review?.comments ?? [],
    transcripts: JSON.parse(
      JSON.stringify(d.transcripts, (_k, v) =>
        v === null || v === false ? undefined : v,
      ),
    ) as unknown,
    history: fs.existsSync(h)
      ? (JSON.parse(fs.readFileSync(h, "utf8")) as {
          cursor: number;
          entries: { operation: string | null }[];
        })
      : null,
  };
}
export function seed(move = false) {
  return (prefix: string) => {
    const f = createRelocatedE2eProject(prefix),
      d = read(f.projectPath),
      track = d.timeline.tracks[0].id;
    if (move) {
      const c = d.timeline.clips.find((c) => c.track_id === track)!;
      c.id = "lifecycle-move";
      c.source_start = 0;
      c.source_end = 10;
      c.timeline_start = 5;
    }
    d.editorial.chapters = [{ time: 12, title: "Lifecycle chapter" }];
    d.social.clip_candidates = [
      {
        id: "lifecycle-social",
        track_id: track,
        start: 18,
        end: 24,
        score: 0.8,
        title_suggestion: "Lifecycle social",
      },
    ];
    d.mix.automation_envelopes = [
      {
        track_id: track,
        parameter: "volume",
        points: [
          { id: "life-first", time: 2, value: 0.8 },
          { id: "life-second", time: 10, value: 1.2 },
        ],
      },
    ];
    if (move) d.mix.automation_envelopes = [];
    fs.writeFileSync(f.projectPath, `${JSON.stringify(d, null, 2)}\n`);
    return f;
  };
}
export async function draw(t: Locator) {
  return t.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}
export async function hit(
  t: Locator,
  where: "center" | "start" | "end" | "offcenter" = "center",
) {
  await t.scrollIntoViewIfNeeded();
  const b = await draw(t);
  const p = {
    x:
      b.x +
      (where === "start"
        ? 2
        : where === "end"
          ? b.width - 2
          : where === "offcenter"
            ? b.width * 0.35
            : b.width / 2),
    y: b.y + b.height / 2,
  };
  const check = await t.evaluate((owner, p) => {
    const actual = document.elementFromPoint(p.x, p.y);
    return {
      owned: actual === owner || (actual !== null && owner.contains(actual)),
      actual: actual?.outerHTML,
    };
  }, p);
  expect(
    check.owned,
    `Preparation must hit ${await t.getAttribute("class")}; actual ${check.actual}`,
  ).toBe(true);
  return p;
}
export async function begin(
  page: Page,
  t: Locator,
  dx = 20,
  where: "center" | "start" | "end" | "offcenter" = "center",
) {
  await t.focus();
  const p = await hit(t, where);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx, p.y, { steps: 4 });
  return p;
}
export async function captureOwner(t: Locator) {
  const id = await t.evaluate((e) => {
    for (let i = 1; i < 32; i++) if (e.hasPointerCapture(i)) return i;
    return null;
  });
  expect(
    id,
    "Interruption requires an actually captured native owner",
  ).not.toBeNull();
  return id!;
}
export async function interrupt(
  page: Page,
  t: Locator,
  kind: "escape" | "loss" | "cancel",
  p: { x: number; y: number },
  release = true,
) {
  if (kind === "escape") await page.keyboard.press("Escape");
  else {
    const owner = await captureOwner(t);
    if (kind === "loss")
      await t.evaluate((e, id) => e.releasePointerCapture(id), owner);
    else
      await t.dispatchEvent("pointercancel", {
        pointerId: owner,
        pointerType: "mouse",
        bubbles: true,
      });
  }
  await page.mouse.move(p.x + 32, p.y);
  if (release) await page.mouse.up();
}
export async function layer(page: Page, label: string, checked: boolean) {
  await page.keyboard.press("Tab");
  const view = page.getByRole("button", { name: "View", exact: true });
  if (await view.isVisible()) await view.click();
  else await page.getByRole("button", { name: "Menu", exact: true }).click();
  const toggle = page.getByRole("menuitemcheckbox", {
    name: label,
    exact: true,
  });
  if (checked) await toggle.check();
  else await toggle.uncheck();
  await page.keyboard.press("Escape");
}
export async function record(
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
export async function runAudit(
  page: Page,
  info: TestInfo,
  move: boolean,
  body: (p: string, c: Command[]) => Promise<void>,
) {
  await withShareableProject(
    async (p) => {
      const commands: Command[] = [];
      const events: { type: string; trusted: boolean; id?: number }[] = [];
      const listener = (r: import("@playwright/test").Request) => {
        if (r.method() === "POST" && r.url().includes("/api/document/command"))
          commands.push(r.postDataJSON() as Command);
      };
      page.on("request", listener);
      await openHostShare(page, p);
      await setTheme(page, "light");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.exposeFunction(
        "lifecycleEvent",
        (event: { type: string; trusted: boolean; id?: number }) =>
          events.push(event),
      );
      await page.evaluate(() => {
        for (const type of [
          "pointerdown",
          "pointerup",
          "pointercancel",
          "lostpointercapture",
        ])
          document.addEventListener(
            type,
            (e) => {
              void (
                window as unknown as {
                  lifecycleEvent: (v: unknown) => Promise<void>;
                }
              ).lifecycleEvent({
                type: e.type,
                trusted: e.isTrusted,
                id: (e as PointerEvent).pointerId,
              });
            },
            true,
          );
      });
      try {
        await body(p, commands);
      } finally {
        await record(page, info, "lifecycle-final", {
          viewport: page.viewportSize(),
          theme: "light",
          motion: "reduce",
          permission: "host",
          physicalDevice: false,
          events,
          commands,
          saved: snapshot(p),
        });
        page.off("request", listener);
      }
    },
    undefined,
    seed(move),
  );
}
