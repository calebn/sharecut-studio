import { expect, type Page, test } from "@playwright/test";
import {
  addEnvelopePoint,
  dismissToast,
  inspectEnvelopePoint,
  pointSheet,
  setPointField,
  showEnvelope,
} from "./envelopeCreationEvidence";
import { installNetworkOutage } from "./networkOutage";
import { rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { phone } from "./stageNav";

/**
 * #1346: a phone guest's review socket drops and reconnects (the relay path
 * does this in practice). Each reconnect delivers a fresh session snapshot
 * whose selection is the host's. The guest must keep its own envelope editor,
 * and each cycle must leave timers, listeners and sockets where they started.
 */

const CYCLES = 5;

type Resources = {
  intervals: number;
  listeners: number;
  openSockets: number;
  sockets: number;
};

const RESOURCE_PROBE = `(() => {
  const intervals = new Set();
  const listeners = new Map();
  const sockets = [];
  const setI = window.setInterval.bind(window);
  const clearI = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => {
    const id = setI(fn, ms, ...args);
    intervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    intervals.delete(id);
    clearI(id);
  };
  for (const target of [window, document]) {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    target.addEventListener = function (type, fn, opts) {
      listeners.set(fn, (listeners.get(fn) ?? 0) + 1);
      return add.call(this, type, fn, opts);
    };
    target.removeEventListener = function (type, fn, opts) {
      const n = (listeners.get(fn) ?? 0) - 1;
      if (n > 0) listeners.set(fn, n);
      else listeners.delete(fn);
      return remove.call(this, type, fn, opts);
    };
  }
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (String(url).includes("/daw/ws")) sockets.push(this);
    }
  };
  window.__resources1346 = () => ({
    intervals: intervals.size,
    listeners: [...listeners.values()].reduce((a, b) => a + b, 0),
    openSockets: sockets.filter((s) => s.readyState === 1).length,
    sockets: sockets.length,
  });
})();`;

function resources(page: Page): Promise<Resources> {
  return page.evaluate(() =>
    (
      window as unknown as { __resources1346: () => Resources }
    ).__resources1346(),
  );
}

async function moveEnvelopePoint(page: Page, time: number): Promise<void> {
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes("/daw/document/command"),
  );
  await setPointField(page, "Time", String(time));
  expect((await saved).status()).toBe(200);
}

test("a guest keeps its envelope editor and baseline resources across socket reconnects", async ({
  browser,
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openHostShare(page, projectPath);
    await page.locator(".clip-block").first().click();
    const token = await createReviewShare(page, projectPath, "editor");

    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const guest = await context.newPage();
      await guest.addInitScript({ content: RESOURCE_PROBE });
      await rememberInspectorDetent(guest, "half");
      const outage = await installNetworkOutage(guest, {
        webSocket: /\/api\/review\/[^/]+\/daw\/ws/,
      });
      await openGuestShare(guest, token);
      await expect
        .poll(async () => (await resources(guest)).openSockets)
        .toBe(1);

      const inspector = guest.getByRole("dialog", { name: "Inspector" });
      if (await inspector.isVisible()) {
        await inspector.getByRole("button", { name: "Close" }).click();
      }
      await phone.showTimeline(guest);
      await guest
        .getByRole("button", { name: "Open track details, guest", exact: true })
        .click();
      await showEnvelope(guest);
      await addEnvelopePoint(guest);
      await inspectEnvelopePoint(guest);
      const editing = pointSheet(guest).getByRole("spinbutton", {
        name: "Time",
        exact: true,
      });
      await expect(editing).toBeVisible();
      const baseline = await resources(guest);

      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        await moveEnvelopePoint(guest, 2 + cycle * 3);
        await outage.drop();
        outage.restore();
        await expect
          .poll(async () => (await resources(guest)).sockets)
          .toBe(baseline.sockets + cycle);
        await expect
          .poll(async () => (await resources(guest)).openSockets)
          .toBe(1);
        await expect(editing).toBeVisible();
        await expect(guest.getByText("Edit not found")).toHaveCount(0);
      }

      const after = await resources(guest);
      expect(after).toEqual({
        intervals: baseline.intervals,
        listeners: baseline.listeners,
        openSockets: 1,
        sockets: baseline.sockets + CYCLES,
      });

      await dismissToast(guest);
      await pointSheet(guest).getByRole("button", { name: "Close" }).click();
      await phone.showListen(guest);
      await expect(
        guest.getByRole("button", { name: "Play", exact: true }).first(),
      ).toBeEnabled();
    } finally {
      await context.close();
    }
  });
});
