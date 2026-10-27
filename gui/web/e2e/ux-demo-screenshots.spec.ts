import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath, repoRoot } from "./env";
import { openPhoneTimeline } from "./phoneTimeline";
import { openProject, phone as stagePhone } from "./stageNav";

const screensDir =
  process.env.UX_DEMO_SCREENS_DIR ?? path.join(repoRoot, "ux/assets/screens");
const uxDemoPath = path.join(
  repoRoot,
  "tests/fixtures/sharecut_ux_demo/episode.project.json",
);
const guestTokensPath =
  process.env.UX_DEMO_GUEST_TOKENS ??
  path.join(screensDir, ".guest-tokens.json");

function projectPath(): string {
  if (process.env.UX_DEMO_PROJECT) return process.env.UX_DEMO_PROJECT;
  return fs.existsSync(uxDemoPath) ? uxDemoPath : e2eProjectPath;
}

interface GuestTokens {
  daw_guest: { token: string };
}

function loadGuestTokens(): GuestTokens | null {
  if (!fs.existsSync(guestTokensPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(guestTokensPath, "utf8")) as GuestTokens;
}

async function expectLoadedDemo(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "ShareCut Studio UX demo",
  );
  await expect(page.locator(".sys-player-total").first()).toContainText(
    "01:00.000",
  );
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
}

async function expectLoadedTimeline(page: Page): Promise<void> {
  await expect(
    page.locator('.lane-row[data-track-id="reference"]'),
  ).toBeVisible();
  await expect(page.locator('.lane-row[data-track-id="guest"]')).toBeVisible();
}

test.describe("UX demo screenshots", () => {
  test.beforeAll(() => {
    fs.mkdirSync(screensDir, { recursive: true });
  });

  test("capture phone modes + desktop shell", async ({ browser }) => {
    test.skip(
      !process.env.UX_DEMO_SCREENSHOTS,
      "Set UX_DEMO_SCREENSHOTS=1 to refresh ux/assets/screens",
    );

    const project = projectPath();

    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openProject(phone, project);
    await expect(phone.locator(".stage-frame--phone")).toBeVisible();
    await expectLoadedDemo(phone);
    await stagePhone.showListen(phone);
    await phone.screenshot({
      path: path.join(screensDir, "phone-listen.png"),
      fullPage: true,
    });
    await openPhoneTimeline(phone);
    await expect(phone.locator(".timeline-area--fixed-playhead")).toBeVisible();
    await expectLoadedTimeline(phone);
    await phone.screenshot({
      path: path.join(screensDir, "phone-timeline.png"),
      fullPage: true,
    });
    await stagePhone.showText(phone);
    await expect(phone.locator(".phone-edit-script")).toBeVisible();
    await expect(phone.locator("[data-transcript-word]").first()).toBeVisible();
    await phone.screenshot({
      path: path.join(screensDir, "phone-text.png"),
      fullPage: true,
    });
    await phone.close();

    const desktop = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openProject(desktop, project);
    await expect(desktop.locator(".stage-frame--desktop")).toBeVisible();
    await expectLoadedDemo(desktop);
    await expectLoadedTimeline(desktop);
    await expect(
      desktop.locator("[data-transcript-word]").first(),
    ).toBeVisible();
    await desktop.screenshot({
      path: path.join(screensDir, "desktop-shell.png"),
    });
    await desktop.close();
  });

  test("capture guest ShareCut Studio share", async ({ browser }) => {
    test.skip(
      !process.env.UX_DEMO_SCREENSHOTS,
      "Set UX_DEMO_SCREENSHOTS=1 to refresh ux/assets/screens",
    );
    const tokens = loadGuestTokens();
    test.skip(
      !tokens,
      "Run scripts/ux_demo_prepare_shares.py first (make ux-demo-screens)",
    );

    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await phone.goto(`/r/${tokens!.daw_guest.token}`);
    await expect(phone.locator(".stage-frame--guest")).toBeVisible({
      timeout: 30_000,
    });
    await expect(phone.locator(".guest-banner")).toBeVisible();
    await expectLoadedDemo(phone);
    await phone.screenshot({
      path: path.join(screensDir, "guest-sharecut-phone.png"),
      fullPage: true,
    });
    await phone.close();

    const desktop = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await desktop.goto(`/r/${tokens!.daw_guest.token}`);
    await expect(desktop.locator(".stage-frame--guest")).toBeVisible({
      timeout: 30_000,
    });
    await expect(desktop.locator(".guest-banner")).toBeVisible();
    await expectLoadedDemo(desktop);
    await expectLoadedTimeline(desktop);
    await expect(
      desktop.locator("[data-transcript-word]").first(),
    ).toBeVisible();
    await desktop.screenshot({
      path: path.join(screensDir, "guest-sharecut-desktop.png"),
    });
    await desktop.close();
  });
});
