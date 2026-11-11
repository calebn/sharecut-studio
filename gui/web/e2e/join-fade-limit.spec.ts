import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import {
  inspectSelection,
  openProject,
  openProjectMenuItem,
  setScrub,
} from "./stageNav";

type Command = { type: string; payload: Record<string, unknown> };
type SavedClip = { id: string; fade_in_ms: number; fade_out_ms: number };

const LABEL = "Longest automatic join fade";

async function savedClipsSlice(page: Page) {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  expect(response.ok()).toBe(true);
  return (
    (await response.json()) as {
      clips: {
        tracks: Record<string, SavedClip[]>;
        join_fade_limit_ms: number;
        join_fade_limit_default_ms: number;
      };
    }
  ).clips;
}

function recordCommands(page: Page) {
  const commands: Command[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/api/document/command")
    )
      commands.push(request.postDataJSON() as Command);
  });
  return commands;
}

const ofType = (commands: Command[], type: string) =>
  commands.filter((command) => command.type === type);

test.describe("Longest automatic join fade", () => {
  test("the Settings row saves the episode's limit, Undo restores it and the reset dot clears it", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const commands = recordCommands(page);
    const before = await savedClipsSlice(page);
    await openProjectMenuItem(page, "Settings…");
    const sheet = page.getByRole("dialog", { name: "Settings" });
    const field = sheet.getByRole("spinbutton", { name: LABEL });
    await expect(field).toHaveAttribute(
      "aria-valuenow",
      String(before.join_fade_limit_ms),
    );
    await expect(field).toHaveAttribute("aria-valuemax", "200");
    await expect(
      sheet.getByText("Fades you set yourself are not limited.", {
        exact: false,
      }),
    ).toBeVisible();
    await expectPageAxeClean(page, ".settings-sheet");

    await setScrub(page, field, "120");
    await expect
      .poll(async () => (await savedClipsSlice(page)).join_fade_limit_ms)
      .toBe(120);
    await expect(field).toHaveAttribute("aria-valuenow", "120");
    expect(ofType(commands, "SetJoinFadeLimit").map((c) => c.payload)).toEqual([
      { ms: 120 },
    ]);

    await sheet
      .getByRole("button", {
        name: `Reset ${LABEL} to ${before.join_fade_limit_default_ms} ms`,
      })
      .click();
    await expect
      .poll(async () => (await savedClipsSlice(page)).join_fade_limit_ms)
      .toBe(before.join_fade_limit_default_ms);
    expect(ofType(commands, "SetJoinFadeLimit").at(-1)?.payload).toEqual({
      ms: null,
    });

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect
      .poll(async () => (await savedClipsSlice(page)).join_fade_limit_ms)
      .toBe(120);
    await page.keyboard.press("ControlOrMeta+Z");
    await expect
      .poll(async () => (await savedClipsSlice(page)).join_fade_limit_ms)
      .toBe(before.join_fade_limit_ms);
  });

  test("a 400 ms fade typed in the clip Inspector is kept, whatever the limit", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const commands = recordCommands(page);
    const block = page.locator(".lane-row .clip-block").first();
    const clipId = await block.getAttribute("data-clip-id");
    if (!clipId) throw new Error("clip lacks identity");
    await block.click();
    await inspectSelection(page);

    const fadeIn = page.getByRole("spinbutton", { name: "Fade in" });
    await setScrub(page, fadeIn, "400");
    await expect
      .poll(async () => {
        const slice = await savedClipsSlice(page);
        return Object.values(slice.tracks)
          .flat()
          .find((clip) => clip.id === clipId)?.fade_in_ms;
      })
      .toBe(400);
    await expect(fadeIn).toHaveAttribute("aria-valuenow", "400");
    expect(ofType(commands, "SetClipFade")).toHaveLength(1);
    expect(ofType(commands, "SetClipFade")[0].payload.fade_in_ms).toBe(400);

    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect
      .poll(async () => {
        const slice = await savedClipsSlice(page);
        return Object.values(slice.tracks)
          .flat()
          .find((clip) => clip.id === clipId)?.fade_in_ms;
      })
      .not.toBe(400);
  });
});
