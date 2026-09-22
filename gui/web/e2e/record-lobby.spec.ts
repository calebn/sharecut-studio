import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
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

async function markSharecutE2e(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __SHARECUT_E2E?: boolean }).__SHARECUT_E2E = true;
  });
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

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test.describe("record lobby", () => {
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
          const created = await host.request.post("/api/shares/record", {
            data: { path: projectPath },
          });
          expect(created.ok(), await created.text()).toBeTruthy();
          const room = (await created.json()) as {
            room: {
              guest: { token: string };
              producer: { token: string };
            };
          };

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
          await guest.goto(`/rec/${room.room.guest.token}?e2e=1`);
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
          await producer.goto(`/rec/${room.room.producer.token}?e2e=1`);
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
            guest.getByRole("button", { name: "Leave" }),
          ).toBeVisible();
          await expect(host.getByText(/Ava · consented/)).toBeVisible();

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
        const created = await host.request.post("/api/shares/record", {
          data: { path: projectPath },
        });
        expect(created.ok(), await created.text()).toBeTruthy();
        const room = (await created.json()) as {
          room: { guest: { token: string } };
        };
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
        await guest.goto(`/rec/${room.room.guest.token}?e2e=1`);
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
            const stream = await original(constraints);
            (
              window as unknown as { __testHostMicTrack?: MediaStreamTrack }
            ).__testHostMicTrack = stream.getAudioTracks()[0];
            return stream;
          };
        });
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const created = await host.request.post("/api/shares/record", {
          data: { path: projectPath },
        });
        expect(created.ok(), await created.text()).toBeTruthy();
        const room = (await created.json()) as {
          room: { guest: { token: string } };
        };
        await host.getByRole("button", { name: "Menu" }).click();
        await host.getByRole("menuitem", { name: "Record room…" }).click();
        const roomDlg = host.getByRole("dialog", { name: "Record room" });
        await expect(roomDlg).toBeVisible();

        await markSharecutE2e(guest);
        await guest.goto(`/rec/${room.room.guest.token}?e2e=1`);
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

        await host.evaluate(() => {
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
          roomDlg.getByText(
            "Microphone disconnected. Local recording is paused.",
          ),
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
            const created = await host.request.post("/api/shares/record", {
              data: { path: projectPath },
            });
            expect(created.ok(), await created.text()).toBeTruthy();
            const room = (await created.json()) as {
              room: { guest: { token: string } };
            };
            return room.room.guest.token;
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
          await guest.goto(`/rec/${guestToken}?e2e=1`);
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
        const created = await host.request.post("/api/shares/record", {
          data: { path: projectPath },
        });
        expect(created.ok(), await created.text()).toBeTruthy();
        const room = (await created.json()) as {
          room: { guest: { token: string } };
        };
        await markSharecutE2e(guest);
        await enableRoomTonePcmHarness(guest);
        await guest.goto(`/rec/${room.room.guest.token}?e2e=1`);
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
