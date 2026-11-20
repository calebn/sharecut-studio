import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test,
  type WebSocketRoute,
} from "@playwright/test";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import {
  createRecordRoom,
  fillDisplayNameField,
  hostRecordSnapshot,
  markSharecutE2e,
  openRecordLink,
  roomPill,
  roomTile,
} from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { goToStage } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

test.use({ launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] } });

const TOUCH_MIN = 44;
const STILL_WAITING = "Still waiting. Check your browser's permission prompt.";
const SLOW_NOTE_TIMEOUT_MS = 20_000;
const ROOM_TIMEOUT_MS = 30_000;

const LAPTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 360, height: 740 },
  hasTouch: true,
  isMobile: true,
};

type MicProbe = {
  __gumCalls: number;
  __holdMic: boolean;
  __answerMic: (call: number) => Promise<void>;
  __denyMic: (call: number) => void;
  __streams: MediaStream[];
};

async function installMicProbe(page: Page, hold = false): Promise<void> {
  await page.addInitScript((holdFirst) => {
    const probe = window as unknown as MicProbe;
    probe.__gumCalls = 0;
    probe.__holdMic = holdFirst;
    probe.__streams = [];
    const waiting: Array<{
      constraints: MediaStreamConstraints | undefined;
      resolve: (stream: MediaStream) => void;
      reject: (error: unknown) => void;
    }> = [];
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (constraints) => {
      probe.__gumCalls += 1;
      if (!probe.__holdMic) {
        return original(constraints).then((stream) => {
          probe.__streams.push(stream);
          return stream;
        });
      }
      return new Promise<MediaStream>((resolve, reject) => {
        waiting[probe.__gumCalls - 1] = { constraints, resolve, reject };
      });
    };
    probe.__answerMic = async (call) => {
      const pending = waiting[call - 1];
      const stream = await original(pending?.constraints);
      probe.__streams.push(stream);
      pending?.resolve(stream);
    };
    probe.__denyMic = (call) => {
      waiting[call - 1]?.reject(
        new DOMException("Permission denied", "NotAllowedError"),
      );
    };
  }, hold);
}

const gumCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as MicProbe).__gumCalls);

const liveStreams = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as MicProbe).__streams.filter((stream) =>
        stream.getTracks().some((track) => track.readyState === "live"),
      ).length,
  );

const answerMic = (page: Page, call: number) =>
  page.evaluate((n) => (window as unknown as MicProbe).__answerMic(n), call);

type SocketGate = {
  open: boolean;
  connections: number;
  dropLive: () => void;
};

/** Closes every guest room socket until `open` is set, then forwards them to the room. */
async function gateRoomSocket(context: BrowserContext): Promise<SocketGate> {
  const live: WebSocketRoute[] = [];
  const gate: SocketGate = {
    open: false,
    connections: 0,
    dropLive: () => {
      for (const socket of live.splice(0)) void socket.close();
    },
  };
  await context.routeWebSocket(/\/api\/rec\/[^/]+\/ws/, (socket) => {
    if (!gate.open) {
      void socket.close({ code: 1011 });
      return;
    }
    gate.connections += 1;
    live.push(socket);
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
    socket.onClose(() => void server.close());
    server.onClose(() => void socket.close());
  });
  return gate;
}

async function withRoom(
  browser: Browser,
  guestOptions: BrowserContextOptions,
  run: (room: {
    host: Page;
    guest: Page;
    guestContext: BrowserContext;
    token: string;
    projectPath: string;
  }) => Promise<void>,
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
        await goToStage(host, "record");
        await markSharecutE2e(guest);
        await run({
          host,
          guest,
          guestContext: guest.context(),
          token: room.guest.token,
          projectPath,
        });
      },
    );
  });
}

async function guestConsent(
  host: Page,
  projectPath: string,
  name: string,
): Promise<boolean | null | undefined> {
  const { participants } = await hostRecordSnapshot(host, projectPath);
  return participants.find((p) => p.display_name === name)?.consented;
}

const micRow = (page: Page): Locator => page.locator('[data-step="mic"]');
const retryButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Retry microphone" });
const joinSheetHeading = (page: Page): Locator =>
  page.getByRole("heading", { name: /Join the room| (is|are) here$/ });

