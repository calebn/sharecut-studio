import fs from "node:fs";
import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { test } from "./interactionEvidence";
import { type Command, read, snapshot } from "./lifecycleAudit";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { armRange } from "./stageNav";
import { setTheme } from "./theme";

async function rulerScale(ruler: Locator) {
  const ticks = await ruler.locator(".ruler-tick").evaluateAll((elements) =>
    elements.map((element) => {
      const clock = element.textContent!.split(":").map(Number);
      return {
        seconds: clock.reduce((seconds, part) => seconds * 60 + part, 0),
        left: Number.parseFloat((element as HTMLElement).style.left),
      };
    }),
  );
  const tick = ticks.find((tick) => tick.seconds > 0 && tick.left > 0);
  expect(
    tick,
    "Preparation requires a literal nonzero ruler tick",
  ).toBeDefined();
  return { ticks, pxPerSecond: tick!.left / tick!.seconds };
}

test("ruler End then ArrowRight stays inside its declared session endpoint", {
  annotation: { type: "878-cell", description: "F03-key-bounds" },
}, async ({ page, receipts }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await withShareableProject(async (projectPath) => {
    await openHostShare(page, projectPath);
    await setTheme(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const ruler = page.getByRole("slider", { name: "Timeline position" });
    await ruler.focus();
    for (let index = 0; index < 5; index++) await page.keyboard.press("-");
    const scale = await rulerScale(ruler);
    const sessionEnd = Number(await ruler.getAttribute("aria-valuemax"));
    expect(sessionEnd).toBe(60);
    const before = snapshot(projectPath);
    const observer = rulerCommands(page, projectPath, receipts),
      commands = observer.commands;
    try {
      await page.keyboard.press("End");
      await expect(ruler).toHaveAttribute("aria-valuenow", "60");
      await page.keyboard.press("ArrowRight");
      receipts.push({
        checkpoint: "ruler-end-right",
        observation: {
          scale,
          sessionEnd,
          value: await ruler.getAttribute("aria-valuenow"),
          saved: snapshot(projectPath),
          commands,
          input: "native-keyboard",
        },
      });
      await expect(ruler).toHaveAttribute("aria-valuenow", "60");
      expect(snapshot(projectPath)).toEqual(before);
      expect(commands).toEqual([]);
      await page.keyboard.press("Home");
      await expect(ruler).toHaveAttribute("aria-valuenow", "0");
      await page.keyboard.press("ArrowLeft");
      await expect(ruler).toHaveAttribute("aria-valuenow", "0");
      const majorStep = scale.ticks[1].seconds - scale.ticks[0].seconds;
      expect(majorStep).toBeGreaterThan(0);
      await page.keyboard.press("ArrowRight");
      await expect(ruler).toHaveAttribute(
        "aria-valuenow",
        String(Math.min(60, majorStep)),
      );
      await page.keyboard.press("ArrowLeft");
      await expect(ruler).toHaveAttribute("aria-valuenow", "0");
      expect(snapshot(projectPath)).toEqual(before);
      expect(commands).toEqual([]);
      receipts.push({
        checkpoint: "ruler-key-bounds",
        observation: {
          majorStep,
          scale,
          sessionEnd,
          saved: snapshot(projectPath),
          commands,
        },
      });
    } finally {
      await observer.retain(before);
    }
  });
});

async function openModes(page: Page, projectPath: string, phone = false) {
  await page.setViewportSize(
    phone ? { width: 375, height: 812 } : { width: 1440, height: 900 },
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openHostShare(page, projectPath);
  if (phone) await openPhoneTimeline(page);
  await setTheme(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
}

async function timePoint(ruler: Locator, seconds: number) {
  const scale = await rulerScale(ruler);
  const rect = await ruler.boundingBox();
  expect(rect).not.toBeNull();
  const point = {
    x: rect!.x + seconds * scale.pxPerSecond,
    y: rect!.y + rect!.height / 2,
  };
  expect(
    await ruler.evaluate((element, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      return hit === element || (hit !== null && element.contains(hit));
    }, point),
    "Requested time must be exposed on the ruler",
  ).toBe(true);
  return { ...point, scale };
}

function rulerCommands(
  page: Page,
  projectPath: string,
  receipts: { checkpoint: string; observation: object }[],
) {
  const originFullDomain = rangeDomain(projectPath);
  const commands: Command[] = [];
  const replies: {
    command: Command;
    status: number;
    bodyState: string;
    body?: unknown;
    error?: string;
  }[] = [];
  const matches = (request: Request) =>
    request.method() === "POST" &&
    request.url().includes("/api/document/command");
  const listener = (request: Request) => {
    if (matches(request)) commands.push(request.postDataJSON() as Command);
  };
  const responseListener = (response: Response) => {
    if (!matches(response.request())) return;
    const reply: (typeof replies)[number] = {
      command: response.request().postDataJSON() as Command,
      status: response.status(),
      bodyState: "pending",
    };
    replies.push(reply);
    void response.json().then(
      (body) => {
        reply.body = body;
        reply.bodyState = "read";
      },
      (error) => {
        reply.error = error instanceof Error ? error.message : String(error);
        reply.bodyState = "failed";
      },
    );
  };
  page.on("request", listener);
  page.on("response", responseListener);
  return {
    commands,
    async retain(before: ReturnType<typeof snapshot>) {
      page.off("request", listener);
      page.off("response", responseListener);
      const observations = await Promise.allSettled([
        Promise.resolve().then(() => snapshot(projectPath)),
        Promise.resolve().then(() => rangeDomain(projectPath)),
        page.evaluate(() => ({
          hint: document
            .querySelector(".time-ruler")
            ?.getAttribute("aria-valuetext"),
          range: document
            .querySelector(".range-overlay[data-range-start]")
            ?.getAttribute("data-range-start"),
          ruler: document
            .querySelector(".time-ruler")
            ?.getAttribute("aria-valuenow"),
          scroll: document.querySelector(".timeline-scroll")?.scrollLeft,
        })),
      ]);
      receipts.push({
        checkpoint: "ruler-terminal-evidence",
        observation: {
          before,
          originFullDomain,
          commands,
          replies,
          observations: observations.map((result) =>
            result.status === "fulfilled"
              ? { status: result.status, value: result.value }
              : {
                  status: result.status,
                  error:
                    result.reason instanceof Error
                      ? result.reason.message
                      : String(result.reason),
                },
          ),
        },
      });
    },
  };
}

async function acceptedCommand(
  page: Page,
  type: string,
  action: () => Promise<unknown>,
) {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/document/command") &&
      (response.request().postDataJSON() as Command).type === type,
    { timeout: 5000 },
  );
  const [, response] = await Promise.all([action(), pending]);
  expect(response.status()).toBe(200);
  const command = response.request().postDataJSON() as Command;
  expect(command.command_id).toEqual(expect.any(String));
  expect(command.command_id!.length).toBeGreaterThan(0);
  expect(command.client_id).toEqual(expect.any(String));
  expect(command.client_id!.length).toBeGreaterThan(0);
  expect(Number.isInteger(command.client_seq)).toBe(true);
  const reply: unknown = await response.json();
  expect(reply).toMatchObject({
    ok: true,
    type: "Applied",
    command: {
      type,
      command_id: command.command_id,
      client_id: command.client_id,
      client_seq: command.client_seq,
    },
  });
  return { command, reply, status: response.status() };
}

function rangeDomain(projectPath: string) {
  const data = read(projectPath),
    { history: _history, ...domain } = snapshot(projectPath);
  return {
    ...domain,
    clips: data.timeline.clips,
    chapters: data.editorial.chapters,
    social: data.social.clip_candidates,
    envelopes: data.mix.automation_envelopes,
  };
}

async function zoomForScroll(page: Page, ruler: Locator) {
  await ruler.focus();
  for (let index = 0; index < 5; index++) await page.keyboard.press("+");
  const scroll = page.locator(".timeline-scroll");
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeGreaterThan(300);
  return scroll;
}

test("ruler double click restores session fit and literal three-second hit mapping", {
  annotation: { type: "878-cell", description: "F03-double-fit" },
}, async ({ page, receipts }) => {
  await withShareableProject(async (projectPath) => {
    await openModes(page, projectPath);
    const ruler = page.getByRole("slider", { name: "Timeline position" });
    const fit = await rulerScale(ruler),
      before = snapshot(projectPath),
      observer = rulerCommands(page, projectPath, receipts);
    try {
      await zoomForScroll(page, ruler);
      const zoomed = await rulerScale(ruler);
      expect(zoomed.pxPerSecond).toBeGreaterThan(fit.pxPerSecond);
      const point = await timePoint(ruler, 3);
      await page.mouse.dblclick(point.x, point.y);
      await expect
        .poll(async () => (await rulerScale(ruler)).pxPerSecond)
        .toBeCloseTo(fit.pxPerSecond, 5);
      await expect
        .poll(() =>
          page
            .locator(".timeline-scroll")
            .evaluate((element) => element.scrollLeft),
        )
        .toBe(0);
      const after = await timePoint(ruler, 3);
      await page.mouse.click(after.x, after.y);
      await expect
        .poll(async () =>
          Math.abs(Number(await ruler.getAttribute("aria-valuenow")) - 3),
        )
        .toBeLessThanOrEqual(1 / fit.pxPerSecond);
      expect(snapshot(projectPath)).toEqual(before);
      expect(observer.commands).toEqual([]);
      receipts.push({
        checkpoint: "ruler-fit-literal-hit",
        observation: {
          fit,
          zoomed,
          after,
          before,
          commands: observer.commands,
        },
      });
    } finally {
      await observer.retain(before);
    }
  });
});

test("phone fixed playhead clock follows native horizontal scroll and exposed ruler click", {
  annotation: { type: "878-cell", description: "F03-phone-scroll" },
}, async ({ page, receipts }) => {
  await withShareableProject(async (projectPath) => {
    await openModes(page, projectPath, true);
    const ruler = page.getByRole("slider", { name: "Timeline position" }),
      scroll = page.locator(".timeline-scroll");
    const line = page.locator(".playhead--fixed");
    const lineX = async () => {
      const box = await line.boundingBox();
      expect(box).not.toBeNull();
      return box!.x + box!.width / 2;
    };
    const value = async () => Number(await ruler.getAttribute("aria-valuenow"));
    const clock = async () =>
      Number(
        (await page
          .locator(".stage-frame-player .sys-player-now")
          .textContent())!
          .split(":")
          .reduce((seconds, part) => seconds * 60 + Number(part), 0),
      );
    const before = snapshot(projectPath),
      observer = rulerCommands(page, projectPath, receipts);
    try {
      const origin = {
        x: await lineX(),
        value: await value(),
        scroll: await scroll.evaluate((element) => element.scrollLeft),
      };
      const box = await scroll.boundingBox();
      await page.mouse.move(box!.x + box!.width - 20, box!.y + 45);
      await page.mouse.wheel(160, 0);
      await expect.poll(value).toBeGreaterThan(origin.value);
      const advanced = {
        x: await lineX(),
        value: await value(),
        scroll: await scroll.evaluate((element) => element.scrollLeft),
      };
      expect(advanced.x).toBeCloseTo(origin.x, 1);
      expect(Math.abs((await clock()) - advanced.value)).toBeLessThanOrEqual(
        0.001,
      );
      await page.mouse.wheel(-160, 0);
      await expect.poll(value).toBeCloseTo(origin.value, 1);
      expect(await lineX()).toBeCloseTo(origin.x, 1);
      const rect = await ruler.boundingBox(),
        viewport = await scroll.boundingBox(),
        scale = await rulerScale(ruler);
      const x = Math.min(
        viewport!.x + viewport!.width - 20,
        rect!.x + rect!.width - 2,
      );
      const expected = (x - rect!.x) / scale.pxPerSecond;
      await page.mouse.click(x, rect!.y + rect!.height / 2);
      await expect
        .poll(async () => Math.abs((await value()) - expected))
        .toBeLessThanOrEqual(1 / scale.pxPerSecond);
      // A seek brings the playhead to the center (or leaves it left of center
      // near the start), inside the time viewport, never past it.
      const afterSeek = await lineX();
      expect(afterSeek).toBeGreaterThanOrEqual(origin.x - 1);
      expect(afterSeek).toBeLessThanOrEqual(viewport!.x + viewport!.width);
      expect(Math.abs((await clock()) - (await value()))).toBeLessThanOrEqual(
        0.001,
      );
      expect(snapshot(projectPath)).toEqual(before);
      expect(observer.commands).toEqual([]);
      receipts.push({
        checkpoint: "phone-ruler-clock-scroll",
        observation: {
          origin,
          advanced,
          expected,
          value: await value(),
          before,
          commands: observer.commands,
          input: "native mouse wheel/click; not physical touch",
        },
      });
    } finally {
      await observer.retain(before);
    }
  });
});

function emptyModesFixture(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix),
    data = read(fixture.projectPath);
  for (const clip of data.timeline.clips) {
    clip.source_start = 0;
    clip.source_end = 8;
    clip.timeline_start = 0;
  }
  const tail = {
    ...data.timeline.clips[0],
    id: "range-session-tail",
    track_id: "guest",
    source_start: 50,
    source_end: 60,
    timeline_start: 50,
  };
  data.timeline.clips.push(tail);
  data.mix.automation_envelopes = [];
  const editable = data as typeof data & {
    editorial: { edit_decisions: unknown[] };
  };
  editable.editorial.edit_decisions = [];
  fs.writeFileSync(fixture.projectPath, `${JSON.stringify(data, null, 2)}\n`);
  return fixture;
}

async function emptyLanePoint(page: Page, track: string, seconds: number) {
  const ruler = page.getByRole("slider", { name: "Timeline position" });
  const point = await timePoint(ruler, seconds);
  const lane = page.locator(`.lane-row[data-track-id="${track}"]`);
  const rect = await lane.boundingBox();
  expect(rect).not.toBeNull();
  const target = { x: point.x, y: rect!.y + rect!.height / 2 };
  const hit = await page.evaluate(
    (p) => document.elementFromPoint(p.x, p.y)?.className,
    target,
  );
  expect(
    hit,
    "Empty range starts must hit exposed lane-seek, not old overlay",
  ).toBe("lane-seek");
  return { ...target, scale: point.scale };
}

async function rangeBounds(page: Page) {
  const overlay = page.locator(".range-overlay[data-range-start]").first();
  await expect(overlay).toBeAttached();
  const start = Number(await overlay.getAttribute("data-range-start"));
  const end = Number(await overlay.getAttribute("data-range-end"));
  return { start, end, summary: `${start}–${end} s` };
}

test("exposed empty-lane range spans two lanes and reverses both axes without editing", {
  annotation: { type: "878-cell", description: "F05-empty-multilane-reverse" },
}, async ({ page, receipts }) => {
  await withShareableProject(
    async (projectPath) => {
      await openModes(page, projectPath);
      const before = snapshot(projectPath),
        observer = rulerCommands(page, projectPath, receipts);
      const native = await page.evaluateHandle(() => {
        const downs: {
          pointerId: number;
          trusted: boolean;
          x: number;
          y: number;
        }[] = [];
        const listener = (event: PointerEvent) =>
          downs.push({
            pointerId: event.pointerId,
            trusted: event.isTrusted,
            x: event.clientX,
            y: event.clientY,
          });
        document.addEventListener("pointerdown", listener, true);
        return {
          downs,
          dispose: () =>
            document.removeEventListener("pointerdown", listener, true),
        };
      });
      try {
        const lanes = () =>
          page.locator(".lane-row").evaluateAll((elements) =>
            elements.map((element) => ({
              track: element.getAttribute("data-track-id"),
              rect: element.getBoundingClientRect().toJSON(),
            })),
          );
        const originalLanes = await lanes();
        const start = await emptyLanePoint(page, "reference", 15.2),
          originalEnd = await emptyLanePoint(page, "guest", 20.2);
        const startHit = await page.evaluate((point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return {
            className: hit?.className,
            track: hit?.closest(".lane-row")?.getAttribute("data-track-id"),
          };
        }, start);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const down = await native.evaluate((state) => state.downs.at(-1));
        expect(down?.trusted).toBe(true);
        const ownership = () =>
          page.evaluate(
            (pointerId) =>
              [...document.querySelectorAll("*")]
                .filter((element) => element.hasPointerCapture(pointerId!))
                .map((element) => ({
                  className: element.className,
                  rect: element.getBoundingClientRect().toJSON(),
                })),
            down?.pointerId,
          );
        const initialCapture = await ownership();
        receipts.push({
          checkpoint: "empty-range-native-down",
          observation: {
            originalLanes,
            start,
            startHit,
            originalEnd,
            down,
            initialCapture,
          },
        });
        expect(initialCapture).toHaveLength(1);
        await page.mouse.move(start.x + 6, start.y);
        await expect(
          page.getByRole("group", { name: "Selection actions" }),
        ).toBeVisible();
        const previewLanes = await lanes();
        const oldEndpointHit = await page.evaluate((point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return {
            className: hit?.className,
            track: hit?.closest(".lane-row")?.getAttribute("data-track-id"),
          };
        }, originalEnd);
        const toolbar = await page
          .getByRole("group", { name: "Selection actions" })
          .boundingBox();
        receipts.push({
          checkpoint: "range-toolbar-insertion",
          observation: {
            originalLanes,
            previewLanes,
            originalEnd,
            oldEndpointHit,
            toolbar,
            down,
            laneShifts: previewLanes.map((lane) => ({
              track: lane.track,
              deltaY:
                lane.rect.y -
                originalLanes.find((prior) => prior.track === lane.track)!.rect
                  .y,
            })),
            initialCapture,
            previewCapture: await ownership(),
          },
        });
        const end = await emptyLanePoint(page, "guest", 20.2);
        receipts.push({
          checkpoint: "empty-range-current-guest-target",
          observation: {
            end,
            lanes: await lanes(),
            capture: await ownership(),
          },
        });
        await page.mouse.move(end.x, end.y, { steps: 6 });
        expect(await ownership()).toHaveLength(1);
        // Every dialogue track is in the range: the scope chip says "All".
        await expect(
          page.getByRole("group", { name: "Selection actions" }),
        ).toContainText("All");
        const forward = await rangeBounds(page);
        expect(Math.abs(forward.start - 15.2)).toBeLessThanOrEqual(
          1 / start.scale.pxPerSecond + 0.01,
        );
        expect(Math.abs(forward.end - 20.2)).toBeLessThanOrEqual(
          1 / start.scale.pxPerSecond + 0.01,
        );
        const reverse = await emptyLanePoint(page, "reference", 10.2);
        await page.mouse.move(reverse.x, reverse.y, { steps: 6 });
        await expect(
          page.getByRole("group", { name: "Selection actions" }),
        ).not.toContainText("guest");
        const reversed = await rangeBounds(page);
        expect(Math.abs(reversed.start - 10.2)).toBeLessThanOrEqual(
          1 / start.scale.pxPerSecond + 0.01,
        );
        expect(Math.abs(reversed.end - 15.2)).toBeLessThanOrEqual(
          1 / start.scale.pxPerSecond + 0.01,
        );
        await expect(
          page.locator('.lane-row[data-track-id="reference"] .range-overlay'),
        ).toHaveCount(1);
        await expect(
          page.locator('.lane-row[data-track-id="guest"] .range-overlay'),
        ).toHaveCount(0);
        await page.mouse.up();
        expect(await ownership()).toEqual([]);
        expect(await rangeBounds(page)).toEqual(reversed);
        expect(snapshot(projectPath)).toEqual(before);
        expect(observer.commands).toEqual([]);
        receipts.push({
          checkpoint: "empty-range-multilane-reverse",
          observation: {
            start,
            end,
            reverse,
            forward,
            reversed,
            before,
            commands: observer.commands,
          },
        });
      } finally {
        await native
          .evaluate((state) => state.dispose())
          .catch(() => undefined);
        await native.dispose().catch(() => undefined);
        await observer.retain(before);
      }
    },
    undefined,
    emptyModesFixture,
  );
});

test("numeric range refuses invalid bounds and maps chosen lanes to one Mute and Undo", {
  annotation: { type: "878-cell", description: "F05-numeric-lanes" },
}, async ({ page, receipts }) => {
  await withShareableProject(
    async (projectPath) => {
      await openModes(page, projectPath);
      const before = snapshot(projectPath),
        beforeFullDomain = rangeDomain(projectPath),
        beforeTrackOrder = read(projectPath).timeline.tracks.map(
          (track) => track.id,
        ),
        observer = rulerCommands(page, projectPath, receipts);
      const keyedDomain = (domain: typeof beforeFullDomain) => {
        const ids = domain.clips.map((clip) => clip.id);
        expect(new Set(ids).size).toBe(ids.length);
        return {
          ...domain,
          clips: Object.fromEntries(
            domain.clips.map((clip) => [clip.id, clip]),
          ),
        };
      };
      try {
        await armRange(page);
        const range = page.getByRole("region", { name: "Range fields" });
        await range
          .getByRole("spinbutton", { name: "In", exact: true })
          .fill("");
        await range
          .getByRole("button", { name: "Select range", exact: true })
          .click();
        await expect(range).toContainText("Enter an In and Out time");
        await range
          .getByRole("spinbutton", { name: "In", exact: true })
          .fill("12");
        await range
          .getByRole("spinbutton", { name: "Out", exact: true })
          .fill("11");
        await range
          .getByRole("button", { name: "Select range", exact: true })
          .click();
        await expect(range).toContainText(
          "Enter an In before Out and choose at least one track",
        );
        expect(snapshot(projectPath)).toEqual(before);
        expect(observer.commands).toEqual([]);
        await range
          .getByRole("spinbutton", { name: "In", exact: true })
          .fill("2");
        await range
          .getByRole("spinbutton", { name: "Out", exact: true })
          .fill("3");
        await range
          .getByRole("checkbox", { name: "reference", exact: true })
          .check();
        await range
          .getByRole("checkbox", { name: "guest", exact: true })
          .uncheck();
        await range
          .getByRole("button", { name: "Select range", exact: true })
          .click();
        expect(await rangeBounds(page)).toMatchObject({ start: 2, end: 3 });
        await expect(
          page.locator('.lane-row[data-track-id="reference"] .range-overlay'),
        ).toHaveCount(1);
        await expect(
          page.locator('.lane-row[data-track-id="guest"] .range-overlay'),
        ).toHaveCount(0);
        expect(snapshot(projectPath)).toEqual(before);
        const accepted = await acceptedCommand(page, "EditSelectedRange", () =>
          (async () => {
            await page
              .getByRole("group", { name: "Selection actions" })
              .getByRole("button", { name: "More" })
              .click();
            await page
              .getByRole("menuitem", { name: "Mute", exact: true })
              .click();
          })(),
        );
        await expect
          .poll(
            () =>
              snapshot(projectPath).clips.find(
                (clip) => clip.track_id === "reference",
              )?.mute_regions,
          )
          .toEqual([
            {
              start_s: 2,
              end_s: 3,
              fade_in_ms: 5,
              fade_out_ms: 5,
              fill: null,
              gain_db: null,
            },
          ]);
        const expectedDomain = {
          ...beforeFullDomain,
          clips: beforeFullDomain.clips.map((clip) =>
            clip.track_id === "reference"
              ? {
                  ...clip,
                  mute_regions: [
                    {
                      start_s: 2,
                      end_s: 3,
                      fade_in_ms: 5,
                      fade_out_ms: 5,
                      fill: null,
                      gain_db: null,
                    },
                  ],
                }
              : clip,
          ),
        };
        const committedHistory = snapshot(projectPath).history,
          committedDomain = rangeDomain(projectPath);
        const committedTrackOrder = read(projectPath).timeline.tracks.map(
          (track) => track.id,
        );
        receipts.push({
          checkpoint: "numeric-mute-committed-order",
          observation: {
            beforeClipOrder: beforeFullDomain.clips.map((clip) => clip.id),
            committedClipOrder: committedDomain.clips.map((clip) => clip.id),
            beforeTrackOrder,
            committedTrackOrder,
            committedDomain,
            expectedDomain,
            committedHistory,
            accepted,
          },
        });
        expect(committedTrackOrder).toEqual(beforeTrackOrder);
        expect(keyedDomain(committedDomain)).toEqual(
          keyedDomain(expectedDomain),
        );
        expect(
          committedHistory?.entries.filter((entry) => entry.operation !== null),
        ).toEqual([
          expect.objectContaining({ operation: "edit_selected_range" }),
        ]);
        expect(
          observer.commands.filter((command) => command.type !== "UndoHistory"),
        ).toHaveLength(1);
        expect(snapshot(projectPath).history?.cursor).toBe(1);
        const undo = await acceptedCommand(page, "UndoHistory", () =>
          page.keyboard.press("ControlOrMeta+Z"),
        );
        await expect
          .poll(() => keyedDomain(rangeDomain(projectPath)))
          .toEqual(keyedDomain(beforeFullDomain));
        const afterHistory = snapshot(projectPath).history;
        const afterDomain = rangeDomain(projectPath),
          afterTrackOrder = read(projectPath).timeline.tracks.map(
            (track) => track.id,
          );
        expect(keyedDomain(afterDomain)).toEqual(keyedDomain(beforeFullDomain));
        expect(afterTrackOrder).toEqual(beforeTrackOrder);
        expect(afterHistory?.cursor).toBe(
          Math.max(0, before.history?.cursor ?? -1),
        );
        expect(afterHistory?.entries).toEqual(committedHistory?.entries);
        expect(
          observer.commands.filter((command) => command.type === "UndoHistory"),
        ).toHaveLength(1);
        receipts.push({
          checkpoint: "numeric-range-refusal-mapped-mute-undo",
          observation: {
            before,
            beforeFullDomain,
            expectedDomain,
            committedDomain,
            afterDomain,
            afterClipOrder: afterDomain.clips.map((clip) => clip.id),
            beforeTrackOrder,
            committedTrackOrder,
            afterTrackOrder,
            after: snapshot(projectPath),
            accepted,
            undo,
            commands: observer.commands,
          },
        });
      } finally {
        await observer.retain(before);
      }
    },
    undefined,
    emptyModesFixture,
  );
});
