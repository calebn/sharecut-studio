import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { withShareableProject } from "../e2e/shareableProject";
import { withBrowserPages } from "../e2e/twoBrowserPages";

test.describe("browser compatibility matrix", () => {
  test("renders the playback control across browser engines", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const play = page.getByRole("button", { name: "Play" });
    await expect(play).toBeEnabled();
  });

  test("keeps the listening shell usable at a phone viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);

    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await expect(page.getByRole("button", { name: "Listen" })).toBeVisible();
    await expect(page.locator(".mobile-listen-transport")).toBeVisible();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "More" })
      .click();
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });

  test("exposes the microphone consent path for a recording guest", async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const response = await host.request.post("/api/shares/record", {
          data: { path: projectPath },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        const body = (await response.json()) as {
          room: { guest: { token: string } };
        };

        await guest.addInitScript(() => {
          (window as unknown as { __SHARECUT_E2E?: boolean }).__SHARECUT_E2E =
            true;
          const mediaDevices = navigator.mediaDevices;
          if (mediaDevices) {
            mediaDevices.getUserMedia = async () => {
              const audio = new AudioContext();
              const source = audio.createOscillator();
              const destination = audio.createMediaStreamDestination();
              source.connect(destination);
              source.start();
              return destination.stream;
            };
          }
        });
        await guest.goto(`/rec/${body.room.guest.token}?e2e=1`);
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
          guest.getByRole("button", { name: "Allow microphone" }),
        ).toBeVisible();
        await guest.getByRole("button", { name: "Allow microphone" }).click();
        await expect(guest.getByLabel("Level")).toBeVisible({
          timeout: 15_000,
        });
      });
    });
  });
});
