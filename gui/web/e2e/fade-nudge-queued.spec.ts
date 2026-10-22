import { expect, type Route, test } from "@playwright/test";
import { hostOfflineQueueCount } from "./offlineQueue";
import { withShareableProject } from "./shareableProject";

type FadeCommand = { command_id: string; type: string };

test("a fade nudge that queues offline stays shown, then saves once online", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    const commands: FadeCommand[] = [];
    let offline = true;
    await page.route("**/api/document/command?*", async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const command = route.request().postDataJSON() as FadeCommand;
      if (command.type !== "SetClipFade") return route.continue();
      commands.push(command);
      return offline ? route.abort("failed") : route.continue();
    });
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    const block = page.locator(".lane-row").first().locator(".clip-block");
    await expect(block).toHaveCount(1);
    const clipId = await block.getAttribute("data-clip-id");
    await block.click();

    const fadeIn = page.getByLabel("Fade in ms");
    await expect(fadeIn).toHaveValue("0");
    await page
      .getByRole("group", { name: "Nudge fade in" })
      .getByRole("button", { name: "10 ms longer" })
      .click();

    await expect.poll(() => commands.length).toBe(1);
    await expect.poll(() => hostOfflineQueueCount(page, projectPath)).toBe(1);
    // The save has settled as queued; the value must not jump back to 0.
    await expect(fadeIn).toHaveValue("10");
    await expect(block.locator(".fade-corner.in")).not.toHaveClass(/zero/);

    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]?.command_id).toBe(commands[0]?.command_id);
    await expect.poll(() => hostOfflineQueueCount(page, projectPath)).toBe(0);
    await expect(fadeIn).toHaveValue("10");
    const serverFadeIn = async () => {
      const response = await page.request.get(
        `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
      );
      const saved = (await response.json()) as {
        clips: {
          tracks: Record<string, Array<{ id: string; fade_in_ms: number }>>;
        };
      };
      return Object.values(saved.clips.tracks)
        .flat()
        .find((row) => row.id === clipId)?.fade_in_ms;
    };
    await expect.poll(serverFadeIn).toBe(10);
  });
});
