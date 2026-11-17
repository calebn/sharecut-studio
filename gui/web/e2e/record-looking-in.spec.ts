import { type BrowserContext, expect, test } from "@playwright/test";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import { createRecordRoom, joinAsGuest, markSharecutE2e } from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { goToStage } from "./stageNav";

const LINE = "3 people with the producer link are looking in";

function withWatchers(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) withWatchers(item);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("participants" in record && "session_id" in record) {
      record.watchers = 3;
    }
    for (const item of Object.values(record)) withWatchers(item);
  }
}

/** Forces a count of 3, so the plural line shows without three observer sockets. */
async function stubWatchers(context: BrowserContext): Promise<void> {
  await context.routeWebSocket(/.*/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === "string" && message.startsWith("{")) {
        const parsed = JSON.parse(message);
        withWatchers(parsed);
        socket.send(JSON.stringify(parsed));
        return;
      }
      socket.send(message);
    });
    socket.onClose(() => server.close());
    server.onClose(() => socket.close());
  });
  await context.route("**/api/record/state*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    withWatchers(body);
    await route.fulfill({ response, json: body });
  });
}

const SIZES = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "small laptop", width: 1024, height: 700 },
  { name: "phone with Comments open", width: 390, height: 844 },
];

for (const size of SIZES) {
  test(`the host sees who is looking in without scrolling: ${size.name}`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
      });
      try {
        await stubWatchers(context);
        const host = await context.newPage();
        await markSharecutE2e(host);
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        await createRecordRoom(host, projectPath);
        await goToStage(host, "record");
        const line = host.getByText(LINE);
        await expect(line).toBeVisible();
        if (size.width < 700) {
          const comments = host.getByRole("dialog", { name: "Comments" });
          await expect(comments).toBeVisible();
        }
        await expect(line).toBeInViewport({ ratio: 1 });
        await expect
          .poll(() =>
            line.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const top = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
              return top !== null && element.contains(top);
            }),
          )
          .toBe(true);
      } finally {
        await context.close();
      }
    });
  });
}

const ONE = "Someone with the producer link is looking in";

test.use({ launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] } });

test.describe("looking in, against the real server", () => {
  test("a producer link's observe socket shows the line to the host and the guest and clears on close", async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      const hostCtx = await browser.newContext();
      const guestCtx = await browser.newContext();
      const lookerCtx = await browser.newContext();
      try {
        const host = await hostCtx.newPage();
        await markSharecutE2e(host);
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);
        await goToStage(host, "record");
        const guest = await guestCtx.newPage();
        await markSharecutE2e(guest);
        await joinAsGuest(guest, room.guest.token, "Ava");
        await expect(
          host.getByText("Ava", { exact: true }).first(),
        ).toBeVisible();
        await expect(
          host.locator(".sys-room-looking-in", { hasText: ONE }),
        ).toBeHidden();
        await expect(
          guest.locator(".sys-room-looking-in", { hasText: ONE }),
        ).toBeHidden();

        const looker = await lookerCtx.newPage();
        await looker.goto("/api/health");
        const opened = await looker.evaluate(
          (token) =>
            new Promise<string>((resolve) => {
              const url = new URL(
                `/api/rec/${encodeURIComponent(token)}/ws`,
                window.location.href,
              );
              url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
              url.searchParams.set("client_id", "e2e-looker");
              url.searchParams.set("observe", "1");
              const socket = new WebSocket(url);
              (window as unknown as { __looker: WebSocket }).__looker = socket;
              socket.onmessage = () => resolve("frame");
              socket.onclose = (event) => resolve(`closed ${event.code}`);
            }),
          room.producer.token,
        );
        expect(opened).toBe("frame");
        await expect(
          host.locator(".sys-room-looking-in", { hasText: ONE }),
        ).toBeVisible();
        await expect(
          guest.locator(".sys-room-looking-in", { hasText: ONE }),
        ).toBeVisible();

        await looker.evaluate(() =>
          (window as unknown as { __looker: WebSocket }).__looker.close(),
        );
        await expect(
          host.locator(".sys-room-looking-in", { hasText: ONE }),
        ).toBeHidden();
        await expect(
          guest.locator(".sys-room-looking-in", { hasText: ONE }),
        ).toBeHidden();
      } finally {
        await hostCtx.close();
        await guestCtx.close();
        await lookerCtx.close();
      }
    });
  });
});
