import { expect, test } from "@playwright/test";
import { expectFeedback } from "./feedback";
import {
  type Command,
  hit,
  read,
  record,
  runAudit,
  snapshot,
} from "./lifecycleAudit";
import { hostOfflineQueueCount } from "./offlineQueue";
import { inspectSelectionByKey, saveStatus } from "./stageNav";
import { openScript } from "./transcriptEdit";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
for (const terminal of ["escape", "synthetic-cancel"] as const)
  test(`Wordbar handle drag ${terminal} restores exact original timing`, async ({
    page,
  }, info) => {
    await runAudit(page, info, false, async (p, c) => {
      const list = await openScript(page);
      await list.locator(".sys-script-word").first().click();
      await inspectSelectionByKey(page);
      const end = page.getByRole("spinbutton", { name: "Word end" });
      await expect(end).toBeEnabled();
      const before = snapshot(p),
        value = await end.getAttribute("aria-valuenow");
      const handle = page.locator('[data-boundary="end"] .wordbar-handle');
      await handle.evaluate((el) =>
        el.addEventListener(
          "pointerdown",
          (event) => {
            if (event.isTrusted)
              (
                window as unknown as { __wordbarOwner?: number }
              ).__wordbarOwner = (event as PointerEvent).pointerId;
          },
          { once: true },
        ),
      );
      const box = await handle.boundingBox();
      if (!box) throw new Error("Wordbar preparation has no handle bounds");
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 12, y, { steps: 3 });
      await expect(end).not.toHaveAttribute("aria-valuenow", value ?? "");
      expect(snapshot(p)).toEqual(before);
      if (terminal === "escape") {
        await page.keyboard.press("Escape");
        await page.mouse.up();
      } else {
        const eventId = await handle.evaluate(
          () =>
            (window as unknown as { __wordbarOwner?: number }).__wordbarOwner,
        );
        if (eventId === undefined)
          throw new Error(
            "Synthetic cancellation did not observe the Wordbar pointerdown; preparation failed",
          );
        await handle.dispatchEvent("pointercancel", {
          pointerId: eventId,
          pointerType: "mouse",
          bubbles: true,
        });
        await page.mouse.up();
      }
      expect(snapshot(p)).toEqual(before);
      expect(c.filter((v) => v.type === "SetTranscriptWordTiming")).toEqual([]);
      if (await end.count())
        await expect(end).toHaveAttribute("aria-valuenow", value ?? "");
    });
  });
for (const delivery of ["409", "abort-replay"] as const)
  test(`actual native fade gesture ${delivery} ${delivery === "409" ? "refuses without saving" : "retains identity, drains queue, and one Undo restores fade"}`, async ({
    page,
  }, info) => {
    await runAudit(page, info, false, async (p, c) => {
      const block = page
          .locator(
            '.lane-row[data-track-id="reference"] [data-testid="timeline-clip"]',
          )
          .first(),
        handle = block.locator(".fade-corner.in");
      await handle.focus();
      const origin = snapshot(p);
      const attempts: Command[] = [];
      let blocked = true;
      await page.route("**/api/document/command*", async (route) => {
        const body = route.request().postDataJSON() as Command;
        if (body.type !== "SetClipFade") return route.continue();
        attempts.push(body);
        if (!blocked) return route.continue();
        if (delivery === "409")
          return route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Lifecycle audit refused fade" }),
          });
        return route.abort("internetdisconnected");
      });
      const point = await hit(handle);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 18, point.y, { steps: 4 });
      expect(snapshot(p)).toEqual(origin);
      await page.mouse.up();
      await expect.poll(() => attempts.length).toBeGreaterThanOrEqual(1);
      if (delivery === "409") {
        await expectFeedback(
          page,
          /Clip edit failed:.*Lifecycle audit refused fade/,
          { superseded: true },
        );
        expect(snapshot(p)).toEqual(origin);
        expect(await hostOfflineQueueCount(page, p)).toBe(0);
        await expect(block.locator(".clip-fade-line")).toHaveCount(0);
      } else {
        await expect.poll(() => hostOfflineQueueCount(page, p)).toBe(1);
        // The aborted send leaves an unknown outcome, so the dot says Save failed; its Retry opens the queue.
        await expect(saveStatus(page)).toContainText("Save failed");
        expect(snapshot(p)).toEqual(origin);
        const first = attempts[0];
        expect(first.command_id).toEqual(expect.stringMatching(/\S/));
        expect(first.client_id).toEqual(expect.stringMatching(/\S/));
        expect(Number.isSafeInteger(first.client_seq)).toBe(true);
        blocked = false;
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect.poll(() => hostOfflineQueueCount(page, p)).toBe(0);
        await expect
          .poll(() => read(p).timeline.clips[0].fade_in_ms ?? 0)
          .toBeGreaterThan(0);
        expect(attempts.length).toBeGreaterThanOrEqual(2);
        expect(
          attempts
            .slice(1)
            .every(
              (v) =>
                v.command_id === first.command_id &&
                v.client_id === first.client_id &&
                v.client_seq === first.client_seq,
            ),
        ).toBe(true);
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => snapshot(p).clips).toEqual(origin.clips);
        expect(
          c.filter((command) => command.type === "UndoHistory"),
        ).toHaveLength(1);
      }
      await record(page, info, "delivery-result", {
        delivery,
        syntheticHTTPInterception: true,
        syntheticOnlineSignal: delivery === "abort-replay",
        nativeMouse: true,
        attempts,
        commands: c,
        saved: snapshot(p),
      });
    });
  });
