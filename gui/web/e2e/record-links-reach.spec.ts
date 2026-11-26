import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { hostList } from "./guestLink";
import { LAPTOP, PHONE } from "./recordLiveTake";
import { createRecordRoom } from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { openProject, openProjectDialog } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

const TOUCH_MIN = 43.99;
const PERMISSIONS = ["clipboard-read", "clipboard-write"];

const clipboard = (page: Page) =>
  page.evaluate(() => navigator.clipboard.readText());

function tunnel(state: string) {
  return {
    state,
    reason: null,
    reason_kind: null,
    relay_host: "relay.example.test",
    public_base_url: "https://share.example.test",
    share_count: 1,
    retry_at: null,
  };
}

async function routeTunnel(page: Page, state: string) {
  await page.route("**/api/tunnel/status", (route) =>
    route.fulfill({ json: tunnel(state) }),
  );
}

async function openInvite(page: Page): Promise<Locator> {
  await openProjectDialog(page, "share");
  const sheet = page.getByRole("dialog", { name: "Invite" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Looking for your links…")).toBeHidden();
  return sheet;
}

const NOTE = /so only people on this network can open these links/;

function reach(label: string, options: BrowserContextOptions, touch: boolean) {
  const context = { ...options, permissions: PERMISSIONS };

  async function withInvite(
    browser: Browser,
    run: (page: Page, sheet: Locator, projectPath: string) => Promise<void>,
    before?: (page: Page) => Promise<void>,
  ) {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [context], async ([host]) => {
        await before?.(host!);
        await openProject(host!, projectPath);
        await createRecordRoom(host!, projectPath);
        const sheet = await openInvite(host!);
        await run(host!, sheet, projectPath);
      });
    });
  }

  test(`${label} [FAILS-OLD]: a host with no online sharing sees the note and the guide, and Copy still copies the guest link`, async ({
    browser,
  }) => {
    await withInvite(browser, async (host, sheet, projectPath) => {
      const [guest] = (await hostList(host, projectPath)).filter(
        (row) => row.url?.includes("/rec/") && row.docs_role === null,
      );
      expect(guest?.url).toMatch(/^http:\/\/127\.0\.0\.1:8080\/rec\//);

      await expect(
        sheet.getByText(
          /isn't set up on this computer, so only people on this network/,
        ),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        sheet.getByRole("link", { name: /How to turn on online sharing/ }),
      ).toHaveAttribute("href", /host-online-relay\.md#tunnel-status$/);

      const copy = sheet.getByRole("button", { name: "Copy guest link" });
      if (touch) await copy.tap();
      else await copy.click();
      await expect.poll(() => clipboard(host)).toBe(guest?.url);
    });
  });

  test(`${label} [FAILS-OLD]: online sharing turned off says so`, async ({
    browser,
  }) => {
    await withInvite(
      browser,
      async (_host, sheet) => {
        await expect(
          sheet.getByText(
            /Online sharing is off, so only people on this network/,
          ),
        ).toBeVisible({ timeout: 15_000 });
      },
      (page) => routeTunnel(page, "off"),
    );
  });

  test(`${label} [GUARD]: online sharing on hides the note`, async ({
    browser,
  }) => {
    await withInvite(
      browser,
      async (_host, sheet) => {
        await expect(sheet.getByText("Guests can open your links")).toBeVisible(
          { timeout: 15_000 },
        );
        await expect(sheet.getByText(NOTE)).toBeHidden();
      },
      (page) => routeTunnel(page, "online"),
    );
  });

  test(`${label} [FAILS-OLD]: the note fits, Copy keeps its touch target on a phone, and axe is clean`, async ({
    browser,
  }) => {
    await withInvite(browser, async (host, sheet) => {
      await expect(sheet.getByText(NOTE)).toBeVisible({ timeout: 15_000 });
      for (const name of ["Copy guest link", "Copy producer link"]) {
        const box = await sheet.getByRole("button", { name }).boundingBox();
        if (touch) {
          expect(box?.height).toBeGreaterThanOrEqual(TOUCH_MIN);
          expect(box?.width).toBeGreaterThanOrEqual(TOUCH_MIN);
        }
      }
      const overflow = await host.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
      await expectPageAxeClean(host, '[role="dialog"]');
    });
  });
}

test.describe("record links reach", () => {
  reach("laptop", LAPTOP, false);
  reach("phone", PHONE, true);
});
