import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import {
  createRecordRoom,
  markSharecutE2e,
  openRecordLink,
} from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { withBrowserPages } from "./twoBrowserPages";

async function hostRecordState(
  host: Page,
  projectPath: string,
): Promise<string> {
  const res = await host.request.get("/api/record/state", {
    params: { path: projectPath },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { state?: string };
  return body.state ?? "";
}

async function ensureHostRecordCommand(
  host: Page,
  projectPath: string,
  commandType: string,
  expectedState: string,
): Promise<void> {
  if ((await hostRecordState(host, projectPath)) === expectedState) {
    return;
  }
  const started = await host.request.post("/api/record/command", {
    data: { path: projectPath, command_type: commandType, payload: {} },
  });
  if (!started.ok()) {
    if ((await hostRecordState(host, projectPath)) === expectedState) {
      return;
    }
    expect(started.ok(), await started.text()).toBeTruthy();
  }
  await expect
    .poll(async () => hostRecordState(host, projectPath))
    .toBe(expectedState);
}

async function enableRoomTonePcmHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (
      window as unknown as { __SHARECUT_E2E_ROOM_TONE_PCM?: boolean }
    ).__SHARECUT_E2E_ROOM_TONE_PCM = true;
  });
}

async function clickHostTransport(
  host: Page,
  button: Locator,
  projectPath: string,
  commandType: string,
  expectedState: string,
): Promise<void> {
  const uiPost = host
    .waitForRequest(
      (req) =>
        req.method() === "POST" && req.url().includes("/api/record/command"),
      { timeout: 5_000 },
    )
    .catch(() => null);
  await button.click();
  if ((await hostRecordState(host, projectPath)) === expectedState) {
    return;
  }
  const fired = await uiPost;
  expect(
    fired,
    "host transport button did not POST /api/record/command",
  ).toBeTruthy();
  await ensureHostRecordCommand(host, projectPath, commandType, expectedState);
}

async function keeperWavBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      const rec = await root.getDirectoryHandle("Sharecut Recordings");
      let size = 0;
      const walk = async (dir: FileSystemDirectoryHandle) => {
        for await (const [, handle] of dir.entries()) {
          if (handle.kind === "file") {
            const file = await handle.getFile();
            if (file.name.endsWith(".wav") && file.size > size) {
              size = file.size;
            }
          } else if (handle.kind === "directory") {
            await walk(handle);
          }
        }
      };
      await walk(rec);
      return size;
    } catch {
      return 0;
    }
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
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const recordings = await root.getDirectoryHandle("Sharecut Recordings");
    const findRoomTone = async (
      dir: FileSystemDirectoryHandle,
      path = "",
    ): Promise<File | null> => {
      for await (const [name, handle] of dir.entries()) {
        const childPath = `${path}/${name}`;
        if (handle.kind === "file") {
          if (childPath.includes("/room-tone/") && name.endsWith(".wav")) {
            return handle.getFile();
          }
          continue;
        }
        const found = await findRoomTone(handle, childPath);
        if (found) {
          return found;
        }
      }
      return null;
    };
    const file = await findRoomTone(recordings);
    if (!file) {
      throw new Error("room-tone WAV was not saved in OPFS");
    }
    return {
      header: Array.from(new Uint8Array(await file.slice(0, 12).arrayBuffer())),
      size: file.size,
    };
  });
}

