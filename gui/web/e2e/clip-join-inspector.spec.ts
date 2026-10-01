import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("Clip inspector join control", () => {
  test("is axe-clean with a left neighbour and keeps focus order", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const lanes = page.locator(".lane-row");
    await expect(lanes.first().locator(".clip-block")).toHaveCount(1);
    // Shift+ArrowRight nudges the playhead 5 s; Mod+K splits the dialogue tracks there.
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(lanes.first().locator(".clip-block")).toHaveCount(2);
    try {
      await lanes.first().locator(".clip-block").nth(1).click();
      const joinMode = page.getByLabel("Incoming transition");
      await expect(joinMode).toBeVisible();
      await expectPageAxeClean(page, ".inspector");
      await page.getByLabel("Transition length ms").fill("30");
      await joinMode.focus();
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("Transition length ms")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Apply transition length" }),
      ).toBeFocused();
      await expectPageAxeClean(page, ".inspector");
    } finally {
      // Leave the shared live E2E project as later specs expect it.
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(lanes.first().locator(".clip-block")).toHaveCount(1);
    }
  });
});

test.describe("Clip inspector fade controls", () => {
  test("commits one keyboard fade step and one Undo restores the saved pair", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    const snapshotResponse = await page.request.get(
      `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
    );
    expect(snapshotResponse.ok()).toBe(true);
    const snapshot = (await snapshotResponse.json()) as {
      clips: {
        tracks: Record<
          string,
          { id: string; fade_in_ms: number; fade_out_ms: number }[]
        >;
      };
    };
    const firstBlock = page.locator(".lane-row .clip-block").first();
    const selectButtonName = await firstBlock
      .getByRole("button", { name: /^Select clip / })
      .getAttribute("aria-label");
    const visibleClipId = selectButtonName?.match(/^Select clip ([^,]+)/)?.[1];
    const clip = Object.values(snapshot.clips.tracks)
      .flat()
      .find((row) => row.id === visibleClipId);
    if (clip === undefined)
      throw new Error("visible clip is missing from the project snapshot");
    await firstBlock.click();

    const fadeIn = page.getByLabel("Fade in ms");
    await expect(fadeIn).toBeEnabled();
    const before = Number(await fadeIn.inputValue());
    const maximum = Number(await fadeIn.getAttribute("max"));
    const key = before < maximum ? "ArrowRight" : "ArrowLeft";
    const expected = before + (key === "ArrowRight" ? 1 : -1);
    const fadeRequest = page.waitForRequest((request) => {
      if (!request.url().includes("/api/document/command")) return false;
      try {
        const body = request.postDataJSON();
        return body?.type === "SetClipFade";
      } catch {
        return false;
      }
    });
    await fadeIn.focus();
    await page.keyboard.press(key);
    const request = await fadeRequest;
    expect(request.postDataJSON()).toMatchObject({
      type: "SetClipFade",
      payload: {
        clip_id: clip.id,
        fade_in_ms: expected,
        fade_out_ms: clip.fade_out_ms,
      },
    });
    const response = await request.response();
    expect(response?.ok()).toBe(true);

    await expect
      .poll(async () => {
        const result = await page.request.get(
          `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
        );
        const current = (await result.json()) as typeof snapshot;
        return Object.values(current.clips.tracks)
          .flat()
          .find((row) => row.id === clip.id)?.fade_in_ms;
      })
      .toBe(expected);

    const undoRequest = page.waitForRequest((candidate) => {
      if (!candidate.url().includes("/api/document/command")) return false;
      try {
        return candidate.postDataJSON()?.type === "UndoHistory";
      } catch {
        return false;
      }
    });
    await page.keyboard.press("ControlOrMeta+Z");
    const undo = await undoRequest;
    expect(undo.postDataJSON()).toMatchObject({ type: "UndoHistory" });
    const undoResponse = await undo.response();
    expect(undoResponse?.ok()).toBe(true);
    const undoResult = (await undoResponse?.json()) as {
      snapshot: {
        project: {
          clips: { tracks: Record<string, (typeof clip)[]> };
        };
      };
    };
    const restoredClip = Object.values(undoResult.snapshot.project.clips.tracks)
      .flat()
      .find((row) => row.id === clip.id);
    if (restoredClip === undefined)
      throw new Error("Undo response omitted the clip");
    expect(restoredClip).toMatchObject({
      fade_in_ms: clip.fade_in_ms,
      fade_out_ms: clip.fade_out_ms,
    });
  });
});
