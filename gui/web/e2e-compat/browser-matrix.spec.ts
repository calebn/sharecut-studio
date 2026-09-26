import { devices, expect, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";
import { e2eProjectPath } from "../e2e/env";
import { hostOfflineQueueCount } from "../e2e/offlineQueue";
import { openHostProject } from "../e2e/overlayReachability";
import {
  interceptCommentCommands,
  postHostComment,
} from "../e2e/queuedComment";
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
    const paused = parseTimecodeSec(await clock.innerText());
    await page.waitForTimeout(600);
    expect(parseTimecodeSec(await clock.innerText())).toBe(paused);
    await expectPageAxeClean(page);
  });

  test("persists an offline comment across reload and replays its command", async ({
    page,
  }) => {
    const note = `Cross-browser queued note ${crypto.randomUUID()}`;
    const { commands, forwarded, setOffline } =
      await interceptCommentCommands(page);
    await openHostProject(page);
    await postHostComment(page, note);
    await expect.poll(() => commands.length).toBe(1);
    const queuedCount = () => hostOfflineQueueCount(page, e2eProjectPath);
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
    await page
      .getByLabel("Editor panels")
      .getByRole("button", { name: "Comments" })
      .click();
    await expect(page.getByText(note, { exact: true }).first()).toBeVisible();
  });

  test("applies document updates after the socket reconnects", async ({
    page,
    browser,
  }) => {
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const sockets: WebSocket[] = [];
      const received: string[] = [];
      class TrackedWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes("/api/document/ws")) {
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
    const note = `After reconnect ${crypto.randomUUID()}`;
    const sender = await browser.newPage();
    try {
      await openHostProject(sender);
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
      await page
        .getByLabel("Editor panels")
        .getByRole("button", { name: "Comments" })
        .click();
      await expect(
        page.locator(".comment-card-body").getByText(note, { exact: true }),
      ).toBeVisible();
    } finally {
      await sender.close();
    }
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
