import fs from "node:fs";
import { devices, expect, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";
import { e2eProjectPath } from "../e2e/env";
import { hostOfflineQueueCount } from "../e2e/offlineQueue";
import { openHostProject } from "../e2e/overlayReachability";
import { expectPlaybackAdvancesThenHolds, playButton } from "../e2e/playback";
import {
  interceptCommentCommands,
  postHostComment,
} from "../e2e/queuedComment";
import {
  createRecordRoom,
  fillDisplayNameField,
  markSharecutE2e,
  openRecordLink,
} from "../e2e/recordRoom";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import {
  openCommentCard,
  openProject,
  projectMenuButton,
  setAudition,
} from "../e2e/stageNav";
import { ownsStudioAxe } from "../e2e/studioAxeOwnership";
import {
  stubSyntheticMicrophone,
  syntheticMicrophoneRequested,
} from "../e2e/syntheticMicrophone";
import { withBrowserPages } from "../e2e/twoBrowserPages";
import {
  expectPaintedWaveformTile,
  waveformBackend,
} from "../e2e/waveformHook";

// `defaultBrowserType` would force a new worker per describe; each project
// already pins its engine, so borrow only the phone viewport/touch traits.
const { defaultBrowserType: _phoneEngine, ...phone } = devices["iPhone 13"];

/** Subpixel rounding can place a right/bottom edge a fraction past the viewport. */
const SUBPIXEL_TOLERANCE = 1;

test.describe("browser compatibility matrix", () => {
  test("advances playback across browser engines", async ({
    page,
    browserName,
  }) => {
    await openHostProject(page);
    await expect(playButton(page)).toBeEnabled();
    await setAudition(page, "raw");
    await expectPlaybackAdvancesThenHolds(page);
    if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
      await expectPageAxeClean(page);
    }
  });

  test("persists an offline comment across reload and replays its command", async ({
    page,
  }) => {
    const suiteComments = JSON.parse(fs.readFileSync(e2eProjectPath, "utf8"))
      .review.comments;
    await withShareableProject(async (projectPath) => {
      const note = `Cross-browser queued note ${crypto.randomUUID()}`;
      const { commands, forwarded, setOffline } =
        await interceptCommentCommands(page);
      await openHostShare(page, projectPath);
      await postHostComment(page, note);
      await expect.poll(() => commands.length).toBe(1);
      const queuedCount = () => hostOfflineQueueCount(page, projectPath);
      await expect.poll(queuedCount).toBe(1);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        /aligned dialogue/i,
      );
      await expect.poll(queuedCount).toBe(1);
      setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect
        .poll(() =>
          forwarded.some(
            (command) =>
              command.command_id === commands[0]?.command_id &&
              command.client_id === commands[0]?.client_id &&
              command.client_seq === commands[0]?.client_seq &&
              command.type === "AddComment",
          ),
        )
        .toBe(true);
      await expect.poll(queuedCount).toBe(0);
      await expect(await openCommentCard(page, note)).toBeVisible();
    });
    expect(
      JSON.parse(fs.readFileSync(e2eProjectPath, "utf8")).review.comments,
    ).toEqual(suiteComments);
  });

  test("applies document updates after the socket reconnects", async ({
    page,
    browser,
  }) => {
    const suiteComments = JSON.parse(fs.readFileSync(e2eProjectPath, "utf8"))
      .review.comments;
    await withShareableProject(async (projectPath) => {
      await page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        const sockets: WebSocket[] = [];
        const received: string[] = [];
        class TrackedWebSocket extends NativeWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            if (String(url).includes("/api/host/ws")) {
              sockets.push(this);
              this.addEventListener("message", (event) =>
                received.push(String(event.data)),
              );
            }
          }
        }
        Object.defineProperty(window, "WebSocket", { value: TrackedWebSocket });
        Object.assign(window, {
          __documentSockets: sockets,
          __documentMessages: received,
        });
      });
      await openHostShare(page, projectPath);
      // The receiver must learn about the later mutation through document sync.
      // A successful metadata poll would otherwise hydrate the same comment.
      await page.route("**/api/project/meta?*", (route) =>
        route.abort("failed"),
      );
      const socketCount = () =>
        page.evaluate(
          () =>
            (
              window as unknown as Window & { __documentSockets: WebSocket[] }
            ).__documentSockets.filter(
              (socket) => socket.readyState === WebSocket.OPEN,
            ).length,
        );
      await expect.poll(socketCount).toBe(1);
      await page.evaluate(() =>
        (
          window as unknown as Window & { __documentSockets: WebSocket[] }
        ).__documentSockets[0]?.close(),
      );
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (
                  window as unknown as Window & {
                    __documentSockets: WebSocket[];
                  }
                ).__documentSockets.length,
            ),
          { timeout: 8_000 },
        )
        .toBeGreaterThan(1);
      await expect.poll(socketCount).toBe(1);
      const note = `After reconnect ${crypto.randomUUID()}`;
      const sender = await browser.newPage();
      try {
        await openHostShare(sender, projectPath);
        await postHostComment(sender, note);
        await expect
          .poll(() =>
            page.evaluate(
              (body) =>
                (
                  window as unknown as Window & { __documentMessages: string[] }
                ).__documentMessages.some((message) => message.includes(body)),
              note,
            ),
          )
          .toBe(true);
        await expect(await openCommentCard(page, note)).toBeVisible();
      } finally {
        await sender.close();
      }
    });
    expect(
      JSON.parse(fs.readFileSync(e2eProjectPath, "utf8")).review.comments,
    ).toEqual(suiteComments);
  });

  test("rasterizes waveform tiles on every engine", async ({ page }) => {
    await openHostProject(page);
    // WebGL2 where the engine offers it in a worker, the CPU worker otherwise.
    expect(["webgl2", "cpu-worker"]).toContain(await waveformBackend(page));
    await expectPaintedWaveformTile(page);
  });

  test.describe("phone", () => {
    test.use(phone);

    test("keeps the listening shell usable on a touch phone", async ({
      page,
    }) => {
      await openHostProject(page);

      await expect(page.locator(".stage-frame--phone")).toBeVisible();
      await expect(page.getByRole("tablist", { name: "Stages" })).toBeVisible();
      await expect(page.locator(".stage-frame-player")).toBeVisible();
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(true);
      const menu = projectMenuButton(page);
      await expect(menu).toBeVisible();
      const viewport = page.viewportSize();
      expect(viewport).toBeTruthy();
      const box = await menu.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        viewport!.width + SUBPIXEL_TOLERANCE,
      );
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        viewport!.height + SUBPIXEL_TOLERANCE,
      );
    });
  });

  test("takes a recording guest from microphone consent to a live level", async ({
    browser,
    browserName,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        await openProject(host, projectPath, { query: "&e2e=1" });
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);

        await markSharecutE2e(guest);
        // Safari lacks permissions.query({ name: "microphone" }); keep the
        // native Permissions API elsewhere so each engine takes its own branch.
        await stubSyntheticMicrophone(guest, {
          removePermissionsApi: browserName === "webkit",
        });
        await openRecordLink(guest, room.guest.token);
        await expect(guest.getByRole("dialog")).toBeVisible();
        expect(
          await guest.evaluate(
            () =>
              typeof (
                navigator as Navigator & {
                  permissions?: { query?: unknown };
                }
              ).permissions?.query === "function",
          ),
        ).toBe(browserName !== "webkit");
        await fillDisplayNameField(guest, "Ava");
        const headphones = guest.getByRole("button", {
          name: "I'm wearing headphones",
        });
        await headphones.click();
        await expect(headphones).toHaveAttribute("aria-pressed", "true");
        const join = guest.getByRole("button", { name: "Join and record" });
        await expect(join).toBeDisabled();
        const allow = guest.getByRole("button", { name: "Allow microphone" });
        await expect(allow).toBeVisible();
        await allow.click();
        await expect.poll(() => syntheticMicrophoneRequested(guest)).toBe(true);
        // Join also waits for the local storage sink, which headless WebKit
        // may not provide, so this test stops at the live level.
        // The sheet's meter is decorative; its fill carries the level in a
        // custom property, which stays 0 for silence.
        const fill = guest.locator(".sys-join-meter .sys-room-meter-fill");
        await expect(fill).toBeAttached();
        await expect
          .poll(() =>
            fill.evaluate((element) =>
              Number.parseFloat(
                (element as HTMLElement).style.getPropertyValue(
                  "--sys-room-level",
                ),
              ),
            ),
          )
          .toBeGreaterThan(0);
      });
    });
  });
});
