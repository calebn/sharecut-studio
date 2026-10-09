import { expect, test } from "@playwright/test";
import { postHistoryMove } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import { projectJson } from "./touchTimeline";

test("refreshes a refused fade before retry while peer projections stay delayed", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    let hold = false;
    const messages: Array<() => void> = [];
    await page.routeWebSocket(/\/api\/host\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (hold) messages.push(() => socket.send(message));
        else socket.send(message);
      });
    });
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    const block = page.locator(".lane-row").first().locator(".clip-block");
    await expect(block).toHaveCount(1);
    const id = await block.getAttribute("data-clip-id");
    const pair = async () => {
      const project = await projectJson(page, projectPath);
      const clip = Object.values(project.clips.tracks)
        .flat()
        .find((row) => row.id === id);
      if (!clip) throw new Error("The test clip is missing");
      return [clip.fade_in_ms, clip.fade_out_ms];
    };
    expect(await pair()).toEqual([0, 0]);
    await block.locator(".fade-corner.in").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(pair).toEqual([1, 0]);
    await expect(block.locator(".fade-corner.in")).not.toHaveClass(/zero/);
    hold = true;
    try {
      await postHistoryMove(
        page,
        "peer-fade-recovery",
        "UndoHistory",
        projectPath,
      );
      expect(await pair()).toEqual([0, 0]);
      const refusal = page.waitForResponse((response) => {
        const body = response.request().postDataJSON();
        return body?.type === "SetClipFade" && response.status() === 409;
      });
      await block.locator(".fade-corner.out").focus();
      await page.keyboard.press("ArrowLeft");
      const rejected = await refusal;
      expect(rejected.headers()["x-sharecut-error-code"]).toBe(
        "clip_fade_changed",
      );
      expect(rejected.request().postDataJSON().payload).toEqual({
        clip_id: id,
        fade_in_ms: 1,
        fade_out_ms: 1,
        expected: { fade_in_ms: 1, fade_out_ms: 0 },
      });
      await expect(page.locator(".ui-toast-region")).toContainText(
        "This clip changed. Nothing was saved. Adjust the fade again.",
      );
      await expect(block.locator(".fade-corner.in")).toHaveClass(/zero/);
      await expect(block.locator(".fade-corner.in")).toHaveAccessibleName(
        /in 0 ms/,
      );
      await expect(block.locator(".fade-corner.out")).toHaveAccessibleName(
        /out 0 ms/,
      );
      expect(await pair()).toEqual([0, 0]);
      const retry = page.waitForResponse((response) => {
        const body = response.request().postDataJSON();
        return body?.type === "SetClipFade" && response.status() === 200;
      });
      await block.locator(".fade-corner.out").focus();
      await page.keyboard.press("ArrowLeft");
      const accepted = await retry;
      expect(accepted.request().postDataJSON().payload).toEqual({
        clip_id: id,
        fade_in_ms: 0,
        fade_out_ms: 1,
        expected: { fade_in_ms: 0, fade_out_ms: 0 },
      });
      await expect.poll(pair).toEqual([0, 1]);
    } finally {
      hold = false;
      for (const send of messages) send();
    }
  });
});