async function seedSparseRecoveryKeepers(
  page: Page,
  sessionId: string,
  takeIndex: number,
  participantId: string,
): Promise<void> {
  await page.evaluate(
    async ({ sessionId, takeIndex, participantId }) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of [
        "Sharecut Recordings",
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
    { sessionId, takeIndex, participantId },
  );
}

async function expectRecoveryDownloads(page: Page): Promise<void> {
  const downloads: Array<{ name: string; path: Promise<string> }> = [];
  page.on("download", (download) =>
    downloads.push({
      name: download.suggestedFilename(),
      path: download.path(),
    }),
  );
  await page.getByRole("button", { name: "Download local keeper" }).click();
  await expect.poll(() => downloads.length).toBe(1);
  expect(downloads[0]?.name).toMatch(/^keepers-p_.*\.zip$/);
  const archive = await readFile(await downloads[0]!.path);
  expect(archive.readUInt32LE(0)).toBe(0x0403_4b50);
  expect(archive.includes(Buffer.from("keeper-0-1-partial.wav"))).toBe(true);
  expect(archive.includes(Buffer.from("keeper-0-3-partial.wav"))).toBe(true);
  // Segment 0 is exported if still local or skipped if reclaimed after
  // landing; either way only the never-written segment 2 is missing.
  await expect(
    page.getByText(/Downloaded [23] local keeper copies; 1 missing segment /),
  ).toBeVisible();
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test.describe("record lobby", () => {
  test("host and guest can download surviving local keepers in Chromium", async ({
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
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        await markSharecutE2e(guest);
        await openRecordLink(guest, room.guest.token);
        await guest.getByLabel("Display name").fill("Ava");
        await guest.getByLabel("I am wearing headphones").check();
        await guest.getByRole("button", { name: "Allow microphone" }).click();
        await guest.getByRole("button", { name: "Skip" }).click();
        await guest.getByRole("button", { name: "Accept" }).click();
        await expect(guest.getByText("Waiting for host")).toBeVisible();
        await ensureHostRecordCommand(host, projectPath, "Start", "recording");
        await ensureHostRecordCommand(host, projectPath, "Stop", "stopped");
        await expect(guest.locator(".record-rec-label")).toHaveText("Stopped");

        const stateResponse = await host.request.get("/api/record/state", {
          params: { path: projectPath },
        });
        expect(stateResponse.ok(), await stateResponse.text()).toBeTruthy();
        const state = (await stateResponse.json()) as {
          session_id: string;
          take_index: number;
          participants: Array<{
            participant_id: string;
            display_name: string;
          }>;
        };
        const guestId = state.participants.find(
          (participant) => participant.display_name === "Ava",
        )?.participant_id;
        expect(guestId).toBeTruthy();
        await seedSparseRecoveryKeepers(
          guest,
          state.session_id,
          state.take_index,
          guestId!,
        );
        await seedSparseRecoveryKeepers(
          host,
          state.session_id,
          state.take_index,
          "p_host",
        );
        await guest.reload();
        await host.getByRole("button", { name: "Menu" }).click();
        await host.getByRole("menuitem", { name: "Record room…" }).click();
        await expectRecoveryDownloads(guest);
        await expectRecoveryDownloads(host);
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

          await host.getByRole("button", { name: "Menu" }).click();
          await host.getByRole("menuitem", { name: "Record room…" }).click();
          const roomDlg = host.getByRole("dialog", { name: "Record room" });
          await expect(roomDlg).toBeVisible();
          await expect(
            roomDlg.getByRole("button", { name: "Start", exact: true }),
          ).toBeDisabled();
          await expect(host.getByText("No one has joined")).toBeVisible();

          await markSharecutE2e(guest);
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
          await openRecordLink(guest, room.guest.token);
          await expect(
            guest.getByRole("heading", { name: "Join the recording" }),
          ).toBeVisible();
          await guest.getByLabel("Display name").fill("Ava");
          await guest.getByLabel("I am wearing headphones").check();
          await expect(
            guest.getByRole("heading", {
              name: "Record 3 seconds of room tone",
            }),
          ).toBeVisible();
          await expect(
            guest.getByText("Record or skip room tone before accepting."),
          ).toBeVisible();
          await expect(
            host.getByLabel("Recording").getByText("Ava", { exact: true }),
          ).toBeVisible();
          await expect(
            roomDlg.getByRole("button", { name: "Start", exact: true }),
          ).toBeDisabled();
          await expect(
            guest.getByRole("button", { name: "Accept" }),
          ).toBeDisabled();
          expect(
            await guest.evaluate(
              () =>
                (window as unknown as { __gumCalled?: boolean }).__gumCalled,
            ),
          ).toBe(false);
          await guest.getByRole("button", { name: "Allow microphone" }).click();
          await expect(guest.getByLabel("Level")).toBeVisible();
          await expect(guest.getByLabel("Input")).toBeVisible();
          await guest.getByRole("button", { name: "Skip" }).click();
          await expect(
            guest.getByRole("button", { name: "Accept" }),
          ).toBeEnabled();
          await guest.getByRole("button", { name: "Accept" }).click();
          await expect(guest.getByText("Waiting for host")).toBeVisible();
          await expect(host.getByText(/Ava · consented/)).toBeVisible();
          await expect(
            roomDlg.getByRole("button", { name: "Start", exact: true }),
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
            producer.getByRole("heading", { name: "Producer — not recorded" }),
          ).toBeVisible();
          await expect(
            producer.getByRole("heading", {
              name: "Record 3 seconds of room tone",
            }),
          ).toHaveCount(0);
          await producer.getByLabel("Display name").fill("Pat");
          await producer.getByRole("button", { name: "Join" }).click();
          await expect(producer.getByText("Waiting for host")).toBeVisible();
          await expect(
            host.getByRole("heading", { name: "Not recorded" }),
          ).toBeVisible();
          await expect(host.getByText("Pat", { exact: true })).toBeVisible();
          const gumCalled = await producer.evaluate(
            () => (window as unknown as { __gumCalled?: boolean }).__gumCalled,
          );
          expect(gumCalled).toBe(false);
          await expect(
            roomDlg.getByRole("button", { name: "Start", exact: true }),
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
            timeout: 15_000,
          });
          await expect(roomDlg.getByText("Hearing the room.")).toBeVisible({
            timeout: 15_000,
          });

          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Start", exact: true }),
            projectPath,
            "Start",
            "recording",
          );
          await expect(roomDlg.locator(".record-rec-label")).toHaveText("REC");
          await expect(guest.locator(".record-rec-label")).toHaveText("REC");
          await expect(producer.locator(".record-rec-label")).toHaveText("REC");
          await expect(
            guest.getByText("Recording locally on this device."),
          ).toBeVisible();
          await expect(guest.getByText("Hearing the room.")).toBeVisible();
          await expect(producer.getByText("Hearing the room.")).toBeVisible();
          await expect(roomDlg.getByText("Hearing the room.")).toBeVisible();
          await expect(
            roomDlg.getByText("Recording locally on this device."),
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
          await expect(guest.locator(".record-rec-label")).toHaveText("REC");
          await expect(
            guest.getByText("Recording locally on this device."),
          ).toBeVisible();
          await expect(
            producer.getByText("Recording locally on this device."),
          ).toHaveCount(0);
          await expect
            .poll(async () => guest.locator(".record-clock").innerText(), {
              timeout: 8_000,
            })
            .not.toBe("0:00");

          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Pause", exact: true }),
            projectPath,
            "Pause",
            "paused",
          );
          await expect(guest.locator(".record-rec-label")).toHaveText("PAUSED");
          await expect.poll(() => beforeUnloadIsBlocked(guest)).toBe(false);
          await expect(guest.getByText("Hearing the room.")).toBeVisible();
          await expect
            .poll(async () => keeperWavBytes(guest), { timeout: 8_000 })
            .toBeGreaterThanOrEqual(44);
          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Resume", exact: true }),
            projectPath,
            "Resume",
            "recording",
          );
          await expect(guest.locator(".record-rec-label")).toHaveText("REC");
          await expect(guest.getByText("Hearing the room.")).toBeVisible();
          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Stop", exact: true }),
            projectPath,
            "Stop",
            "stopped",
          );
          await expect(guest.locator(".record-rec-label")).toHaveText(
            "Stopped",
          );

          await expect.poll(() => beforeUnloadIsBlocked(guest)).toBe(false);
          const unexpectedUnloadDialog = guest
            .waitForEvent("dialog", { timeout: 1_000 })
            .then(() => true)
            .catch(() => false);
          await guest.reload();
          expect(await unexpectedUnloadDialog).toBe(false);
          await expect(guest.locator(".record-rec-label")).toHaveText(
            "Stopped",
          );
          await expect(
            guest.getByRole("button", { name: "Accept" }),
          ).toBeVisible();
          await expect(host.getByText(/Ava · consented/)).toHaveCount(0);
          await expect(
            roomDlg.getByRole("button", { name: "Start", exact: true }),
          ).toBeDisabled();

          // RecordApp changes views through FocusPull. Visible text assertions
          // can pass while the incoming view is still fading in over the outgoing
          // view, so wait for all transient layers to be removed before contrast.
          await expect(
            guest.locator(
              ".focus-pull-exit, .focus-pull-pending, .focus-pull-enter",
            ),
          ).toHaveCount(0);
          await expectReadingSurfaceAxeClean(guest);
          await expectReadingSurfaceAxeClean(producer);
        },
      );
    });
  });

  test("guest cannot accept after mic loss and can reconnect", async ({
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
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
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
        await guest.getByLabel("Display name").fill("Ava");
        await guest.getByLabel("I am wearing headphones").check();
        await guest.getByRole("button", { name: "Allow microphone" }).click();
        await expect(guest.getByLabel("Level")).toBeVisible();
        await guest.getByRole("button", { name: "Skip" }).click();
        await expect(
          guest.getByRole("button", { name: "Accept" }),
        ).toBeEnabled();

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
        await expect(guest.getByText("Microphone disconnected.")).toBeVisible();
        await expect(
          guest.getByRole("button", { name: "Accept" }),
        ).toBeDisabled();
        await guest.getByRole("button", { name: "Retry" }).click();
        await expect(
          guest.getByRole("button", { name: "Accept" }),
        ).toBeEnabled();
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
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        await host.getByRole("button", { name: "Menu" }).click();
        await host.getByRole("menuitem", { name: "Record room…" }).click();
        const roomDlg = host.getByRole("dialog", { name: "Record room" });
        await expect(roomDlg).toBeVisible();

        await markSharecutE2e(guest);
        await openRecordLink(guest, room.guest.token);
        await guest.getByLabel("Display name").fill("Ava");
        await guest.getByLabel("I am wearing headphones").check();
        await guest.getByRole("button", { name: "Allow microphone" }).click();
        await expect(guest.getByLabel("Level")).toBeVisible();
        await guest.getByRole("button", { name: "Skip" }).click();
        await guest.getByRole("button", { name: "Accept" }).click();
        await expect(
          roomDlg.getByRole("button", { name: "Start", exact: true }),
        ).toBeEnabled();
        await clickHostTransport(
          host,
          roomDlg.getByRole("button", { name: "Start", exact: true }),
          projectPath,
          "Start",
          "recording",
        );
        await expect(
          roomDlg.getByText("Recording locally on this device."),
        ).toBeVisible();
        await roomDlg
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(roomDlg).toBeHidden();
        const recChip = host.getByRole("button", {
          name: "Recording — open record panel",
        });
        await expect(recChip).toBeVisible();
        await expect(recChip.locator(".record-rec-dot")).toBeVisible();
        const contrast = await new AxeBuilder({ page: host })
          .include(".record-rec-chip")
          .withRules(["color-contrast"])
          .analyze();
        expect(contrast.violations).toEqual([]);
        await host.emulateMedia({ reducedMotion: "reduce" });
        await expect(recChip.locator(".record-rec-dot")).toHaveCSS(
          "animation-name",
          "none",
        );
        await host.setViewportSize({ width: 390, height: 844 });
        await expect(recChip).toBeVisible();
        await expect(recChip).toContainText(/REC.*\d+:\d\d/);
        await host.getByRole("button", { name: "Timeline" }).click();
        for (const width of [390, 320]) {
          await host.setViewportSize({ width, height: 844 });
          const controls = host.locator("header.transport button");
          for (const control of await controls.all()) {
            const bounds = await control.boundingBox();
            expect(
              bounds,
              (await control.getAttribute("aria-label")) ?? "transport control",
            ).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          }
          const chipBounds = await recChip.boundingBox();
          expect(chipBounds).not.toBeNull();
          expect(chipBounds!.x + chipBounds!.width).toBeLessThanOrEqual(width);
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
        await expect(roomDlg).toBeVisible();
        await expect(
          host.getByRole("button", {
            name: "Local capture failed — open record panel",
          }),
        ).toContainText("REC — local capture failed");
        await expect(
          host.locator(".record-rec-chip .record-rec-dot"),
        ).toHaveCount(0);
        await expect(
          roomDlg.getByText(
            "Microphone disconnected. Local recording is paused.",
          ),
        ).toBeVisible();
        await expect(
          roomDlg.getByRole("button", { name: "Close", exact: true }),
        ).toBeDisabled();
        await roomDlg
          .getByRole("button", { name: "Reconnect microphone" })
          .click();
        await expect(
          roomDlg.getByText(/Microphone is blocked for this site/),
        ).toBeVisible();
        await expect(
          roomDlg.getByRole("button", { name: "Close", exact: true }),
        ).toBeDisabled();
        await roomDlg
          .getByRole("button", { name: "Reconnect microphone" })
          .click();
        await expect(
          roomDlg.getByText(
            "Microphone disconnected. Local recording is paused.",
          ),
        ).toBeHidden();
        await expect(
          roomDlg.getByText(/Microphone is blocked for this site/),
        ).toBeHidden();
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
            guest.getByRole("heading", { name: "Join the recording" }),
          ).toBeVisible({ timeout: 15_000 });
        });
        await test.step("show the denied microphone recovery", async () => {
          await guest.getByLabel("Display name").fill("Ava");
          await guest.getByLabel("I am wearing headphones").check();
          await guest
            .getByRole("button", { name: "Allow microphone" })
            .click({ timeout: 15_000 });
          await expect(
            guest.getByText(/Microphone is blocked for this site/),
          ).toBeVisible({ timeout: 15_000 });
          await expect(
            guest.getByRole("button", { name: "Retry" }),
          ).toBeEnabled({ timeout: 15_000 });
        });
        await test.step("retry microphone and enter room-tone check", async () => {
          await guest
            .getByRole("button", { name: "Retry" })
            .click({ timeout: 15_000 });
          await expect(guest.getByLabel("Level")).toBeVisible({
            timeout: 15_000,
          });
        });
        await test.step("skip room tone and enable acceptance", async () => {
          await guest
            .getByRole("button", { name: "Skip" })
            .click({ timeout: 15_000 });
          await expect(
            guest.getByRole("button", { name: "Accept" }),
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
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        await createRecordRoom(host, projectPath);

        await host.getByRole("button", { name: "Menu" }).click();
        await host.getByRole("menuitem", { name: "Record room…" }).click();
        const room = host.getByRole("dialog", { name: "Record room" });
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
          room.getByRole("button", { name: "Record room tone" }),
        ).toBeEnabled();
      } finally {
        await hostCtx.close();
      }
    });
  });

  test("guest can record room tone then Accept", async ({
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
        await openRecordLink(guest, room.guest.token);
        await guest.getByLabel("Display name").fill("Ava");
        await guest.getByLabel("I am wearing headphones").check();
        await expect(
          guest.getByRole("button", { name: "Accept" }),
        ).toBeDisabled();
        await expect(
          guest.getByText("Record or skip room tone before accepting."),
        ).toBeVisible();
        await guest.getByRole("button", { name: "Allow microphone" }).click();
        await expect(guest.getByLabel("Level")).toBeVisible();
        await guest.getByRole("button", { name: "Record room tone" }).click();
        await expect(guest.getByText("Room tone saved")).toBeVisible({
          timeout: 15_000,
        });
        await expect
          .poll(() => roomToneWav(guest))
          .toEqual({
            header: [82, 73, 70, 70, 36, 101, 4, 0, 87, 65, 86, 69],
            size: 288_044,
          });
        await expect(
          guest.getByRole("button", { name: "Accept" }),
        ).toBeEnabled();
        const roomToneUpload = guest.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.pathname.includes("/api/rec/") &&
            url.pathname.endsWith("/upload") &&
            url.searchParams.get("kind") === "room_tone"
          );
        });
        const [roomToneResponse] = await Promise.all([
          roomToneUpload,
          guest.getByRole("button", { name: "Accept" }).click(),
        ]);
        expect(
          roomToneResponse.ok(),
          await roomToneResponse.text(),
        ).toBeTruthy();
        expect(
          (await roomToneResponse.json()) as { file_ack?: boolean },
        ).toMatchObject({ file_ack: true });
        await expect(guest.getByText("Waiting for host")).toBeVisible();
      });
    });
  });
});
