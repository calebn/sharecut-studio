import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { PCM_WAV_HEADER_BYTES } from "../src/audio/wavHeader";
import { KEEPER_OPFS_ROOT } from "../src/record/keeper/opfsPath";
import { expectSurfaceAxeClean } from "./axe";
import {
  keeperWavBytes,
  ONE_SECOND_KEEPER_PCM_BYTES,
  ONE_SECOND_KEEPER_WAV_BYTES,
  recordingWavs,
} from "./keeperOpfs";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import {
  clickHostTransport,
  createRecordRoom,
  ensureHostRecordCommand,
  fillDisplayNameField,
  HOST_PARTICIPANT_ID,
  hostRecordSnapshot,
  joinAsGuest,
  joinAsProducer,
  joinNameField,
  markSharecutE2e,
  openHostDevices,
  openHostMore,
  openHostRecordRoom,
  openRecordLink,
  openRoomNotes,
  readSavedProject,
  recordLinkPath,
  recordParticipantId,
  roomAlertSlot,
  roomPill,
  roomTile,
  stopHostTake,
  waitForSegmentsAcked,
  waitForTakeLanded,
} from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { goToStage, openPanel, openProject, phone, stageTab } from "./stageNav";
import { trackHeaderButton } from "./trackHeader";
import { withBrowserPages } from "./twoBrowserPages";

const LIVE_PILL = /^\d+:\d{2} · Take \d+$/;
const SAVING_OR_SAVED_PILL = /^(Saving · |Saved$)/;

async function enableRoomTonePcmHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (
      window as unknown as { __SHARECUT_E2E_ROOM_TONE_PCM?: boolean }
    ).__SHARECUT_E2E_ROOM_TONE_PCM = true;
  });
}

async function keepTabOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.close = () => {};
  });
}

async function beforeUnloadIsBlocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function roomToneWav(page: Page): Promise<{
  header: number[];
  size: number;
}> {
  const wav = (await recordingWavs(page))?.find((w) =>
    w.path.includes("/room-tone/"),
  );
  if (!wav) {
    throw new Error("room-tone WAV was not saved in OPFS");
  }
  return { header: wav.header, size: wav.size };
}

async function seedSparseRecoveryKeepers(
  page: Page,
  sessionId: string,
  takeIndex: number,
  participantId: string,
): Promise<void> {
  await page.evaluate(
    async ({ rootName, sessionId, takeIndex, participantId }) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of [
        rootName,
        sessionId,
        String(takeIndex),
        participantId,
      ]) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }
      // Interleave with the recorded segment 0, which may already have
      // landed and been reclaimed (only its completion .json remains). Index 2
      // is left genuinely missing so the error counts only lost audio.
      const exists = async (name: string): Promise<boolean> => {
        try {
          await dir.getFileHandle(name);
          return true;
        } catch {
          return false;
        }
      };
      // Start→Stop can race the first segment write, leaving segment 0 with
      // neither a WAV nor a completion marker; seed it so only 2 is missing.
      const segment0Recorded =
        (await exists("0.wav")) || (await exists("0.json"));
      // Seeded WAVs have no completion metadata: they model segments cut off
      // mid-write, which upload leaves alone once capture has settled and
      // recovery exports with a `-partial` label.
      for (const index of segment0Recorded ? [1, 3] : [0, 1, 3]) {
        const handle = await dir.getFileHandle(`${index}.wav`, {
          create: true,
        });
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array(52));
        await writer.close();
      }
    },
    { rootName: KEEPER_OPFS_ROOT, sessionId, takeIndex, participantId },
  );
}

/**
 * Click `trigger` and check the zip it downloads. `revealNotice` opens the
 * place the "Downloaded N …; 1 missing segment" line lands: the host's More
 * sheet already shows it, the guest's room keeps it behind the alert chip.
 */
async function expectRecoveryDownloads(
  page: Page,
  trigger: Locator,
  revealNotice?: () => Promise<void>,
): Promise<void> {
  const downloads: Array<{ name: string; path: Promise<string> }> = [];
  page.on("download", (download) =>
    downloads.push({
      name: download.suggestedFilename(),
      path: download.path(),
    }),
  );
  await trigger.click();
  await expect.poll(() => downloads.length).toBe(1);
  expect(downloads[0]?.name).toMatch(/^full-quality-recordings-p_.*\.zip$/);
  const archive = await readFile(await downloads[0]!.path);
  expect(archive.readUInt32LE(0)).toBe(0x0403_4b50);
  expect(
    archive.includes(Buffer.from("full-quality-take-1-segment-2-partial.wav")),
  ).toBe(true);
  expect(
    archive.includes(Buffer.from("full-quality-take-1-segment-4-partial.wav")),
  ).toBe(true);
  // Segment 0 is exported if still local or skipped if reclaimed after
  // landing; either way only the never-written segment 2 is missing.
  await revealNotice?.();
  await expect(
    page.getByText(
      /Downloaded [23] full-quality recordings; 1 missing segment /,
    ),
  ).toBeVisible();
}

test.use({
  launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] },
});

