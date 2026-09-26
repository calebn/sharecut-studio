import { devices, expect, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";
import { e2eProjectPath } from "../e2e/env";
import { hostOfflineQueueCount } from "../e2e/offlineQueue";
import { openHostProject } from "../e2e/overlayReachability";
import {
  createRecordRoom,
  markSharecutE2e,
  openRecordLink,
} from "../e2e/recordRoom";
import { withShareableProject } from "../e2e/shareableProject";
import {
  stubSyntheticMicrophone,
  syntheticMicrophoneRequested,
} from "../e2e/syntheticMicrophone";
import { parseTimecodeSec } from "../e2e/timecode";
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
  test("advances playback across browser engines", async ({ page }) => {
    await openHostProject(page);
    const play = page.getByRole("button", { name: "Play", exact: true });
    await expect(play).toBeEnabled();
    await page
      .getByRole("group", { name: "Audition mode" })
      .getByRole("button", { name: "Raw" })
      .click();
    const clock = page.locator("header.transport .timecode-current");
    const initial = parseTimecodeSec(await clock.innerText());
    await play.click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect
      .poll(async () => parseTimecodeSec(await clock.innerText()))
      .toBeGreaterThan(initial + 0.25);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(play).toBeVisible();
    await expectPageAxeClean(page);
  });

  test("persists an offline comment across reload and replays its command", async ({
    page,
  }) => {
    const commands: Array<{
      command_id: string;
      client_id: string;
      client_seq: number;
      type: string;
    }> = [];
    let offline = true;
    await page.route("**/api/document/command?*", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const command = route
        .request()
        .postDataJSON() as (typeof commands)[number];
      if (command.type !== "AddComment") return route.continue();
      commands.push(command);
      if (offline) return route.abort("failed");
      return route.continue();
    });
    await openHostProject(page);
    await page
      .getByLabel("Editor panels")
      .getByRole("button", { name: "Comments" })
      .click();
    await page.getByRole("button", { name: "Comment mode" }).click();
    await page.getByRole("slider", { name: "Comment time anchor" }).click();
    await page.getByLabel("Author").fill("Host");
    await page.getByPlaceholder("Feedback…").fill("Cross-browser queued note");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(() => commands.length).toBe(1);
    const queuedCount = () => hostOfflineQueueCount(page, e2eProjectPath);
    await expect.poll(queuedCount).toBe(1);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect.poll(queuedCount).toBe(1);
    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).toMatchObject(commands[0]!);
    await expect.poll(queuedCount).toBe(0);
    await page
      .getByLabel("Editor panels")
      .getByRole("button", { name: "Comments" })
      .click();
    await expect(
      page.getByText("Cross-browser queued note").first(),
    ).toBeVisible();
  });

  test("reconnects the document socket after a drop", async ({ page }) => {
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const sockets: WebSocket[] = [];
      class TrackedWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes("/api/document/ws")) sockets.push(this);
        }
      }
      Object.defineProperty(window, "WebSocket", { value: TrackedWebSocket });
      Object.assign(window, { __documentSockets: sockets });
    });
    await openHostProject(page);
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
              (window as unknown as Window & { __documentSockets: WebSocket[] })
                .__documentSockets.length,
          ),
        { timeout: 8_000 },
      )
      .toBeGreaterThan(1);
    await expect.poll(socketCount).toBe(1);
    await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
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

      await expect(page.locator(".daw-shell--phone")).toBeVisible();
      await expect(page.getByRole("button", { name: "Listen" })).toBeVisible();
      await expect(page.locator(".listen-hero")).toBeVisible();
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(true);
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More" })
        .click();
      const menu = page.getByRole("button", { name: "Menu", exact: true });
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
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);

        await markSharecutE2e(guest);
        // Safari lacks permissions.query({ name: "microphone" }); keep the
        // native Permissions API elsewhere so each engine takes its own branch.
        await stubSyntheticMicrophone(guest, {
          removePermissionsApi: browserName === "webkit",
        });
        await openRecordLink(guest, room.guest.token);
        await expect(
          guest.getByRole("heading", { name: "Join the recording" }),
        ).toBeVisible();
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
        await guest.getByLabel("Display name").fill("Ava");
        await guest.getByLabel("I am wearing headphones").check();
        await expect(
          guest.getByRole("heading", {
            name: "Record 3 seconds of room tone",
          }),
        ).toBeVisible();
        const allow = guest.getByRole("button", { name: "Allow microphone" });
        await expect(allow).toBeVisible();
        await allow.click();
        await expect.poll(() => syntheticMicrophoneRequested(guest)).toBe(true);
        const level = guest.getByLabel("Level");
        await expect(level).toBeVisible();
        // LevelMeter is a div role="meter"; silence reports aria-valuenow == aria-valuemin.
        await expect
          .poll(async () => {
            const [now, min] = await Promise.all([
              level.getAttribute("aria-valuenow"),
              level.getAttribute("aria-valuemin"),
            ]);
            return Number(now) - Number(min);
          })
          .toBeGreaterThan(0);
      });
    });
  });
});
