import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  COPY_FAILED_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from "../src/stage/dialogs/hostMcp";
import { expectPageAxeClean } from "./axe";
import {
  expectFitsViewport,
  openDialogFromMenu,
  openHostProject,
} from "./overlayReachability";

/**
 * Connect agent dialog (DLG-MCP): the footer buttons hold the 44 px floor on a mouse too,
 * focus opens on Copy address, the copy status clears with the "Copied" label, and a copy the
 * browser refuses says one plain thing that fits a phone. Vitest cannot measure layout.
 */
const FLOOR_PX = 44 - 0.5;

const SHELLS = [
  { name: "desktop 1280x800", width: 1280, height: 800, touch: false },
  { name: "iPhone 390x844 touch", width: 390, height: 844, touch: true },
] as const;

const WINDOW_MS = 2000;
const ACTIVITY_ROUTE = "**/api/host-mcp/activity";
const ACTIVITY_LINE =
  /^(An app used this address|No app has used this address|Last used)/;
const FLOOR = 43.5;

type Box = { x: number; y: number; width: number; height: number };

/** The footer row and the address field: the two boxes a status change must not move. */
async function layoutBoxes(dialog: Locator) {
  const footer = await dialog.locator(".share-dialog-actions").boundingBox();
  const textarea = await dialog.getByLabel("Connection address").boundingBox();
  return { footer: footer as Box, textarea: textarea as Box };
}

/** The dialog slides in; measure only once two reads in a row agree, so the open motion is not a "move". */
async function settledLayoutBoxes(dialog: Locator) {
  let last = JSON.stringify(await layoutBoxes(dialog));
  await expect
    .poll(async () => {
      const now = JSON.stringify(await layoutBoxes(dialog));
      const stable = now === last;
      last = now;
      return stable;
    })
    .toBe(true);
  return layoutBoxes(dialog);
}

