import { expect, test } from "@playwright/test";
import {
  createRecordRoom,
  markSharecutE2e,
  openHostDevices,
  openHostRecordRoom,
} from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

test("host Devices explains a pending microphone request and clears the note on denial", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(browser, [{}], async ([host]) => {
      await markSharecutE2e(host);
      await host.addInitScript(() => {
        Object.defineProperty(navigator, "mediaDevices", {
          value: {
            enumerateDevices: async () => [],
            getUserMedia: () =>
              new Promise<MediaStream>((_resolve, reject) => {
                window.addEventListener(
                  "deny-test-host-mic",
                  () =>
                    reject(
                      new DOMException("Permission denied", "NotAllowedError"),
                    ),
                  { once: true },
                );
              }),
          },
        });
      });
      await openProject(host, projectPath, { query: "&e2e=1" });
      await createRecordRoom(host, projectPath);
      const devices = await openHostDevices(await openHostRecordRoom(host));
      const note = devices.getByText(
        "Still waiting for microphone permission.",
      );
      await expect(note).toBeVisible({ timeout: 15_000 });
      await host.evaluate(() =>
        window.dispatchEvent(new Event("deny-test-host-mic")),
      );
      await expect(note).toHaveCount(0);
      await expect(
        devices.getByRole("button", { name: "How to allow the microphone" }),
      ).toBeVisible();
    });
  });
});