test.describe("record lobby", () => {
  test("host and guest can download surviving full-quality recordings in Chromium", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      const hostCtx = await browser.newContext({ acceptDownloads: true });
      const guestCtx = await browser.newContext({ acceptDownloads: true });
      const host = await hostCtx.newPage();
      const guest = await guestCtx.newPage();
      try {
        await markSharecutE2e(host);
        await openProject(host, projectPath, { query: "&e2e=1" });
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        await markSharecutE2e(guest);
        await joinAsGuest(guest, room.guest.token, "Ava");
        await ensureHostRecordCommand(host, projectPath, "Start", "recording");
        await ensureHostRecordCommand(host, projectPath, "Stop", "stopped");
        await expect(roomPill(guest)).toHaveText(/^Saving|^Saved/);

        const state = await hostRecordSnapshot(host, projectPath);
        const guestId = await recordParticipantId(host, projectPath, "Ava");
        await seedSparseRecoveryKeepers(
          guest,
          state.session_id,
          state.take_index,
          guestId,
        );
        await seedSparseRecoveryKeepers(
          host,
          state.session_id,
          state.take_index,
          "p_host",
        );
        await guest.reload();
        await openHostMore(await openHostRecordRoom(host));
        // The seeded partial segments leave the guest on "Saving stopped",
        // whose second action saves a copy.
        await expect(roomPill(guest)).toHaveText("Saving stopped");
        await expectRecoveryDownloads(
          guest,
          guest.getByRole("button", { name: "Save a copy" }),
          async () => {
            await guest.getByRole("button", { name: "1 more alert" }).click();
          },
        );
        await expectRecoveryDownloads(
          host,
          host.getByRole("button", { name: "Download full-quality recording" }),
        );
      } finally {
        await hostCtx.close();
        await guestCtx.close();
      }
    });
  });

  test("guest consent unlocks host Start; producer is not recorded", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [{}, {}, {}],
        async ([host, guest, producer]) => {
          const project = encodeURIComponent(projectPath);
          await markSharecutE2e(host);
          await host.goto(`/?project=${project}&e2e=1`);
          await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
          const room = await createRecordRoom(host, projectPath);

          const roomDlg = await openHostRecordRoom(host);
          await expect(
            roomDlg.getByRole("button", { name: "Record", exact: true }),
          ).toBeVisible();
          await expect(
            roomDlg.getByText(/No guest has joined yet/),
          ).toHaveCount(0);
          await expect(
            roomDlg.getByRole("button", { name: "Copy guest link" }),
          ).toHaveCount(0);

          await markSharecutE2e(guest);
          const heldRoomFrames: Array<string | Buffer> = [];
          let roomFramesReleased = false;
          let releaseRoomFrames: () => void = () => {};
          await guest.routeWebSocket(/\/api\/rec\/[^/]+\/ws/, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => server.send(message));
            server.onMessage((message) => {
              if (roomFramesReleased) {
                socket.send(message);
              } else {
                heldRoomFrames.push(message);
              }
            });
            releaseRoomFrames = () => {
              roomFramesReleased = true;
              for (const message of heldRoomFrames) socket.send(message);
              heldRoomFrames.length = 0;
            };
          });
          await guest.addInitScript(() => {
            Object.defineProperty(window, "__gumCalled", {
              value: false,
              writable: true,
            });
            const md = navigator.mediaDevices;
            if (md) {
              const orig = md.getUserMedia.bind(md);
              md.getUserMedia = async (constraints) => {
                (window as unknown as { __gumCalled: boolean }).__gumCalled =
                  true;
                return orig(constraints);
              };
            }
          });
          await guest.setViewportSize({ width: 360, height: 740 });
          await openRecordLink(guest, room.guest.token);
          // The sheet opens before the room's first frames arrive; a name typed
          // now must survive them.
          const allow = guest.getByRole("button", { name: "Allow microphone" });
          await expect(allow).toBeVisible();
          await fillDisplayNameField(guest, "Ava");
          releaseRoomFrames();
          await expect(joinNameField(guest)).toHaveValue("Ava");
          const sheetControls = await guest
            .locator(".sys-join-sheet .ui-control")
            .evaluateAll((elements) =>
              elements.map((element) => element.getBoundingClientRect().height),
            );
          expect(sheetControls.length).toBeGreaterThan(0);
          for (const height of sheetControls)
            expect(height).toBeGreaterThanOrEqual(TOUCH_MIN);
          const join = guest.getByRole("button", { name: "Join and record" });
          await expect(
            roomDlg.getByText("Ava", { exact: true }).first(),
          ).toBeVisible();
          await expect(
            roomDlg.getByRole("button", { name: "Record", exact: true }),
          ).toBeDisabled();
          await expect(join).toBeDisabled();
          expect(
            await guest.evaluate(
              () =>
                (window as unknown as { __gumCalled?: boolean }).__gumCalled,
            ),
          ).toBe(false);
          await allow.click();
          await expect(guest.locator(".sys-join-meter")).toBeAttached();
          await expect(join).toBeDisabled();
          const headphones = guest.getByRole("button", {
            name: "I'm wearing headphones",
          });
          await headphones.click();
          await expect(headphones).toHaveAttribute("aria-pressed", "true");
          await expect(join).toBeEnabled();
          await join.click();
          await expect(join).toBeHidden();
          await expect(roomPill(guest)).toHaveText(/^Waiting for .+ to start$/);
          await expect(roomTile(guest, "Ava")).toBeVisible();
          await expect(
            roomDlg.getByRole("button", { name: "Record", exact: true }),
          ).toBeEnabled();

          await markSharecutE2e(producer);
          await producer.addInitScript(() => {
            Object.defineProperty(window, "__gumCalled", {
              value: false,
              writable: true,
            });
            const md = navigator.mediaDevices;
            if (md) {
              const orig = md.getUserMedia.bind(md);
              md.getUserMedia = async (constraints) => {
                (window as unknown as { __gumCalled: boolean }).__gumCalled =
                  true;
                return orig(constraints);
              };
            }
          });
          await openRecordLink(producer, room.producer.token);
          await expect(
            producer.getByRole("button", { name: "Join to listen" }),
          ).toBeVisible();
          await expect(
            producer.getByRole("button", { name: "Allow microphone" }),
          ).toHaveCount(0);
          await fillDisplayNameField(producer, "Pat");
          await producer
            .getByRole("button", { name: "Join to listen" })
            .click();
          await expect(roomPill(producer)).toHaveText(
            /^Waiting for .+ to start$/,
          );
          await expect(
            host.getByRole("list", { name: "Listening" }).getByText("Pat"),
          ).toBeVisible();
          const gumCalled = await producer.evaluate(
            () => (window as unknown as { __gumCalled?: boolean }).__gumCalled,
          );
          expect(gumCalled).toBe(false);
          await expect(
            roomDlg.getByRole("button", { name: "Record", exact: true }),
          ).toBeEnabled();
          await expect(guest.getByText("Hearing the room.")).toBeVisible({
            timeout: 15_000,
          });
          await expect
            .poll(async () =>
              guest.evaluate(
                () =>
                  (window as unknown as { __recordSignalCount?: number })
                    .__recordSignalCount ?? 0,
              ),
            )
            .toBeGreaterThan(0);
          await expect(producer.getByText("Hearing the room.")).toBeVisible({
            timeout: 30_000,
          });
          await expect(roomDlg.getByText("Hearing the room.")).toBeVisible({
            timeout: 15_000,
          });

          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Record", exact: true }),
            projectPath,
            "Start",
            "recording",
          );
          await expect(
            roomDlg.getByText(/^\d+:\d{2} · Take \d+$/),
          ).toBeVisible();
          await expect(roomPill(guest)).toHaveText(LIVE_PILL);
          await expect(roomPill(producer)).toHaveText(LIVE_PILL);
          await expect(
            guest.getByText("Recording in full quality on this device."),
          ).toBeVisible();
          await expect(guest.getByText("Hearing the room.")).toBeVisible();
          await expect(producer.getByText("Hearing the room.")).toBeVisible();
          await expect(roomDlg.getByText("Hearing the room.")).toBeVisible();
          await expect(
            roomDlg.getByText("Recording in full quality on this device."),
          ).toBeVisible();
          for (const page of [host, guest]) {
            expect(await beforeUnloadIsBlocked(page)).toBe(true);
          }
          const guestUrl = guest.url();
          const unloadDialog = guest.waitForEvent("dialog");
          const reload = guest
            .evaluate(() => window.location.reload())
            .catch(() => {});
          const dialog = await unloadDialog;
          expect(dialog.type()).toBe("beforeunload");
          await dialog.dismiss();
          await reload;
          expect(guest.url()).toBe(guestUrl);
          await expect(roomPill(guest)).toHaveText(LIVE_PILL);
          await expect(
            guest.getByText("Recording in full quality on this device."),
          ).toBeVisible();
          await expect(
            producer.getByText("Recording in full quality on this device."),
          ).toHaveCount(0);
          await expect
            .poll(async () => roomPill(guest).innerText(), {
              timeout: 8_000,
            })
            .not.toBe("0:00 · Take 1");

          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Pause take", exact: true }),
            projectPath,
            "Pause",
            "paused",
          );
          await expect(roomPill(guest)).toHaveText(/^Paused · \d+:\d{2}$/);
          await expect.poll(() => beforeUnloadIsBlocked(guest)).toBe(false);
          await expect(guest.getByText("Hearing the room.")).toBeVisible();
          await expect
            .poll(async () => keeperWavBytes(guest), { timeout: 8_000 })
            .toBeGreaterThanOrEqual(44);
          await clickHostTransport(
            host,
            roomDlg.getByRole("button", {
              name: "Resume recording",
              exact: true,
            }),
            projectPath,
            "Resume",
            "recording",
          );
          await expect(roomPill(guest)).toHaveText(LIVE_PILL);
          await expect(guest.getByText("Hearing the room.")).toBeVisible();
          await stopHostTake(host, roomDlg, projectPath);
          await expect(roomPill(guest)).toHaveText(SAVING_OR_SAVED_PILL);

          await expect.poll(() => beforeUnloadIsBlocked(guest)).toBe(false);
          const unexpectedUnloadDialog = guest
            .waitForEvent("dialog", { timeout: 1_000 })
            .then(() => true)
            .catch(() => false);
          await guest.reload();
          expect(await unexpectedUnloadDialog).toBe(false);
          // Consent lives in the room, so a guest back after Stop sees the
          // saved take, not the Join sheet.
          await expect(roomPill(guest)).toHaveText("Saved", {
            timeout: 30_000,
          });
          await expect(
            guest.getByRole("button", { name: "Join and record" }),
          ).toHaveCount(0);
          await expectSurfaceAxeClean(guest, "body");
          await expectSurfaceAxeClean(producer, "body");
        },
      );
    });
  });

  test("guest cannot join after mic loss and can reconnect", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      const hostCtx = await browser.newContext();
      const guestCtx = await browser.newContext();
      const host = await hostCtx.newPage();
      const guest = await guestCtx.newPage();
      try {
        await markSharecutE2e(host);
        await openProject(host, projectPath, { query: "&e2e=1" });
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        await markSharecutE2e(guest);
        await guest.addInitScript(() => {
          const devices = navigator.mediaDevices;
          const original = devices.getUserMedia.bind(devices);
          devices.getUserMedia = async (constraints) => {
            const stream = await original(constraints);
            (
              window as unknown as { __testMicTrack?: MediaStreamTrack }
            ).__testMicTrack = stream.getAudioTracks()[0];
            return stream;
          };
        });
        await openRecordLink(guest, room.guest.token);
        await fillDisplayNameField(guest, "Ava");
        await guest.getByRole("button", { name: "Allow microphone" }).click();
        await guest
          .getByRole("button", { name: "I'm wearing headphones" })
          .click();
        const join = guest.getByRole("button", { name: "Join and record" });
        await expect(join).toBeEnabled();

        await guest.evaluate(() => {
          const track = (
            window as unknown as { __testMicTrack?: MediaStreamTrack }
          ).__testMicTrack;
          if (!track) {
            throw new Error("microphone track was not captured");
          }
          track.stop();
          // Browser stop() is intentional and does not itself emit ended.
          track.dispatchEvent(new Event("ended"));
        });
        await expect(
          guest.getByText("Your microphone isn't available.", { exact: true }),
        ).toBeVisible();
        await expect(
          guest.getByText("Microphone disconnected.", { exact: true }),
        ).toBeVisible();
        await expect(join).toBeDisabled();
        await guest.getByRole("button", { name: "Retry microphone" }).click();
        await expect(join).toBeEnabled();
      } finally {
        await hostCtx.close();
        await guestCtx.close();
      }
    });
  });

  test("host sees mic loss after closing the active record room", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        await markSharecutE2e(host);
        await host.addInitScript(() => {
          const original = navigator.mediaDevices.getUserMedia.bind(
            navigator.mediaDevices,
          );
          navigator.mediaDevices.getUserMedia = async (constraints) => {
            if (
              (window as unknown as { __denyHostRetry?: boolean })
                .__denyHostRetry
            ) {
              (
                window as unknown as { __denyHostRetry?: boolean }
              ).__denyHostRetry = false;
              throw new DOMException("Permission denied", "NotAllowedError");
            }
            const stream = await original(constraints);
            (
              window as unknown as { __testHostMicTrack?: MediaStreamTrack }
            ).__testHostMicTrack = stream.getAudioTracks()[0];
            return stream;
          };
        });
        await openProject(host, projectPath, { query: "&e2e=1" });
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        const roomDlg = await openHostRecordRoom(host);

        await markSharecutE2e(guest);
        await joinAsGuest(guest, room.guest.token, "Ava");
        await expect(
          roomDlg.getByRole("button", { name: "Record", exact: true }),
        ).toBeEnabled();
        await clickHostTransport(
          host,
          roomDlg.getByRole("button", { name: "Record", exact: true }),
          projectPath,
          "Start",
          "recording",
        );
        await expect(
          roomDlg.getByText("Recording in full quality on this device."),
        ).toBeVisible();
        await goToStage(host, "edit");
        await expect(roomDlg).toBeHidden();
        // The Stage bar's Record tab carries the live pill while a take is on.
        const recTab = stageTab(host, "record");
        await expect(recTab).toHaveAccessibleName(/^Record Live\b/);
        await expect(recTab.locator(".sys-stage-badge--pill")).toBeVisible();
        await host.setViewportSize({ width: 390, height: 844 });
        await expect(recTab).toHaveAccessibleName(/^Record Live\b/);
        await expect(recTab.locator(".sys-stage-badge--pill")).toBeVisible();
        await phone.showTimeline(host);
        for (const width of [390, 320]) {
          await host.setViewportSize({ width, height: 844 });
          // The header folds Invite and Palette into More once it measures the
          // narrower width; collect the controls only after that has settled.
          const header = host.locator(".stage-frame-header");
          if (width === 320) {
            await expect(
              header.getByRole("button", { name: "More", exact: true }),
            ).toBeVisible();
            await expect(
              header.getByRole("button", { name: "Invite", exact: true }),
            ).toHaveCount(0);
            await expect(
              header.getByRole("button", { name: "Palette", exact: true }),
            ).toHaveCount(0);
          }
          // On a phone the header's Stage bar gives way to the tab bar and the
          // Player bar hides its skip buttons, so neither has a box here; the
          // tab bar's own tabs are checked instead.
          const controls = host.locator(
            ".stage-frame-header button:not([role='tab']), .stage-frame-player button:not(.sys-player-skip), .stage-frame-tabs button",
          );
          for (const control of await controls.all()) {
            const bounds = await control.boundingBox();
            expect(
              bounds,
              (await control.getAttribute("aria-label")) ??
                "header or Player control",
            ).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          }
        }

        await host.evaluate(() => {
          (window as unknown as { __denyHostRetry?: boolean }).__denyHostRetry =
            true;
          const track = (
            window as unknown as { __testHostMicTrack?: MediaStreamTrack }
          ).__testHostMicTrack;
          if (!track) {
            throw new Error("host microphone track was not captured");
          }
          track.stop();
          track.dispatchEvent(new Event("ended"));
        });
        await expect(recTab.locator(".sys-stage-badge")).toBeVisible();
        await goToStage(host, "record");
        // Record's alerts show in the frame alert slot, above the stage.
        const alert = roomAlertSlot(host);
        await expect(alert.getByText("Your mic stopped.")).toBeVisible();
        await alert.getByRole("button", { name: "Reconnect mic" }).click();
        await expect(
          roomDlg.getByText(/Microphone is blocked for this site/),
        ).toBeVisible();
        await alert.getByRole("button", { name: "Reconnect mic" }).click();
        await expect(alert.getByText("Your mic stopped.")).toBeHidden();
        await expect(
          roomDlg.getByText(/Microphone is blocked for this site/),
        ).toBeHidden();
      });
    });
  });

  test("guest room reflects mic loss, retry, recovery, and Stop", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        await markSharecutE2e(host);
        await openProject(host, projectPath, { query: "&e2e=1" });
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        const roomDlg = await openHostRecordRoom(host);

        await markSharecutE2e(guest);
        await guest.addInitScript(() => {
          const original = navigator.mediaDevices.getUserMedia.bind(
            navigator.mediaDevices,
          );
          navigator.mediaDevices.getUserMedia = async (constraints) => {
            const state = window as unknown as {
              __denyGuestRetry?: boolean;
              __releaseGuestRetry?: () => void;
              __testGuestMicTrack?: MediaStreamTrack;
            };
            if (state.__denyGuestRetry) {
              state.__denyGuestRetry = false;
              return new Promise<MediaStream>((_resolve, reject) => {
                state.__releaseGuestRetry = () =>
                  reject(
                    new DOMException("Permission denied", "NotAllowedError"),
                  );
              });
            }
            const stream = await original(constraints);
            state.__testGuestMicTrack = stream.getAudioTracks()[0];
            return stream;
          };
        });
        await joinAsGuest(guest, room.guest.token, "Ava");
        await expect(
          roomDlg.getByRole("button", { name: "Record", exact: true }),
        ).toBeEnabled();
        await clickHostTransport(
          host,
          roomDlg.getByRole("button", { name: "Record", exact: true }),
          projectPath,
          "Start",
          "recording",
        );
        await expect(roomPill(guest)).toHaveText(LIVE_PILL);
        const micLost = guest.getByText("Your mic stopped.");
        await expect(micLost).toBeHidden();

        await guest.evaluate(() => {
          const state = window as unknown as {
            __denyGuestRetry?: boolean;
            __testGuestMicTrack?: MediaStreamTrack;
          };
          state.__denyGuestRetry = true;
          const track = state.__testGuestMicTrack;
          if (!track) {
            throw new Error("guest microphone track was not captured");
          }
          track.stop();
          track.dispatchEvent(new Event("ended"));
        });
        await expect(micLost).toBeVisible();
        const reconnect = guest.getByRole("button", { name: "Reconnect mic" });
        await reconnect.click();
        // The request is pending until the page releases it; the alert stays.
        await expect(micLost).toBeVisible();
        await guest.evaluate(() => {
          const release = (
            window as unknown as { __releaseGuestRetry?: () => void }
          ).__releaseGuestRetry;
          if (!release) {
            throw new Error("guest retry did not request the microphone");
          }
          release();
        });
        await expect(micLost).toBeVisible();
        await reconnect.click();
        await expect(micLost).toBeHidden({ timeout: 5_000 });
        await expect(roomPill(guest)).toHaveText(LIVE_PILL);

        await stopHostTake(host, roomDlg, projectPath);
        await expect(roomPill(guest)).toHaveText(SAVING_OR_SAVED_PILL);
      });
    });
  });

  test("guest keeper survives a closed tab and offers Recover partial take", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        await markSharecutE2e(host);
        await openProject(host, projectPath, { query: "&e2e=1" });
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        const roomDlg = await openHostRecordRoom(host);

        await markSharecutE2e(guest);
        await joinAsGuest(guest, room.guest.token, "Ava");
        await expect(
          roomDlg.getByRole("button", { name: "Record", exact: true }),
        ).toBeEnabled();
        await clickHostTransport(
          host,
          roomDlg.getByRole("button", { name: "Record", exact: true }),
          projectPath,
          "Start",
          "recording",
        );
        await expect(roomPill(guest)).toHaveText(LIVE_PILL);
        // Wait for about 1.5 s of PCM written in place before killing the tab;
        // this clears the 1 s post-kill check without waiting on a later flush.
        await expect
          .poll(async () => keeperWavBytes(guest), { timeout: 15_000 })
          .toBeGreaterThan(
            PCM_WAV_HEADER_BYTES + 1.5 * ONE_SECOND_KEEPER_PCM_BYTES,
          );

        // Tear the page and its writer worker down with no keeper close.
        const ctx = guest.context();
        await guest.close({ runBeforeUnload: false });

        await stopHostTake(host, roomDlg, projectPath);

        const reopened = await ctx.newPage();
        await markSharecutE2e(reopened);
        await openRecordLink(reopened, room.guest.token);
        // More than 1 s of committed PCM; on main the swap file is discarded.
        await expect
          .poll(async () => keeperWavBytes(reopened), { timeout: 15_000 })
          .toBeGreaterThan(ONE_SECOND_KEEPER_WAV_BYTES);
        const recover = reopened.getByRole("button", { name: "Finish saving" });
        await expect(recover).toBeVisible({ timeout: 15_000 });
        await recover.click();
        await expect(recover).toBeHidden({ timeout: 15_000 });
        await expect(roomPill(reopened)).toHaveText("Saved", {
          timeout: 30_000,
        });
      });
    });
  });

  test("guest Retry recovers from a denied microphone", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        const project = encodeURIComponent(projectPath);
        const guestToken =
          await test.step("create recording room", async () => {
            await markSharecutE2e(host);
            await host.goto(`/?project=${project}&e2e=1`);
            await expect(host.getByRole("heading", { level: 1 })).toBeVisible({
              timeout: 15_000,
            });
            const room = await createRecordRoom(host, projectPath);
            return room.guest.token;
          });
        await test.step("open guest with one denied microphone request", async () => {
          await markSharecutE2e(guest);
          await guest.addInitScript(() => {
            let deniedOnce = true;
            const md = navigator.mediaDevices;
            if (!md) {
              return;
            }
            const orig = md.getUserMedia.bind(md);
            md.getUserMedia = async (constraints) => {
              if (deniedOnce) {
                deniedOnce = false;
                throw new DOMException("Permission denied", "NotAllowedError");
              }
              return orig(constraints);
            };
          });
          await openRecordLink(guest, guestToken);
          await expect(
            guest.getByRole("button", { name: "Allow microphone" }),
          ).toBeVisible({ timeout: 15_000 });
        });
        await test.step("show the denied microphone recovery", async () => {
          await fillDisplayNameField(guest, "Ava");
          await guest
            .getByRole("button", { name: "Allow microphone" })
            .click({ timeout: 15_000 });
          await expect(
            guest.locator(".sys-status-title", {
              hasText: "Microphone blocked",
            }),
          ).toBeVisible({
            timeout: 15_000,
          });
          await expect(
            guest.getByText(/Microphone is blocked for this site/),
          ).toBeVisible({ timeout: 15_000 });
          await expect(
            guest.getByRole("button", { name: "Join and record" }),
          ).toBeDisabled();
        });
        await test.step("retry the microphone and enable joining", async () => {
          await guest
            .getByRole("button", { name: "How to allow the microphone" })
            .click({ timeout: 15_000 });
          await expect(guest.locator(".sys-join-meter")).toBeAttached({
            timeout: 15_000,
          });
          await guest
            .getByRole("button", { name: "I'm wearing headphones" })
            .click();
          await expect(
            guest.getByRole("button", { name: "Join and record" }),
          ).toBeEnabled({ timeout: 15_000 });
        });
      });
    });
  });

  test("desktop host sees operating-system recovery after microphone denial", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      const hostCtx = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      });
      const host = await hostCtx.newPage();
      try {
        await markSharecutE2e(host);
        await host.addInitScript(() => {
          (
            window as Window & { __TAURI_INTERNALS__?: object }
          ).__TAURI_INTERNALS__ = {};
          let deniedOnce = true;
          const md = navigator.mediaDevices;
          if (!md) {
            return;
          }
          const orig = md.getUserMedia.bind(md);
          md.getUserMedia = async (constraints) => {
            if (deniedOnce) {
              deniedOnce = false;
              throw new DOMException("Permission denied", "NotAllowedError");
            }
            return orig(constraints);
          };
        });
        await openProject(host, projectPath, { query: "&e2e=1" });
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        await createRecordRoom(host, projectPath);

        const room = await openHostRecordRoom(host);
        await expect(
          room.getByText(
            /Microphone access is blocked by your operating system/,
          ),
        ).toBeVisible();
        await room.getByRole("button", { name: "Retry" }).click();
        await expect(
          room.getByText(
            /Microphone access is blocked by your operating system/,
          ),
        ).toHaveCount(0);
        await expect(
          (await openHostDevices(room)).getByRole("button", {
            name: "Record 1 minute of room tone",
          }),
        ).toBeEnabled();
      } finally {
        await hostCtx.close();
      }
    });
  });

  test("guest captures the room tone the host starts", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        const project = encodeURIComponent(projectPath);
        await markSharecutE2e(host);
        await host.goto(`/?project=${project}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        await markSharecutE2e(guest);
        await enableRoomTonePcmHarness(guest);
        await joinAsGuest(guest, room.guest.token, "Ava");

        // The minute goes up as two parts; the second one carries the file ack.
        const roomToneUpload = guest.waitForResponse(async (response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.pathname.includes("/api/rec/") &&
            url.pathname.endsWith("/upload") &&
            url.searchParams.get("kind") === "room_tone" &&
            ((await response.json()) as { file_ack?: boolean }).file_ack ===
              true
          );
        });
        const started = await host.request.post("/api/record/command", {
          data: {
            path: projectPath,
            command_type: "RoomToneCountdown",
            payload: {},
          },
        });
        expect(started.ok(), await started.text()).toBeTruthy();
        const roomToneResponse = await roomToneUpload;
        expect(
          roomToneResponse.ok(),
          await roomToneResponse.text(),
        ).toBeTruthy();
        expect(
          (await roomToneResponse.json()) as { file_ack?: boolean },
        ).toMatchObject({ file_ack: true });
        await expect
          .poll(() => roomToneWav(guest))
          .toEqual({
            header: [82, 73, 70, 70, 36, 228, 87, 0, 87, 65, 86, 69],
            size: 5_760_044,
          });
      });
    });
  });

  test("records a remote interview end to end (US-1)", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [{}, {}, {}],
        async ([host, guest, producer]) => {
          const project = encodeURIComponent(projectPath);
          await markSharecutE2e(host);
          await host.goto(`/?project=${project}&e2e=1`);
          await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
          const room = await createRecordRoom(host, projectPath);
          const roomDlg = await openHostRecordRoom(host);

          await markSharecutE2e(guest);
          await joinAsGuest(guest, room.guest.token, "Ava");

          await markSharecutE2e(producer);
          await joinAsProducer(producer, room.producer.token, "Pat");

          const startBtn = roomDlg.getByRole("button", {
            name: "Record",
            exact: true,
          });
          await expect(startBtn).toBeEnabled();
          await clickHostTransport(
            host,
            startBtn,
            projectPath,
            "Start",
            "recording",
          );
          await expect(roomPill(guest)).toHaveText(LIVE_PILL);
          await expect(
            guest.getByText("Recording in full quality on this device."),
          ).toBeVisible();
          await expect(producer.getByText("Hearing the room.")).toBeVisible({
            timeout: 15_000,
          });

          // The Notes rail's list, not the live region that also reads new notes out.
          const notesOf = (scope: Page) =>
            scope
              .getByRole("region", { name: "Notes", exact: true })
              .getByRole("listitem");
          const noteWith = (scope: Page, text: string) =>
            notesOf(scope).filter({ hasText: text });
          const addNote = async (scope: Page, text: string) => {
            await scope.getByRole("textbox", { name: "Add a note" }).fill(text);
            await scope.getByRole("button", { name: "Send note" }).click();
          };
          await openRoomNotes(guest);
          await guest.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
          });
          await expect
            .poll(() =>
              guest.evaluate(() => document.activeElement === document.body),
            )
            .toBe(true);
          const markerFrom = (await hostRecordSnapshot(host, projectPath))
            .recording_ms;
          await guest.keyboard.press("m");
          await expect(noteWith(guest, "Marker")).toBeVisible();
          const markerTo = (await hostRecordSnapshot(host, projectPath))
            .recording_ms;
          const noteFrom = (await hostRecordSnapshot(host, projectPath))
            .recording_ms;
          await addNote(guest, "Great answer");
          await expect(noteWith(guest, "Great answer")).toBeVisible();
          const noteTo = (await hostRecordSnapshot(host, projectPath))
            .recording_ms;
          await openRoomNotes(producer);
          const producerFrom = (await hostRecordSnapshot(host, projectPath))
            .recording_ms;
          await addNote(producer, "Producer note");
          await expect(noteWith(producer, "Producer note")).toBeVisible();
          const producerTo = (await hostRecordSnapshot(host, projectPath))
            .recording_ms;

          const hostNote = (text: string) =>
            roomDlg
              .getByRole("region", { name: "Notes" })
              .getByRole("listitem")
              .filter({ hasText: text });
          await expect(hostNote("Marker")).toBeVisible();
          await expect(hostNote("Great answer")).toBeVisible();
          await expect(hostNote("Producer note")).toBeVisible();
          await expect(noteWith(producer, "Marker")).toBeVisible();
          await expect(notesOf(guest).getByText(/Producer note/)).toHaveCount(
            0,
          );

          await expect
            .poll(() => keeperWavBytes(guest), { timeout: 30_000 })
            .toBeGreaterThan(ONE_SECOND_KEEPER_WAV_BYTES);

          await stopHostTake(host, roomDlg, projectPath);
          await expect(roomPill(guest)).toHaveText(SAVING_OR_SAVED_PILL);
          const guestId = await recordParticipantId(host, projectPath, "Ava");
          const producerId = await recordParticipantId(
            host,
            projectPath,
            "Pat",
          );

          await waitForSegmentsAcked(host, projectPath, [
            guestId,
            HOST_PARTICIPANT_ID,
          ]);
          await expect(
            guest.getByRole("button", { name: "Done" }),
          ).toBeVisible();

          // Producers never open a local keeper, so the recordings dir never exists.
          expect(await recordingWavs(producer)).toBeNull();
          const uploads = await host.request.get("/api/record/upload", {
            params: { path: projectPath },
          });
          expect(uploads.ok(), await uploads.text()).toBeTruthy();
          const uploadRows = (await uploads.json()) as {
            segments?: Array<{ participant_id?: string }>;
            room_tone_status?: Array<{ participant_id?: string }>;
          };
          expect(
            [
              ...(uploadRows.segments ?? []),
              ...(uploadRows.room_tone_status ?? []),
            ].filter((row) => row.participant_id === producerId),
          ).toEqual([]);

          await waitForTakeLanded(host, projectPath);
          await expect(roomPill(guest)).toHaveText("Saved", {
            timeout: 30_000,
          });
          await expect(
            producer.getByText(/Saving to project|Saved to project/),
          ).toHaveCount(0);

          await expect
            .poll(
              async () =>
                ((await readSavedProject(projectPath)).review?.comments ?? [])
                  .map((comment) => comment.body)
                  .sort(),
              { timeout: 15_000 },
            )
            .toEqual(["Great answer", "Marker", "Producer note"]);
          // Host keeper source ids are rec-<session>-<take>-<participant>-<segment>.
          const hostSourcePrefix = `rec-${room.session_id}-0-${HOST_PARTICIPANT_ID}-`;
          await expect
            .poll(
              async () =>
                (await readSavedProject(projectPath)).timeline.clips.filter(
                  (c) => c.source_id?.startsWith(hostSourcePrefix) ?? false,
                ).length,
              { timeout: 15_000 },
            )
            .toBeGreaterThan(0);
          const saved = await readSavedProject(projectPath);
          const ava = saved.timeline.tracks.find((t) => t.label === "Ava");
          expect(ava, "landed track for Ava").toBeTruthy();
          const avaClips = saved.timeline.clips.filter(
            (c) => c.track_id === ava?.id,
          );
          expect(avaClips.length).toBeGreaterThanOrEqual(1);
          const hostClips = saved.timeline.clips.filter(
            (c) => c.source_id?.startsWith(hostSourcePrefix) ?? false,
          );
          expect(hostClips.length).toBeGreaterThanOrEqual(1);
          for (const clip of [...avaClips, ...hostClips]) {
            const source = saved.sources.find(
              (src) => src.id === clip.source_id,
            );
            expect(source, `source ${clip.source_id}`).toBeTruthy();
            expect(source?.path).toMatch(/^raw\//);
            await access(
              path.join(path.dirname(projectPath), source?.path ?? ""),
            );
          }
          const byBody = (body: string) =>
            (saved.review?.comments ?? []).find((c) => c.body === body);
          expect(byBody("Marker")?.author).toBe(guestId);
          expect(byBody("Great answer")?.author).toBe(guestId);
          // The window is the host recording clock read before and after the press
          // (so it already widens with the measured round trip on a loaded runner),
          // plus the ±0.25 s landing contract from docs/recording-session.md.
          const sessionPrefix = `rec-${room.session_id}-`;
          const priorEnds = saved.timeline.clips
            .filter((c) => !(c.source_id ?? "").startsWith(sessionPrefix))
            .map((c) => c.timeline_start + c.source_end - c.source_start);
          const origin = priorEnds.length ? Math.max(...priorEnds) + 2 : 0;
          const landedNear = (body: string, fromMs: number, toMs: number) => {
            const comment = byBody(body);
            expect(comment, `review comment ${body}`).toBeTruthy();
            expect(comment?.timeline_start).toBeGreaterThanOrEqual(
              origin + fromMs / 1000 - 0.25,
            );
            expect(comment?.timeline_start).toBeLessThanOrEqual(
              origin + toMs / 1000 + 0.25,
            );
          };
          landedNear("Marker", markerFrom, markerTo);
          landedNear("Great answer", noteFrom, noteTo);
          landedNear("Producer note", producerFrom, producerTo);
          expect(
            byBody("Great answer")?.timeline_start ?? -1,
          ).toBeGreaterThanOrEqual(
            byBody("Marker")?.timeline_start ?? Number.POSITIVE_INFINITY,
          );
          expect(byBody("Producer note")?.author).toBe(producerId);

          // The landed take is a track on Edit.
          await goToStage(host, "edit");
          await expect(trackHeaderButton(host, "Ava")).toBeVisible();
          await openPanel(host, "comments");
          await expect(host.getByText("Great answer").first()).toBeVisible();
          await expect(host.getByText("Producer note").first()).toBeVisible();

          await keepTabOpen(guest);
          await expect(
            guest.getByText("Saved to project. You can close this page."),
          ).toBeVisible();
          await guest.getByRole("button", { name: "Done" }).click();
          await expect(guest.getByText("You left the room")).toBeVisible();
          await expect
            .poll(
              async () =>
                (await hostRecordSnapshot(host, projectPath)).participants.find(
                  (p) => p.participant_id === guestId,
                )?.connected,
              { timeout: 15_000 },
            )
            .toBe(false);
        },
      );
    });
  });
});

// 2.75rem is 44 px; a laid-out box can read a few millionths short in float.
const TOUCH_MIN = 43.99;

const PHONE_GUEST = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};

type JoinState =
  | "idle"
  | "prompting"
  | "denied"
  | "lost"
  | "ready"
  | "switching"
  | "storage";

const JOIN_STATES: JoinState[] = [
  "idle",
  "prompting",
  "denied",
  "lost",
  "ready",
  "switching",
  "storage",
];

type MicMode = "pass" | "hold" | "ask" | "deny";
type MicWindow = {
  __mic: {
    mode: MicMode;
    tracks: MediaStreamTrack[];
    denyAsked?: () => void;
  };
};

const joinPanel = (page: Page): Locator =>
  page.locator(".command-palette-panel.sys-join-dialog");

const micRowState = (page: Page, state: string): Locator =>
  page.locator(`[data-step="mic"] .sys-status[data-state="${state}"]`);

async function stubJoinDevices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as MicWindow;
    w.__mic = { mode: "pass", tracks: [] };
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints) => {
      if (w.__mic.mode === "deny") {
        throw new DOMException("Permission denied", "NotAllowedError");
      }
      if (w.__mic.mode === "hold") await new Promise<never>(() => {});
      if (w.__mic.mode === "ask") {
        await new Promise<never>((_, reject) => {
          w.__mic.denyAsked = () =>
            reject(new DOMException("Permission denied", "NotAllowedError"));
        });
      }
      const stream = await original(constraints);
      w.__mic.tracks.push(...stream.getAudioTracks());
      return stream;
    };
    if (sessionStorage.getItem("e2eStorage") === "blocked") {
      navigator.storage.getDirectory = async () => {
        throw new DOMException("blocked", "SecurityError");
      };
    }
  });
}

async function setMicMode(page: Page, mode: MicMode): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as MicWindow).__mic.mode = next;
  }, mode);
}

async function reachJoinState(
  page: Page,
  token: string,
  state: JoinState,
): Promise<void> {
  await page.goto(recordLinkPath(token));
  await page.evaluate((blocked) => {
    if (blocked) sessionStorage.setItem("e2eStorage", "blocked");
    else sessionStorage.removeItem("e2eStorage");
  }, state === "storage");
  await openRecordLink(page, token);
  await fillDisplayNameField(page, "Ava");
  const allow = page.getByRole("button", { name: "Allow microphone" });
  switch (state) {
    case "idle":
      await expect(allow).toBeVisible();
      break;
    case "prompting":
      await setMicMode(page, "hold");
      await allow.click();
      await expect(micRowState(page, "running")).toBeVisible();
      await expect(allow).toHaveAttribute("aria-busy", "true");
      break;
    case "denied":
      await setMicMode(page, "deny");
      await allow.click();
      await expect(micRowState(page, "needs-you")).toBeVisible();
      break;
    case "lost":
      await allow.click();
      await expect(page.locator(".sys-join-meter")).toBeAttached();
      await page.evaluate(() => {
        for (const track of (window as unknown as MicWindow).__mic.tracks) {
          track.stop();
          track.dispatchEvent(new Event("ended"));
        }
      });
      await expect(
        page.getByText("Your microphone isn't available.", { exact: true }),
      ).toBeVisible();
      break;
    case "ready":
      await allow.click();
      await expect(page.locator(".sys-join-meter")).toBeAttached();
      break;
    case "switching":
      await allow.click();
      await expect(page.locator(".sys-join-meter")).toBeAttached();
      await setMicMode(page, "hold");
      await page.getByRole("button", { name: /^Input:/ }).click();
      await page.getByRole("menuitemradio", { checked: false }).first().click();
      await expect(micRowState(page, "running")).toBeVisible();
      break;
    case "storage":
      await expect(page.locator('[data-step="storage"]')).toBeVisible();
      break;
  }
}

async function withJoinRoom(
  browser: Browser,
  guestOptions: BrowserContextOptions,
  run: (guest: Page, token: string) => Promise<void>,
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [{}, guestOptions],
      async ([host, guest]) => {
        await markSharecutE2e(host);
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        await markSharecutE2e(guest);
        await stubJoinDevices(guest);
        await run(guest, room.guest.token);
      },
    );
  });
}

async function settledPanel(page: Page): Promise<Locator> {
  const panel = joinPanel(page);
  await expect(panel).toBeVisible();
  await panel.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  return panel;
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return box;
}

test.describe("join sheet on a phone", () => {
  test("the name, microphone and headphones controls share one left edge", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(browser, PHONE_GUEST, async (guest, token) => {
      for (const state of JOIN_STATES) {
        for (const [width, expectedWidth] of [
          [390, 334],
          [320, 264],
        ] as const) {
          await reachJoinState(guest, token, state);
          await guest.setViewportSize({ width, height: 844 });
          const panel = joinPanel(guest);
          const edges = [
            await boxOf(panel.getByRole("textbox", { name: "Your name" })),
            await boxOf(
              panel.locator('[data-step="mic"] .sys-join-control > *').first(),
            ),
            await boxOf(
              panel
                .locator('[data-step="headphones"] .sys-join-control > *')
                .first(),
            ),
          ];
          const consentText = await boxOf(panel.locator(".sys-join-line"));
          const details = await boxOf(
            panel.getByRole("button", { name: "Details" }),
          );
          expect(details.x, `${state} at ${width} details`).toBeCloseTo(
            consentText.x,
            0,
          );
          for (const edge of edges) {
            expect(edge.x, `${state} at ${width}`).toBeCloseTo(28, 0);
            expect(edge.width, `${state} at ${width}`).toBeCloseTo(
              expectedWidth,
              0,
            );
          }
        }
      }
    });
  });

  test("every control in the Join sheet is 44 px or more in every mic state", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(browser, PHONE_GUEST, async (guest, token) => {
      for (const state of JOIN_STATES) {
        for (const width of [390, 320]) {
          await reachJoinState(guest, token, state);
          await guest.setViewportSize({ width, height: 844 });
          const sizes = await guest
            .locator(
              ".sys-join-dialog :is(button, input, [role=button], summary)",
            )
            .evaluateAll((elements) =>
              elements
                .map((element) => element.getBoundingClientRect())
                .filter((box) => box.width > 0 && box.height > 0)
                .map((box) => ({ width: box.width, height: box.height })),
            );
          expect(sizes.length, `${state} at ${width}`).toBeGreaterThan(0);
          for (const size of sizes) {
            expect(size.height, `${state} at ${width}`).toBeGreaterThanOrEqual(
              TOUCH_MIN,
            );
            expect(size.width, `${state} at ${width}`).toBeGreaterThanOrEqual(
              TOUCH_MIN,
            );
          }
        }
      }
    });
  });

  test("a touch phone opens on the name row and leaves the field unfocused", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(browser, PHONE_GUEST, async (guest, token) => {
      await openRecordLink(guest, token);
      await expect(joinNameField(guest)).toBeVisible();
      await expect
        .poll(() =>
          guest.evaluate(
            () => (document.activeElement as HTMLElement | null)?.dataset.step,
          ),
        )
        .toBe("name");
      await expect(joinNameField(guest)).not.toBeFocused();
    });
  });

  test("a mouse opens on the name field", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(
      browser,
      { viewport: { width: 390, height: 844 } },
      async (guest, token) => {
        await openRecordLink(guest, token);
        await expect(joinNameField(guest)).toBeFocused();
      },
    );
  });

  test("a return visit prefills the saved name and opens on Allow microphone", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(browser, PHONE_GUEST, async (guest, token) => {
      await guest.addInitScript(() => {
        localStorage.setItem("sharecut.recordName", "Ava Okafor");
      });
      await openRecordLink(guest, token);
      await expect(joinNameField(guest)).toHaveValue("Ava Okafor");
      await expect(
        guest.getByRole("button", { name: "Allow microphone" }),
      ).toBeFocused();
    });
  });

  test("a remembered name stays off the host's lobby until the guest presses Join", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [{}, PHONE_GUEST],
        async ([host, guest]) => {
          await markSharecutE2e(host);
          await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
          await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
          const room = await createRecordRoom(host, projectPath);
          const roomDlg = await openHostRecordRoom(host);
          await markSharecutE2e(guest);
          await stubJoinDevices(guest);
          await guest.addInitScript(() => {
            localStorage.setItem("sharecut.recordName", "Ava Okafor");
          });
          await openRecordLink(guest, room.guest.token);
          await expect(joinNameField(guest)).toHaveValue("Ava Okafor");
          await expect(roomDlg.getByText("Guest").first()).toBeVisible();
          await expect(roomDlg.getByText("Ava Okafor")).toHaveCount(0);
          await guest.getByRole("button", { name: "Allow microphone" }).click();
          await guest
            .getByRole("button", { name: "I'm wearing headphones" })
            .click();
          await expect(roomDlg.getByText("Ava Okafor")).toHaveCount(0);
          await guest.getByRole("button", { name: "Join and record" }).click();
          await expect(roomDlg.getByText("Ava Okafor").first()).toBeVisible();
        },
      );
    });
  });

  test("a denied prompt keeps focus on the mic action", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(browser, {}, async (guest, token) => {
      await guest.addInitScript(() => {
        localStorage.setItem("sharecut.recordName", "Ava Okafor");
      });
      await openRecordLink(guest, token);
      const allow = guest.getByRole("button", { name: "Allow microphone" });
      await expect(allow).toBeFocused();
      await setMicMode(guest, "ask");
      await guest.keyboard.press("Enter");
      await expect(micRowState(guest, "running")).toBeVisible();
      await expect(allow).toBeFocused();
      await guest.evaluate(() =>
        (window as unknown as MicWindow).__mic.denyAsked?.(),
      );
      await expect(
        guest.getByRole("button", { name: "How to allow the microphone" }),
      ).toBeFocused();
    });
  });

  test("one Close, a press beside the sheet keeps it, Escape declines", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(browser, PHONE_GUEST, async (guest, token) => {
      await openRecordLink(guest, token);
      const dialog = guest.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: /^Close/ })).toHaveCount(
        1,
      );
      await expect(
        dialog.getByRole("slider", { name: "Sheet height" }),
      ).toHaveCount(0);
      await guest.mouse.click(195, 40);
      await expect(dialog).toBeVisible();
      // Not now sends the decline over the room's socket; press again until
      // the room has registered this guest and answers.
      await expect(async () => {
        await guest.keyboard.press("Escape");
        await expect(guest.getByText("You're not being recorded.")).toBeVisible(
          { timeout: 2_000 },
        );
      }).toPass();
    });
  });

  test("the room shows above the sheet and Join and record sits in thumb reach", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(browser, PHONE_GUEST, async (guest, token) => {
      await openRecordLink(guest, token);
      await expect(roomPill(guest)).toBeVisible();
      const panel = await boxOf(await settledPanel(guest));
      const pill = await boxOf(roomPill(guest));
      expect(pill.y + pill.height).toBeLessThanOrEqual(panel.y);
      expect(panel.y).toBeGreaterThanOrEqual(100);
      expect(panel.y + panel.height).toBeCloseTo(844, 0);
      const join = await boxOf(
        guest.getByRole("button", { name: "Join and record" }),
      );
      expect(join.height).toBeCloseTo(52, 0);
      expect(join.y + join.height).toBeGreaterThanOrEqual(664);
    });
  });

  test("599 is a bottom sheet", async ({ browser }: { browser: Browser }) => {
    await withJoinRoom(
      browser,
      { viewport: { width: 599, height: 844 } },
      async (guest, token) => {
        await openRecordLink(guest, token);
        await expect(joinPanel(guest)).toBeVisible();
        const panel = await boxOf(await settledPanel(guest));
        expect(panel.width).toBeCloseTo(599, 0);
        expect(panel.x).toBeCloseTo(0, 0);
        expect(panel.y + panel.height).toBeCloseTo(844, 0);
      },
    );
  });

  test("600, 700 and 767 are a centred card over the visible room", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(
      browser,
      { viewport: { width: 600, height: 844 } },
      async (guest, token) => {
        await openRecordLink(guest, token);
        for (const [width, left] of [
          [600, 100],
          [700, 150],
          [767, 183.5],
        ] as const) {
          await guest.setViewportSize({ width, height: 844 });
          const panel = await boxOf(await settledPanel(guest));
          expect(panel.width, `${width}`).toBeCloseTo(400, 0);
          expect(panel.x, `${width}`).toBeCloseTo(left, 0);
          expect(width - (panel.x + panel.width), `${width}`).toBeCloseTo(
            left,
            0,
          );
          expect(panel.y, `${width}`).toBeCloseTo(96, 0);
          await expect(roomPill(guest)).toBeVisible();
        }
      },
    );
  });

  test("no horizontal scroll at 320", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(
      browser,
      { viewport: { width: 320, height: 844 } },
      async (guest, token) => {
        await openRecordLink(guest, token);
        await expect(joinPanel(guest)).toBeVisible();
        const scrollWidth = await guest.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(320);
      },
    );
  });

  test("the form is usable on a short or narrow phone", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    for (const [width, height] of [
      [320, 568],
      [667, 375],
      [844, 390],
    ] as const) {
      await withJoinRoom(
        browser,
        { ...PHONE_GUEST, viewport: { width, height } },
        async (guest, token) => {
          const where = `${width}x${height}`;
          await openRecordLink(guest, token);
          const panel = joinPanel(guest);
          const panelBox = await boxOf(await settledPanel(guest));
          expect(panelBox.x, where).toBeGreaterThanOrEqual(0);
          expect(panelBox.y, where).toBeGreaterThanOrEqual(0);
          expect(panelBox.x + panelBox.width, where).toBeLessThanOrEqual(
            width + 0.5,
          );
          expect(panelBox.y + panelBox.height, where).toBeLessThanOrEqual(
            height + 0.5,
          );
          expect(
            await guest.evaluate(() => document.documentElement.scrollWidth),
            where,
          ).toBeLessThanOrEqual(width);
          const ring = await guest.evaluate(() => {
            const row = document.activeElement as HTMLElement;
            const input = row.querySelector("input");
            const spread = /(\d+(?:\.\d+)?)px inset/.exec(
              getComputedStyle(row).boxShadow,
            );
            const rowBox = row.getBoundingClientRect();
            const inputBox = input?.getBoundingClientRect();
            return {
              isRow: row.dataset.step === "name",
              width: spread ? Number(spread[1]) : 0,
              rowTop: rowBox.top,
              rowBottom: rowBox.bottom,
              inputBottom: inputBox?.bottom ?? Number.NaN,
            };
          });
          expect(ring.isRow, `${where} ring`).toBe(true);
          expect(ring.width, `${where} ring`).toBeGreaterThan(0);
          expect(
            ring.inputBottom + ring.width,
            `${where} ring`,
          ).toBeLessThanOrEqual(ring.rowBottom + 0.01);
          expect(ring.rowTop, `${where} ring`).toBeGreaterThanOrEqual(
            panelBox.y - 0.5,
          );
          expect(ring.rowBottom, `${where} ring`).toBeLessThanOrEqual(
            panelBox.y + panelBox.height + 0.5,
          );
          const body = await boxOf(panel.locator(".command-palette-body"));
          expect(body.height, `${where} body`).toBeGreaterThanOrEqual(180);
          await joinNameField(guest).tap();
          await expect(joinNameField(guest)).toBeFocused();
          const field = await boxOf(joinNameField(guest));
          const panelNow = await boxOf(panel);
          expect(field.y, where).toBeGreaterThanOrEqual(
            Math.max(0, panelNow.y) - 0.5,
          );
          expect(field.y + field.height, where).toBeLessThanOrEqual(
            Math.min(height, panelNow.y + panelNow.height) + 0.5,
          );
          for (const name of ["Join and record", "Not now"]) {
            const control = panel.getByRole("button", { name });
            await control.scrollIntoViewIfNeeded();
            const box = await boxOf(control);
            expect(box.y, `${where} ${name}`).toBeGreaterThanOrEqual(-0.5);
            expect(box.y + box.height, `${where} ${name}`).toBeLessThanOrEqual(
              height + 0.5,
            );
            expect(box.height, `${where} ${name}`).toBeGreaterThanOrEqual(
              TOUCH_MIN,
            );
          }
        },
      );
    }
  });

  test("the consent sentence is never clipped and Details is in view beside Join and record", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [600, 900],
      [700, 900],
      [1280, 800],
      [667, 375],
    ] as const) {
      await withJoinRoom(
        browser,
        { ...PHONE_GUEST, viewport: { width, height } },
        async (guest, token) => {
          const where = `${width}x${height}`;
          await guest.addInitScript(() => {
            localStorage.setItem("sharecut.recordName", "Ava Okafor");
          });
          await openRecordLink(guest, token);
          const panel = await settledPanel(guest);
          const allow = panel.getByRole("button", { name: "Allow microphone" });
          const cut = await allow.evaluate((button) => {
            let scroller: HTMLElement | null = button.parentElement;
            while (
              scroller &&
              !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
            ) {
              scroller = scroller.parentElement;
            }
            const area = (scroller ?? document.body).getBoundingClientRect();
            const box = button.getBoundingClientRect();
            return box.top < area.bottom && box.bottom > area.bottom + 0.5;
          });
          if (height >= 500) {
            expect(
              cut,
              `${where} Allow microphone is not cut at first paint`,
            ).toBe(false);
          }
          const join = panel.getByRole("button", { name: "Join and record" });
          await join.scrollIntoViewIfNeeded();
          const line = panel.locator(".sys-join-line");
          const clipped = await line.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          );
          expect(clipped, `${where} consent text clipped`).toBe(0);
          const lineBox = await boxOf(line);
          expect(lineBox.y, where).toBeGreaterThanOrEqual(-0.5);
          expect(lineBox.y + lineBox.height, where).toBeLessThanOrEqual(
            (await boxOf(join)).y + 0.5,
          );
          const detailsLink = panel.getByRole("button", { name: "Details" });
          await expect(detailsLink).toBeVisible();
          const detailsBox = await boxOf(detailsLink);
          expect(detailsBox.y + detailsBox.height, where).toBeLessThanOrEqual(
            height + 0.5,
          );
          expect(detailsBox.y, where).toBeGreaterThanOrEqual(-0.5);
          const visibleHeight = await panel.evaluate((element) => {
            const owner = element.querySelector(".command-palette-body");
            const consent = element.querySelector(".sys-join-consent");
            const body = owner?.getBoundingClientRect();
            const box = consent?.getBoundingClientRect();
            return body && box ? box.top - body.bottom : 0;
          });
          expect(
            visibleHeight,
            `${where} consent sits below the body`,
          ).toBeGreaterThanOrEqual(-0.5);
        },
      );
    }
  });

  test("the whole form is in the body's view at first paint", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    for (const [width, height, touch] of [
      [1280, 800, false],
      [600, 900, false],
      [700, 900, false],
      [767, 900, false],
      [390, 844, true],
    ] as const) {
      await withJoinRoom(
        browser,
        { ...(touch ? PHONE_GUEST : {}), viewport: { width, height } },
        async (guest, token) => {
          const where = `${width}x${height}`;
          await openRecordLink(guest, token);
          const panel = await settledPanel(guest);
          const fit = await panel.evaluate((element) => {
            const body = element.querySelector(
              ".command-palette-body",
            ) as HTMLElement;
            const toggle = element.querySelector(
              '[data-step="headphones"] button',
            ) as HTMLElement;
            const view = body.getBoundingClientRect();
            const box = toggle.getBoundingClientRect();
            return {
              needed: body.scrollHeight,
              available: body.clientHeight,
              over: box.bottom - view.bottom,
            };
          });
          expect(
            fit.over,
            `${where} headphones button past the body's view (body needs ${fit.needed}, has ${fit.available})`,
          ).toBeLessThanOrEqual(0.5);
          expect(
            fit.needed - fit.available,
            `${where} body scrolls (needs ${fit.needed}, has ${fit.available})`,
          ).toBeLessThanOrEqual(0.5);
        },
      );
    }
  });

  test("a tapped name field is in view at 390x508", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withJoinRoom(
      browser,
      { ...PHONE_GUEST, viewport: { width: 390, height: 508 } },
      async (guest, token) => {
        await openRecordLink(guest, token);
        await joinNameField(guest).tap();
        await expect(joinNameField(guest)).toBeFocused();
        const field = await boxOf(joinNameField(guest));
        expect(field.y).toBeGreaterThanOrEqual(0);
        expect(field.y + field.height).toBeLessThanOrEqual(508);
      },
    );
  });
});
