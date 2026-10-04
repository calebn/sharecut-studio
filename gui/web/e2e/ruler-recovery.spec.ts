import fs from "node:fs";
import path from "node:path";
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
import { openTransportMenu } from "./overlayReachability";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
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

for (const terminal of ["cancel", "loss"] as const) {
  test(`comment ruler native captured owner ${terminal} restores the previous instant anchor`, {
    annotation: { type: "878-cell", description: `F04-anchor-${terminal}` },
  }, async ({ page, receipts }) => {
    await withShareableProject(async (projectPath) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await openHostShare(page, projectPath);
      await setTheme(page, "light");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const ruler = page.getByRole("slider", { name: "Comment time anchor" });
      const hint = page.locator(".comment-compose-hint");
      const scale = await rulerScale(ruler);
      const point = async (seconds: number) => {
        const rect = await ruler.boundingBox();
        expect(rect).not.toBeNull();
        const value = {
          x: rect!.x + seconds * scale.pxPerSecond,
          y: rect!.y + rect!.height / 2,
        };
        const owned = await ruler.evaluate((element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit === element || (hit !== null && element.contains(hit));
        }, value);
        expect(
          owned,
          "Preparation must hit the actual ruler at requested time",
        ).toBe(true);
        return value;
      };
      const initial = await point(2.2);
      await page.mouse.click(initial.x, initial.y);
      await expect(hint).toContainText("Anchor: 0:02 (instant)");
      const originalHint = await hint.textContent();
      const before = snapshot(projectPath);
      const observer = rulerCommands(page, projectPath, receipts),
        commands = observer.commands;
      const events = await ruler.evaluateHandle((element) => {
        const events: { pointerId: number; trusted: boolean }[] = [];
        const listener = (event: Event) => {
          const pointer = event as PointerEvent;
          events.push({
            pointerId: pointer.pointerId,
            trusted: event.isTrusted,
          });
        };
        const lost: { pointerId: number; trusted: boolean }[] = [];
        const lostListener = (event: Event) =>
          lost.push({
            pointerId: (event as PointerEvent).pointerId,
            trusted: event.isTrusted,
          });
        element.addEventListener("pointerdown", listener);
        element.addEventListener("lostpointercapture", lostListener);
        return {
          events,
          lost,
          dispose: () => {
            element.removeEventListener("pointerdown", listener);
            element.removeEventListener("lostpointercapture", lostListener);
          },
        };
      });
      let interactionError: unknown;
      let ownerEvidence: object = {};
      try {
        const start = await point(4.2);
        const end = await point(10.2);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 4 });
        await expect(hint).toContainText("Anchor: 0:04–0:10");
        const observedEvents = await events.evaluate(
          (recorder) => recorder.events,
        );
        expect(observedEvents).toHaveLength(1);
        expect(observedEvents[0].trusted).toBe(true);
        const pointerId = observedEvents[0].pointerId;
        ownerEvidence = { start, end, observedEvents, pointerId };
        expect(
          await ruler.evaluate(
            (element, id) => element.hasPointerCapture(id),
            pointerId,
          ),
        ).toBe(true);
        expect(snapshot(projectPath)).toEqual(before);
        expect(commands).toEqual([]);
        if (terminal === "loss") {
          await ruler.evaluate(
            (element, id) => element.releasePointerCapture(id),
            pointerId,
          );
          await page.mouse.move(end.x + 1, end.y);
          await expect
            .poll(() => events.evaluate((recorder) => recorder.lost))
            .toEqual([{ pointerId, trusted: true }]);
        } else
          await ruler.dispatchEvent("pointercancel", {
            pointerId,
            pointerType: "mouse",
            bubbles: true,
          });
        receipts.push({
          checkpoint: "comment-owner-terminal",
          observation: {
            terminal,
            pointerId,
            originalHint,
            currentHint: await hint.textContent(),
            scale,
            start,
            end,
            observedEvents,
            lostCaptureEvents: await events.evaluate(
              (recorder) => recorder.lost,
            ),
            saved: snapshot(projectPath),
            commands,
            provenance:
              terminal === "loss"
                ? "scripted-capture-loss-after-native-owner"
                : "synthetic-pointercancel-after-native-owner",
          },
        });
        await expect(hint).toHaveText(originalHint!);
        expect(
          await ruler.evaluate(
            (element, id) => element.hasPointerCapture(id),
            pointerId,
          ),
        ).toBe(false);
        const later = await point(12.2);
        await page.mouse.move(later.x, later.y);
        await expect(hint).toHaveText(originalHint!);
        await page.mouse.up();
        await expect(hint).toHaveText(originalHint!);
        expect(snapshot(projectPath)).toEqual(before);
        expect(commands).toEqual([]);
        const next = await point(6.2);
        await page.mouse.click(next.x, next.y);
        await expect(hint).toContainText("Anchor: 0:06 (instant)");
        expect(snapshot(projectPath)).toEqual(before);
        expect(commands).toEqual([]);
        receipts.push({
          checkpoint: "comment-restored-next-gesture",
          observation: {
            originalHint,
            nextHint: await hint.textContent(),
            saved: snapshot(projectPath),
            commands,
          },
        });
      } catch (error) {
        interactionError = error;
      }
      const pointerRetention = await Promise.allSettled([
        events.evaluate((recorder) => ({
          events: recorder.events,
          lost: recorder.lost,
        })),
      ]);
      receipts.push({
        checkpoint: "comment-owner-terminal-retained",
        observation: {
          ownerEvidence,
          pointerRetention: pointerRetention.map((result) =>
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
      await observer.retain(before);
      const cleanup = await Promise.allSettled([
        page.mouse.up(),
        events.evaluate((recorder) => recorder.dispose()),
      ]);
      const disposal = await Promise.allSettled([events.dispose()]);
      if (interactionError !== undefined) throw interactionError;
      const cleanupFailure = [...cleanup, ...disposal].find(
        (result) => result.status === "rejected",
      );
      if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
    });
  });
}

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

async function anchorDown(
  page: Page,
  ruler: Locator,
  seconds: number,
  receipts: { checkpoint: string; observation: object }[],
) {
  const point = await timePoint(ruler, seconds);
  const recorder = await ruler.evaluateHandle((element) => {
    const recorded: { id: number | null; trusted: boolean } = {
      id: null,
      trusted: false,
    };
    const listener = (event: Event) => {
      recorded.id = (event as PointerEvent).pointerId;
      recorded.trusted = event.isTrusted;
    };
    element.addEventListener("pointerdown", listener);
    return {
      recorded,
      dispose: () => element.removeEventListener("pointerdown", listener),
    };
  });
  let observation: { id: number | null; trusted: boolean } | null = null;
  let interactionError: unknown;
  try {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    observation = await recorder.evaluate((value) => value.recorded);
  } catch (error) {
    interactionError = error;
  }
  const cleanup = await Promise.allSettled([
    recorder.evaluate((value) => value.dispose()),
  ]);
  const disposal = await Promise.allSettled([recorder.dispose()]);
  if (interactionError !== undefined) throw interactionError;
  const cleanupFailure = [...cleanup, ...disposal].find(
    (result) => result.status === "rejected",
  );
  if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
  const captured =
    observation?.id === null || observation === null
      ? null
      : await ruler.evaluate(
          (element, id) => element.hasPointerCapture(id),
          observation.id,
        );
  receipts.push({
    checkpoint: "comment-native-owner-admission",
    observation: { point, native: observation, captured },
  });
  expect(observation).not.toBeNull();
  expect(observation!.trusted).toBe(true);
  expect(observation!.id).not.toBeNull();
  const id = observation!.id!;
  expect(
    await ruler.evaluate((element, id) => element.hasPointerCapture(id), id),
  ).toBe(true);
  return { ...point, id };
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
          hint: document.querySelector(".comment-compose-hint")?.textContent,
          range: document.querySelector(".range-summary")?.textContent,
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

function commentHistory(projectPath: string) {
  const index = path.join(path.dirname(projectPath), "history", "index.json");
  return fs.existsSync(index)
    ? (JSON.parse(fs.readFileSync(index, "utf8")) as {
        cursor: number;
        entries: { id: string; label: string; operation: string | null }[];
      })
    : null;
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

function commentRows(projectPath: string) {
  return (read(projectPath).review?.comments ?? []) as {
    body: string;
    timeline_start: number;
    timeline_end: number | null;
  }[];
}

for (const kind of ["instant", "span"] as const) {
  test(`comment ${kind} threshold and reverse submit once with one host Undo`, {
    annotation: [
      { type: "878-cell", description: "F04-instant-threshold" },
      { type: "878-cell", description: "F04-submit-undo" },
    ],
  }, async ({ page, receipts }) => {
    await withShareableProject(async (projectPath) => {
      await openModes(page, projectPath);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const ruler = page.getByRole("slider", { name: "Comment time anchor" });
      const hint = page.locator(".comment-compose-hint");
      const before = snapshot(projectPath),
        observer = rulerCommands(page, projectPath, receipts);
      try {
        const owner = await anchorDown(page, ruler, 4.2, receipts);
        await page.mouse.move(owner.x + 3, owner.y);
        await expect(hint).toContainText("(instant)");
        if (kind === "span") {
          await page.mouse.move(owner.x + 5, owner.y);
          await expect(hint).not.toContainText("(instant)");
          const reversed = await timePoint(ruler, 2.2);
          await page.mouse.move(reversed.x, reversed.y, { steps: 4 });
          await expect(hint).toContainText("Anchor: 0:02–0:04");
        }
        await page.mouse.up();
        expect(snapshot(projectPath)).toEqual(before);
        expect(observer.commands).toEqual([]);
        await page
          .getByRole("textbox", { name: "Comment", exact: true })
          .fill(`G03 ${kind}`);
        const priorHistory = commentHistory(projectPath);
        const accepted = await acceptedCommand(page, "AddComment", () =>
          page
            .getByRole("button", { name: "Post comment", exact: true })
            .click(),
        );
        await expect
          .poll(() => commentRows(projectPath).length)
          .toBe(before.comments.length + 1);
        const saved = commentRows(projectPath).find(
          (row) => row.body === `G03 ${kind}`,
        )!;
        expect(
          Math.abs(saved.timeline_start - (kind === "instant" ? 4.2 : 2.2)),
        ).toBeLessThanOrEqual(1 / owner.scale.pxPerSecond);
        if (kind === "instant") expect(saved.timeline_end).toBeNull();
        else
          expect(Math.abs(saved.timeline_end! - 4.2)).toBeLessThanOrEqual(
            1 / owner.scale.pxPerSecond,
          );
        expect(
          observer.commands.filter((command) => command.type === "AddComment"),
        ).toHaveLength(1);
        const committedHistory = commentHistory(projectPath)!;
        const originCursor = Math.max(0, priorHistory?.cursor ?? -1);
        expect(committedHistory.cursor).toBe(originCursor + 1);
        expect(committedHistory.entries[committedHistory.cursor]).toMatchObject(
          { label: "after add comment", operation: null },
        );
        expect(committedHistory.entries.slice(originCursor + 1)).toHaveLength(
          1,
        );
        if (priorHistory && priorHistory.cursor >= 0)
          expect(committedHistory.entries.slice(0, originCursor + 1)).toEqual(
            priorHistory.entries.slice(0, originCursor + 1),
          );
        else
          expect(committedHistory.entries[0]).toMatchObject({
            label: "before add comment",
            operation: null,
          });
        const undo = await acceptedCommand(page, "UndoHistory", () =>
          page.keyboard.press("ControlOrMeta+Z"),
        );
        await expect
          .poll(() => snapshot(projectPath).comments)
          .toEqual(before.comments);
        expect(snapshot(projectPath).history?.cursor).toBe(originCursor);
        const { history: _beforeHistory, ...beforeDomain } = before;
        const { history: _afterHistory, ...afterDomain } =
          snapshot(projectPath);
        expect(afterDomain).toEqual(beforeDomain);
        expect(
          observer.commands.filter((command) => command.type === "UndoHistory"),
        ).toHaveLength(1);
        receipts.push({
          checkpoint: "comment-threshold-submit-undo",
          observation: {
            kind,
            owner,
            saved,
            accepted,
            undo,
            priorHistory,
            committedHistory,
            before,
            after: snapshot(projectPath),
            commands: observer.commands,
          },
        });
      } finally {
        await observer.retain(before);
      }
    });
  });
}

for (const departure of ["tool", "page"] as const) {
  test(`held comment owner ${departure} departure cannot recreate a draft on release`, {
    annotation: {
      type: "878-cell",
      description:
        departure === "tool" ? "F04-tool-exit" : "F04-anchor-unmount",
    },
  }, async ({ page, receipts }) => {
    await withShareableProject(async (projectPath) => {
      await openModes(page, projectPath);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const ruler = page.getByRole("slider", { name: "Comment time anchor" });
      const before = snapshot(projectPath),
        observer = rulerCommands(page, projectPath, receipts);
      try {
        const owner = await anchorDown(page, ruler, 4.2, receipts),
          end = await timePoint(ruler, 10.2);
        await page.mouse.move(end.x, end.y, { steps: 4 });
        await expect(page.locator(".comment-compose-hint")).toContainText(
          "0:04–0:10",
        );
        if (departure === "tool") {
          await page.keyboard.press("Escape");
          await expect(
            page.getByRole("slider", { name: "Timeline position" }),
          ).toBeVisible();
          expect(
            await page
              .getByRole("slider", { name: "Timeline position" })
              .evaluate(
                (element, id) => element.hasPointerCapture(id),
                owner.id,
              ),
          ).toBe(false);
          await expect(page.locator(".comment-compose")).toHaveCount(0);
        } else {
          await page.goto("about:blank");
          await expect(page.locator(".time-ruler")).toHaveCount(0);
        }
        await page.mouse.move(end.x + 20, end.y);
        await page.mouse.up();
        expect(snapshot(projectPath)).toEqual(before);
        expect(observer.commands).toEqual([]);
        if (departure === "page") await openModes(page, projectPath);
        await expect(page.locator(".comment-compose")).toHaveCount(0);
        const nextRuler = page.getByRole("slider", {
          name: "Timeline position",
        });
        const next = await timePoint(nextRuler, 6.2);
        await page.mouse.click(next.x, next.y);
        await expect
          .poll(async () =>
            Math.abs(
              Number(await nextRuler.getAttribute("aria-valuenow")) - 6.2,
            ),
          )
          .toBeLessThanOrEqual(1 / next.scale.pxPerSecond);
        expect(snapshot(projectPath)).toEqual(before);
        expect(observer.commands).toEqual([]);
        receipts.push({
          checkpoint: "comment-departure-inert-release",
          observation: {
            departure,
            owner,
            before,
            commands: observer.commands,
            provenance:
              departure === "page"
                ? "public-navigation-blur-unmount-composite"
                : "native-global-Escape-tool-exit",
          },
        });
      } finally {
        await observer.retain(before);
      }
    });
  });
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

test("comment span accounts for held horizontal scroll and reverses without saving", {
  annotation: { type: "878-cell", description: "F04-anchor-scroll" },
}, async ({ page, receipts }) => {
  await withShareableProject(async (projectPath) => {
    await openModes(page, projectPath);
    const ordinary = page.getByRole("slider", { name: "Timeline position" });
    const scroll = await zoomForScroll(page, ordinary);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const ruler = page.getByRole("slider", { name: "Comment time anchor" }),
      hint = page.locator(".comment-compose-hint");
    const before = snapshot(projectPath),
      observer = rulerCommands(page, projectPath, receipts);
    try {
      const owner = await anchorDown(page, ruler, 2.2, receipts);
      await page.mouse.move(owner.x + 100, owner.y, { steps: 4 });
      await expect(hint).not.toContainText("(instant)");
      const initialScroll = await scroll.evaluate(
        (element) => element.scrollLeft,
      );
      await page.mouse.wheel(200, 0);
      await expect
        .poll(() => scroll.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(initialScroll);
      const scrolled = await scroll.evaluate((element) => element.scrollLeft);
      await page.mouse.move(owner.x + 101, owner.y);
      const rect = await ruler.boundingBox();
      const expectedEnd = (owner.x + 101 - rect!.x) / owner.scale.pxPerSecond;
      const wholeClock = (sec: number) =>
        `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
      await expect(hint).toContainText(`0:02–${wholeClock(expectedEnd)}`);
      await page.mouse.wheel(-200, 0);
      await expect
        .poll(() => scroll.evaluate((element) => element.scrollLeft))
        .toBe(initialScroll);
      const reversed = await timePoint(ruler, 1.2);
      await page.mouse.move(reversed.x, reversed.y, { steps: 4 });
      await expect(hint).toContainText("0:01–0:02");
      await page.mouse.up();
      expect(snapshot(projectPath)).toEqual(before);
      expect(observer.commands).toEqual([]);
      receipts.push({
        checkpoint: "comment-held-scroll-reverse",
        observation: {
          owner,
          initialScroll,
          scrolled,
          expectedEnd,
          reversed,
          hint: await hint.textContent(),
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
        (await page.locator(".transport .timecode-current").textContent())!
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
      expect(await lineX()).toBeCloseTo(origin.x, 1);
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
  const summary = await page
    .getByRole("region", { name: "Range actions" })
    .locator(".range-summary")
    .textContent();
  const match = summary!.match(/([\d.]+)–([\d.]+) s/);
  expect(match).not.toBeNull();
  return { start: Number(match![1]), end: Number(match![2]), summary };
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
          page.getByRole("region", { name: "Range actions" }),
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
          .getByRole("region", { name: "Range actions" })
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
        await expect(
          page.getByRole("region", { name: "Range actions" }),
        ).toContainText("reference, guest");
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
          page.getByRole("region", { name: "Range actions" }),
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
        await openTransportMenu(page);
        await page
          .getByRole("menuitem", { name: "Select a range", exact: true })
          .click();
        const range = page.getByRole("region", { name: "Range actions" });
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
        await expect(range.locator(".range-summary")).toContainText(
          "reference",
        );
        await expect(range.locator(".range-summary")).not.toContainText(
          "guest",
        );
        await expect(
          page.locator('.lane-row[data-track-id="reference"] .range-overlay'),
        ).toHaveCount(1);
        await expect(
          page.locator('.lane-row[data-track-id="guest"] .range-overlay'),
        ).toHaveCount(0);
        expect(snapshot(projectPath)).toEqual(before);
        const accepted = await acceptedCommand(page, "EditSelectedRange", () =>
          range.getByRole("button", { name: "Mute", exact: true }).click(),
        );
        await expect
          .poll(
            () =>
              snapshot(projectPath).clips.find(
                (clip) => clip.track_id === "reference",
              )?.mute_regions,
          )
          .toEqual([{ start_s: 2, end_s: 3 }]);
        const expectedDomain = {
          ...beforeFullDomain,
          clips: beforeFullDomain.clips.map((clip) =>
            clip.track_id === "reference"
              ? { ...clip, mute_regions: [{ start_s: 2, end_s: 3 }] }
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
