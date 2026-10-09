import { expect, test, type WebSocketRoute } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import { openPhoneTimeline } from "./phoneTimeline";

test.use({ launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] } });

for (const phone of [false, true]) {
  test(`provisional recording geometry with panel closed (${phone ? "fixed phone" : "desktop"})`, async ({
    page,
  }) => {
    await page.setViewportSize(
      phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    );
    let snapshot = {
      session_id: "visual-preview",
      state: "lobby",
      take_index: 2,
      recording_ms: 3600000,
      timeline_start_sec: 7,
      server_time_ns: 0,
      participants: [],
      caps: { recorded: 4, producers: 2 },
    };
    await page.route(
      (url) => url.pathname === "/api/record/state",
      (route) => route.fulfill({ json: snapshot }),
    );
    let socket: WebSocketRoute | undefined;
    let connected = false;
    await page.routeWebSocket(/\/api\/host\/ws/, (route) => {
      socket = route;
      const server = route.connectToServer();
      server.onMessage((message) => {
        const payload = JSON.parse(String(message)) as { plane?: string };
        if (payload.plane === "record") return;
        route.send(message);
        if (payload.plane === "session") connected = true;
      });
    });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    if (phone) await openPhoneTimeline(page);
    await expect(page.locator(".timeline-time")).toBeVisible();
    await expect(
      page.locator('.timeline-scroll .track-headers:not([aria-busy="true"])'),
    ).toBeVisible();
    await expect.poll(() => Boolean(socket) && connected).toBe(true);
    const scroller = page.locator(".timeline-scroll");
    const before = await scroller.evaluate((el) => ({
      left: el.scrollLeft,
      width: el.scrollWidth,
    }));
    const canvasWidth = await page
      .locator(".timeline-time")
      .evaluate((el) => el.getBoundingClientRect().width);
    const clipCount = await page.locator(".clip-block").count();
    const send = (state: string, time: number) => {
      snapshot = { ...snapshot, state, server_time_ns: time };
      socket!.send(
        JSON.stringify({ plane: "record", type: "Snapshot", snapshot }),
      );
    };
    send("lobby", 0);
    await page.waitForFunction(async () =>
      (await navigator.mediaDevices.enumerateDevices()).some(
        (device) => device.kind === "audioinput" && device.label !== "",
      ),
    );
    send("recording", 1);
    const overlay = page.getByRole("img", { name: /provisional recording/ });
    await expect(overlay).toBeAttached();
    const recordDialog = page.getByRole("dialog", { name: "Record room" });
    if (await recordDialog.count()) {
      await recordDialog
        .getByRole("button", { name: "Close", exact: true })
        .click();
    }
    await expect(recordDialog).toHaveCount(0);
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollWidth))
      .toBeGreaterThan(before.width);
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(before.left);
    expect(
      await page
        .locator(".timeline-time")
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBe(canvasWidth);
    expect(await page.locator(".clip-block").count()).toBe(clipCount);
    const geometry = await page.locator(".recording-overlay").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const needle = el
        .querySelector(".recording-overlay-needle")!
        .getBoundingClientRect();
      const scroll = el.closest(".timeline-scroll")!;
      return {
        end:
          needle.right -
          scroll.getBoundingClientRect().left +
          scroll.scrollLeft,
        width: scroll.scrollWidth,
        pad: rect.right - needle.right,
        pointerEvents: getComputedStyle(el).pointerEvents,
      };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(Math.floor(geometry.end));
    expect(geometry.pointerEvents).toBe("none");
    if (phone) {
      expect(geometry.pad).toBeGreaterThan(0);
      await expect(page.locator(".playhead--fixed")).toBeVisible();
      const seekValue = await page
        .getByRole("slider", { name: "Timeline position" })
        .getAttribute("aria-valuenow");
      await scroller.hover();
      await page.mouse.wheel(50000, 0);
      await page.waitForTimeout(150);
      const scrollDebug = await scroller.evaluate((el) => {
        const needle = el
          .querySelector(".recording-overlay-needle")!
          .getBoundingClientRect();
        const bounds = el.getBoundingClientRect();
        return {
          left: el.scrollLeft,
          needleLeft: needle.left,
          needleRight: needle.right,
          viewportLeft: bounds.left,
          viewportRight: bounds.right,
          children: Array.from(
            el.querySelector(".timeline-lock-inner")!.children,
          ).map((child) => ({
            cls: (child as HTMLElement).className,
            width: (child as HTMLElement).getBoundingClientRect().width,
            scrollWidth: (child as HTMLElement).scrollWidth,
          })),
        };
      });
      expect(scrollDebug.left).toBeGreaterThan(before.left);
      expect(scrollDebug.needleLeft).toBeGreaterThanOrEqual(
        scrollDebug.viewportLeft,
      );
      expect(scrollDebug.needleRight).toBeLessThanOrEqual(
        scrollDebug.viewportRight,
      );
      await expect(
        page.getByRole("slider", { name: "Timeline position" }),
      ).toHaveAttribute("aria-valuenow", seekValue!);
    }
    send("paused", 2);
    await expect(overlay).toHaveAttribute("data-state", "paused");
    const frozen = await page
      .locator(".recording-overlay-band")
      .evaluate((el) => el.getBoundingClientRect().width);
    await page.waitForTimeout(100);
    expect(
      await page
        .locator(".recording-overlay-band")
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBe(frozen);
    send("stopped", 3);
    await expect(overlay).toHaveCount(0);
    expect(await scroller.evaluate((el) => el.scrollWidth)).toBe(before.width);
  });
}