async function declineBeforeConnect(guest: Page, token: string): Promise<void> {
  await openRecordLink(guest, token);
  const dialog = guest.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await guest.getByRole("button", { name: "Allow microphone" }).click();
  await expect(guest.locator(".sys-join-meter")).toBeAttached();
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe("Not now before the room connects", () => {
  test("closes the sheet at once and reaches the host once the room answers", async ({
    browser,
  }) => {
    await withRoom(
      browser,
      LAPTOP,
      async ({ host, guest, token, projectPath }) => {
        const gate = await gateRoomSocket(guest.context());
        await installMicProbe(guest);
        await declineBeforeConnect(guest, token);
        await expect(
          guest.getByText("You're not being recorded."),
        ).toBeVisible();
        await expect(
          guest.getByRole("button", { name: "Join recording" }),
        ).toBeEnabled();
        await expect.poll(() => liveStreams(guest)).toBe(0);
        expect(gate.connections).toBe(0);
        gate.open = true;
        await expect
          .poll(() => guestConsent(host, projectPath, "Guest"), {
            timeout: ROOM_TIMEOUT_MS,
          })
          .toBe(false);
        await expect(roomTile(host, "Guest")).toHaveCount(0);
        await expect(
          guest.getByText("You're not being recorded."),
        ).toBeVisible();
      },
    );
  });

  test("a lobby reconnect keeps the decline and tells the room again", async ({
    browser,
  }) => {
    await withRoom(
      browser,
      LAPTOP,
      async ({ host, guest, token, projectPath }) => {
        const gate = await gateRoomSocket(guest.context());
        await installMicProbe(guest);
        await declineBeforeConnect(guest, token);
        gate.open = true;
        await expect
          .poll(() => guestConsent(host, projectPath, "Guest"), {
            timeout: ROOM_TIMEOUT_MS,
          })
          .toBe(false);
        const before = gate.connections;
        gate.dropLive();
        await expect
          .poll(() => gate.connections, { timeout: ROOM_TIMEOUT_MS })
          .toBeGreaterThan(before);
        await expect
          .poll(() => guestConsent(host, projectPath, "Guest"), {
            timeout: ROOM_TIMEOUT_MS,
          })
          .toBe(false);
        await expect(
          guest.getByText("You're not being recorded."),
        ).toBeVisible();
        await expect(joinSheetHeading(guest)).toHaveCount(0);
      },
    );
  });

  test("Join recording after the decline changes the guest's mind", async ({
    browser,
  }) => {
    await withRoom(
      browser,
      LAPTOP,
      async ({ host, guest, token, projectPath }) => {
        const gate = await gateRoomSocket(guest.context());
        await installMicProbe(guest);
        await declineBeforeConnect(guest, token);
        gate.open = true;
        await expect
          .poll(() => guestConsent(host, projectPath, "Guest"), {
            timeout: ROOM_TIMEOUT_MS,
          })
          .toBe(false);
        await guest.getByRole("button", { name: "Join recording" }).click();
        await expect(guest.getByRole("dialog")).toBeVisible();
        await fillDisplayNameField(guest, "Ava");
        await expect(guest.locator(".sys-join-meter")).toBeAttached();
        const headphones = guest.getByRole("button", {
          name: "I'm wearing headphones",
        });
        await headphones.click();
        await expect(headphones).toHaveAttribute("aria-pressed", "true");
        await guest.getByRole("button", { name: "Join and record" }).click();
        await expect(roomPill(guest)).toHaveText(/^Waiting for .+ to start$/);
        await expect
          .poll(() => guestConsent(host, projectPath, "Ava"), {
            timeout: ROOM_TIMEOUT_MS,
          })
          .toBe(true);
      },
    );
  });
});

async function hungPromptNote(
  guest: Page,
  token: string,
  minHeight: number,
): Promise<void> {
  await openRecordLink(guest, token);
  await fillDisplayNameField(guest, "Ava");
  await guest.getByRole("button", { name: "Allow microphone" }).click();
  await expect(micRow(guest)).toContainText("Waiting for your browser");
  await expect(micRow(guest)).toContainText(STILL_WAITING, {
    timeout: SLOW_NOTE_TIMEOUT_MS,
  });
  const retry = retryButton(guest);
  await expect(retry).toBeInViewport({ ratio: 1 });
  const box = await retry.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minHeight);
  expect(await gumCalls(guest)).toBe(1);
}

for (const [label, options, minHeight] of [
  ["laptop", LAPTOP, 24],
  ["phone", PHONE, TOUCH_MIN],
] as const) {
  test.describe(`a microphone prompt that never answers on a ${label}`, () => {
    test("says so after 10 seconds, Retry asks again, and a late first answer is dropped", async ({
      browser,
    }) => {
      await withRoom(browser, options, async ({ guest, token }) => {
        const errors: string[] = [];
        guest.on("pageerror", (error) => errors.push(error.message));
        guest.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await installMicProbe(guest, true);
        await hungPromptNote(guest, token, minHeight);
        await retryButton(guest).click();
        await expect.poll(() => gumCalls(guest)).toBe(2);
        await expect(micRow(guest)).not.toContainText(STILL_WAITING);
        await answerMic(guest, 2);
        await expect(
          guest.locator('[data-step="mic"] .sys-status[data-state="done"]'),
        ).toBeVisible();
        const headphones = guest.getByRole("button", {
          name: "I'm wearing headphones",
        });
        await headphones.click();
        const join = guest.getByRole("button", { name: "Join and record" });
        await expect(join).toBeEnabled();
        await answerMic(guest, 1);
        await expect.poll(() => liveStreams(guest)).toBe(1);
        await expect(join).toBeEnabled();
        await expect(micRow(guest)).not.toContainText(STILL_WAITING);
        expect(errors).toEqual([]);
      });
    });
  });
}

test.describe("a microphone prompt answered late or refused", () => {
  test("a late answer without Retry clears the note and finishes the row", async ({
    browser,
  }) => {
    await withRoom(browser, LAPTOP, async ({ guest, token }) => {
      await installMicProbe(guest, true);
      await hungPromptNote(guest, token, 24);
      await answerMic(guest, 1);
      await expect(retryButton(guest)).toHaveCount(0);
      await expect(
        guest.locator('[data-step="mic"] .sys-status[data-state="done"]'),
      ).toBeVisible();
      await expect(micRow(guest)).not.toContainText(STILL_WAITING);
    });
  });

  test("a refused prompt shows the blocked row and never the waiting note", async ({
    browser,
  }) => {
    await withRoom(browser, LAPTOP, async ({ guest, token }) => {
      await installMicProbe(guest, true);
      await openRecordLink(guest, token);
      await fillDisplayNameField(guest, "Ava");
      await guest.getByRole("button", { name: "Allow microphone" }).click();
      await expect(micRow(guest)).toContainText("Waiting for your browser");
      await guest.evaluate(() => (window as unknown as MicProbe).__denyMic(1));
      await expect(
        guest.getByRole("button", { name: "How to allow the microphone" }),
      ).toBeVisible();
      await expect(micRow(guest)).toContainText("Microphone blocked");
      await expect(guest.getByText(STILL_WAITING)).toHaveCount(0);
    });
  });
});
