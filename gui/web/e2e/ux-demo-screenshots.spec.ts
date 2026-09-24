import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { e2eProjectPath, repoRoot } from "./env";
import { openPhoneTimeline } from "./phoneTimeline";

const screensDir = path.join(repoRoot, "ux/assets/screens");
const uxDemoPath = path.join(
  repoRoot,
  "tests/fixtures/sharecut_ux_demo/episode.project.json",
);
const guestTokensPath = path.join(screensDir, ".guest-tokens.json");

function projectPath(): string {
  return fs.existsSync(uxDemoPath) ? uxDemoPath : e2eProjectPath;
}

interface GuestTokens {
  review_app: { token: string };
  daw_guest: { token: string };
}

function loadGuestTokens(): GuestTokens | null {
  if (!fs.existsSync(guestTokensPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(guestTokensPath, "utf8")) as GuestTokens;
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
    await phone.goto(`/?project=${encodeURIComponent(project)}`);
    await expect(phone.locator(".daw-shell--phone")).toBeVisible();
    const phoneNav = phone.getByRole("navigation", { name: "Primary" });
    await phoneNav.getByRole("button", { name: "Listen", exact: true }).click();
    await phone.screenshot({
      path: path.join(screensDir, "phone-listen.png"),
      fullPage: true,
    });
    await openPhoneTimeline(phone);
    await expect(phone.locator(".timeline-area--fixed-playhead")).toBeVisible();
    await phone.screenshot({
      path: path.join(screensDir, "phone-timeline.png"),
      fullPage: true,
    });
    await phoneNav.getByRole("button", { name: "Text", exact: true }).click();
    await expect(phone.locator(".mobile-text-mode")).toBeVisible();
    await phone.screenshot({
      path: path.join(screensDir, "phone-text.png"),
      fullPage: true,
    });
    await phone.close();

    const desktop = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await desktop.goto(`/?project=${encodeURIComponent(project)}`);
    await expect(desktop.locator(".daw-shell--desktop")).toBeVisible();
    await desktop.screenshot({
      path: path.join(screensDir, "desktop-shell.png"),
    });
    await desktop.close();
  });

  test("capture guest ReviewApp + Sharecut Studio share", async ({
    browser,
  }) => {
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
    await phone.goto(`/r/${tokens!.review_app.token}`);
    await expect(phone.locator(".review-shell")).toBeVisible({
      timeout: 30_000,
    });
    await phone.screenshot({
      path: path.join(screensDir, "guest-reviewapp.png"),
      fullPage: true,
    });

    await phone.goto(`/r/${tokens!.daw_guest.token}`);
    await expect(phone.locator(".daw-shell-guest")).toBeVisible({
      timeout: 30_000,
    });
    await expect(phone.locator(".guest-banner")).toBeVisible();
    await phone.screenshot({
      path: path.join(screensDir, "guest-sharecut-phone.png"),
      fullPage: true,
    });
    await phone.close();

    const desktop = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await desktop.goto(`/r/${tokens!.daw_guest.token}`);
    await expect(desktop.locator(".daw-shell-guest")).toBeVisible({
      timeout: 30_000,
    });
    await expect(desktop.locator(".guest-banner")).toBeVisible();
    await desktop.screenshot({
      path: path.join(screensDir, "guest-sharecut-desktop.png"),
    });
    await desktop.close();
  });
});

void fileURLToPath;