function expectSameBox(actual: Box, expected: Box, label: string) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${label}.${key}`,
    ).toBeLessThanOrEqual(1);
  }
}

async function openConnectAgent(page: Page) {
  await openHostProject(page);
  await openDialogFromMenu(page, "Connect agent…");
  const dialog = page.getByRole("dialog", { name: "Connect agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Make the browser refuse every clipboard write, as a denied permission does. */
async function denyClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
  });
}

test("a real mouse click leaves the whole address and config selected", async ({
  page,
}) => {
  const dialog = await openConnectAgent(page);
  await dialog.getByText("Config file format").click();
  for (const label of ["Connection address", "Configuration (JSON)"]) {
    await dialog.getByLabel(label).click();
    const selected = await dialog
      .getByLabel(label)
      .evaluate(
        (el: HTMLInputElement | HTMLTextAreaElement) =>
          el.selectionStart === 0 && el.selectionEnd === el.value.length,
      );
    expect(selected, label).toBe(true);
  }
});

for (const shell of SHELLS) {
  test.describe(`Connect agent: ${shell.name}`, () => {
    test.use({
      viewport: { width: shell.width, height: shell.height },
      isMobile: shell.touch,
      hasTouch: shell.touch,
      permissions: ["clipboard-read", "clipboard-write"],
    });

    test("footer buttons hold the 44 px floor and focus opens on Copy address", async ({
      page,
    }) => {
      const dialog = await openConnectAgent(page);
      if (shell.touch) {
        expect(
          await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
        ).toBe(true);
      }
      for (const name of ["Copy config", "Copy address"]) {
        const box = await dialog
          .getByRole("button", { name, exact: true })
          .boundingBox();
        expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(FLOOR_PX);
      }
      await expect(
        dialog.getByRole("button", { name: "Copy address", exact: true }),
      ).toBeFocused();
    });

    test("copying says Copied, then the label and the status clear together", async ({
      page,
    }) => {
      const dialog = await openConnectAgent(page);
      const before = await settledLayoutBoxes(dialog);
      await dialog
        .getByRole("button", { name: "Copy address", exact: true })
        .click();
      await expect(dialog.getByText("Copied address")).toBeVisible();
      await expect(dialog.locator(".share-dialog-status")).toHaveText(
        "Copied address",
      );
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      const during = await layoutBoxes(dialog);
      expectSameBox(during.footer, before.footer, "footer");
      expectSameBox(during.textarea, before.textarea, "address");
      await expect(
        dialog.getByRole("button", { name: "Copied", exact: true }),
      ).toBeVisible();
      const url = await dialog.getByLabel("Connection address").inputValue();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        url,
      );
      await expect(dialog.getByText("Copied address")).toBeHidden({
        timeout: 3500,
      });
      await expect(
        dialog.getByRole("button", { name: "Copy address", exact: true }),
      ).toBeVisible();
      await expect(dialog.locator(".share-dialog-status")).toHaveText("");
      const after = await layoutBoxes(dialog);
      expectSameBox(after.footer, before.footer, "footer after clear");
      expectSameBox(after.textarea, before.textarea, "address after clear");
    });

    test("a refused copy says one plain thing that fits the screen", async ({
      page,
    }) => {
      await denyClipboard(page);
      const dialog = await openConnectAgent(page);
      const before = await settledLayoutBoxes(dialog);
      const pressed = dialog.getByRole("button", {
        name: "Copy config",
        exact: true,
      });
      await pressed.click();
      const startedAt = Date.now();
      const message = dialog.getByText(COPY_FAILED_MESSAGE);
      await expect(message).toBeVisible();
      await expect(pressed).toBeFocused();
      await expect(dialog.getByRole("alert")).toHaveCount(1);
      await expect(dialog.getByRole("alert")).toHaveText(COPY_FAILED_MESSAGE);
      await expect(dialog.locator(".share-dialog-status")).toHaveText("");
      expect(
        await dialog
          .getByRole("alert")
          .evaluate((el) => !el.closest("[aria-live], [role=status]")),
      ).toBe(true);
      const during = await layoutBoxes(dialog);
      expectSameBox(during.footer, before.footer, "footer");
      expectSameBox(during.textarea, before.textarea, "address");
      // The failure is not on the 2 s timer: still there once the window has passed.
      await expect
        .poll(
          async () =>
            Date.now() - startedAt > WINDOW_MS + 500 &&
            (await dialog.getByRole("alert").isVisible()),
          { timeout: WINDOW_MS + 3000 },
        )
        .toBe(true);
      await expect(dialog.getByRole("alert")).toHaveCount(1);
      await expect(dialog.getByText(/denied|NotAllowed/i)).toHaveCount(0);
      const box = (await message.boundingBox())!;
      const panel = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(panel.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(shell.width);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      // The fields select on focus, so "select the text" works.
      await dialog.getByLabel("Connection address").focus();
      expect(
        await dialog
          .getByLabel("Connection address")
          .evaluate(
            (el: HTMLInputElement) =>
              el.selectionStart === 0 && el.selectionEnd === el.value.length,
          ),
      ).toBe(true);
    });
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  },
};

/** Fixed answers for the status line, so a state does not depend on what other tests did to the host. */
async function answerActivity(page: Page, body: object) {
  await page.route(ACTIVITY_ROUTE, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(body),
    }),
  );
}

const USED_4S = {
  mounted: true,
  last_request_at: "2026-01-01T00:00:00Z",
  age_seconds: 4,
};

for (const shell of SHELLS) {
  test.describe(`Connect agent status and disclosure: ${shell.name}`, () => {
    test.use({
      viewport: { width: shell.width, height: shell.height },
      isMobile: shell.touch,
      hasTouch: shell.touch,
    });

    test("announces unavailability while focus stays on Setup guide", async ({
      page,
    }) => {
      let mounted = true;
      await page.route(ACTIVITY_ROUTE, (route) =>
        route.fulfill({
          json: mounted
            ? USED_4S
            : { mounted: false, last_request_at: null, age_seconds: null },
        }),
      );
      await page.clock.install();
      const dialog = await openConnectAgent(page);
      await expect(dialog.locator(".host-mcp-activity")).toHaveText(
        ACTIVITY_LINE,
      );
      const guide = dialog.getByRole("link", { name: /Setup guide/ });
      await guide.focus();
      mounted = false;
      await page.clock.runFor(3100);
      await expect(guide).toBeFocused();
      await expect(dialog.locator(".host-mcp-activity-live")).toHaveText(
        UNAVAILABLE_MESSAGE,
      );
      await expect(dialog.locator(".host-mcp-unavailable")).toContainText(
        "See the Setup guide for other ways to connect.",
      );
    });

    test("clears last-used activity after a not-found response", async ({
      page,
    }) => {
      let available = true;
      await page.route(ACTIVITY_ROUTE, (route) =>
        available
          ? route.fulfill({ json: USED_4S })
          : route.fulfill({ status: 404, json: { detail: "Not found" } }),
      );
      await page.clock.install();
      const dialog = await openConnectAgent(page);
      const lastUsed = dialog.locator(".host-mcp-activity");
      await expect(lastUsed).toHaveText(ACTIVITY_LINE);
      available = false;
      await page.clock.runFor(3100);
      await expect(lastUsed).toBeEmpty();
      await expect(
        dialog.getByRole("button", { name: "Copy address" }),
      ).toBeVisible();
    });

    test("the disclosure and the setup link are touch-sized and the address field keeps its place", async ({
      page,
    }) => {
      await answerActivity(page, USED_4S);
      const dialog = await openConnectAgent(page);
      await expect(dialog.locator(".host-mcp-activity")).toHaveText(
        "An app used this address just now.",
      );
      const summary = dialog.getByText("Config file format");
      const link = dialog.getByRole("link", { name: /Setup guide/ });
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toContainText("opens in a new tab");
      for (const target of [summary, link]) {
        expect(
          (await target.boundingBox())?.height ?? 0,
        ).toBeGreaterThanOrEqual(FLOOR);
      }
      const address = dialog.getByLabel("Connection address");
      expect((await address.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        FLOOR,
      );
      // The panel recentres (or re-anchors) as it grows, so measure the address from the panel's own corner.
      const fromPanel = async () => {
        const panel = (await dialog
          .locator(".command-palette-panel")
          .boundingBox())!;
        const field = (await address.boundingBox())!;
        return { ...field, x: field.x - panel.x, y: field.y - panel.y };
      };
      await settledLayoutBoxes(dialog);
      const before = await fromPanel();
      await expect(dialog.getByLabel("Configuration (JSON)")).toBeHidden();
      await summary.click();
      const config = dialog.getByLabel("Configuration (JSON)");
      await expect(config).toBeVisible();
      await settledLayoutBoxes(dialog);
      expectSameBox(await fromPanel(), before, "address");
      await expectFitsViewport(page, dialog.locator(".command-palette-panel"));
      const panel = (await dialog
        .locator(".command-palette-panel")
        .boundingBox())!;
      const box = (await config.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(panel.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await expectPageAxeClean(page, '[role="dialog"]');
      await summary.click();
      await expect(config).toBeHidden();
    });

    test("every state of the line is axe-clean and says nothing about being connected", async ({
      page,
    }) => {
      const states: [object, RegExp][] = [
        [
          { mounted: true, last_request_at: null, age_seconds: null },
          /^No app has used this address since Studio started\.$/,
        ],
        [USED_4S, /^An app used this address just now\.$/],
        [{ ...USED_4S, age_seconds: 3 * 3600 }, /^Last used 3 hours ago\.$/],
      ];
      for (const [body, line] of states) {
        await page.unroute(ACTIVITY_ROUTE);
        await answerActivity(page, body);
        const dialog = await openConnectAgent(page);
        await expect(dialog.locator(".host-mcp-activity")).toHaveText(line);
        expect(await dialog.innerText()).not.toMatch(/connected|online/i);
        await expectPageAxeClean(page, '[role="dialog"]');
        await page.reload();
      }
    });

    test("when this Studio cannot accept connections it says so and offers no copy", async ({
      page,
    }) => {
      await answerActivity(page, {
        mounted: false,
        last_request_at: null,
        age_seconds: null,
      });
      const dialog = await openConnectAgent(page);
      await expect(dialog.locator(".host-mcp-unavailable")).toBeVisible();
      await expect(dialog.locator(".host-mcp-unavailable")).toBeFocused();
      await expect(dialog.getByRole("button", { name: /^Copy/ })).toHaveCount(
        0,
      );
      await expect(dialog.getByLabel("Connection address")).toHaveCount(0);
      await expect(
        dialog.getByRole("link", { name: /Setup guide/ }),
      ).toBeVisible();
      await expectPageAxeClean(page, '[role="dialog"]');
    });

    test("a real request to the address shows on the line", async ({
      page,
    }) => {
      const dialog = await openConnectAgent(page);
      await expect(dialog.locator(".host-mcp-activity")).toHaveText(
        ACTIVITY_LINE,
      );
      const origin = new URL(page.url()).origin;
      const res = await page.request.post(`${origin}/mcp`, {
        headers: {
          Origin: origin,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        data: INITIALIZE,
      });
      expect(res.ok()).toBe(true);
      await expect(dialog.locator(".host-mcp-activity")).toHaveText(
        /^An app used this address (just now|1 minute ago)\.$/,
        { timeout: 8000 },
      );
    });
  });
}

test.describe("Connect agent polling", () => {
  test("asks nothing while the tab is hidden and asks again at once on return", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      let state: DocumentVisibilityState = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      (
        window as unknown as { setVisibility: (v: string) => void }
      ).setVisibility = (v) => {
        state = v as DocumentVisibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
      };
    });
    await page.clock.install();
    let asked = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/host-mcp/activity")) asked += 1;
    });
    const dialog = await openConnectAgent(page);
    await expect(dialog.locator(".host-mcp-activity")).toHaveText(
      ACTIVITY_LINE,
    );
    await page.evaluate(() =>
      (
        window as unknown as { setVisibility: (v: string) => void }
      ).setVisibility("hidden"),
    );
    const whileHidden = asked;
    await page.clock.runFor(7000);
    expect(asked).toBe(whileHidden);
    await page.evaluate(() =>
      (
        window as unknown as { setVisibility: (v: string) => void }
      ).setVisibility("visible"),
    );
    await expect.poll(() => asked).toBeGreaterThan(whileHidden);
    const afterReturn = asked;
    await page.clock.runFor(3100);
    await expect.poll(() => asked).toBeGreaterThan(afterReturn);
  });

  test("stops asking once the dialog is closed", async ({ page }) => {
    let asked = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/host-mcp/activity")) asked += 1;
    });
    await page.clock.install();
    const dialog = await openConnectAgent(page);
    await expect(dialog.locator(".host-mcp-activity")).toHaveText(
      ACTIVITY_LINE,
    );
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
    const whileClosed = asked;
    await page.clock.runFor(10_000);
    expect(asked).toBe(whileClosed);
  });
});

test.describe("Connect agent at 320 px", () => {
  test.use({
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
  });

  test("fits with no sideways scroll, closed and open", async ({ page }) => {
    await answerActivity(page, USED_4S);
    const dialog = await openConnectAgent(page);
    await expect(dialog.locator(".host-mcp-activity")).toHaveText(
      "An app used this address just now.",
    );
    const fits = async () => {
      const panel = (await dialog
        .locator(".command-palette-panel")
        .boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(-1);
      expect(panel.x + panel.width).toBeLessThanOrEqual(321);
      for (const target of [
        dialog.getByRole("button", { name: "Copy address", exact: true }),
        dialog.getByRole("button", { name: "Copy config", exact: true }),
        dialog.getByLabel("Connection address"),
        dialog.getByRole("link", { name: /Setup guide/ }),
        dialog.getByText("Config file format"),
      ]) {
        const box = (await target.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(panel.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(
          panel.x + panel.width + 1,
        );
      }
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    };
    await fits();
    await dialog.getByText("Config file format").click();
    await expect(dialog.getByLabel("Configuration (JSON)")).toBeVisible();
    await fits();
  });
});
