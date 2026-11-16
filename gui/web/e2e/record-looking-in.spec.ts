import { type BrowserContext, expect, test } from "@playwright/test";
import { createRecordRoom, markSharecutE2e } from "./recordRoom";
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

/** Until a server sends `watchers`, the page is shown a snapshot that carries it. */
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
