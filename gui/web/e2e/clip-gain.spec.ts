import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";
import { inspectSelection, openProject, setScrub } from "./stageNav";

type SavedClip = { id: string; gain_db?: number };
type Command = { type: string; payload: Record<string, unknown> };

async function savedTracks(page: Page, path = e2eProjectPath) {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(path)}&phase=full`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    clips: { tracks: Record<string, SavedClip[]> };
  };
  return body.clips.tracks;
}

async function savedClips(page: Page, path = e2eProjectPath) {
  return Object.values(await savedTracks(page, path)).flat();
}

async function savedGainsByTrack(page: Page) {
  return Object.fromEntries(
    Object.entries(await savedTracks(page)).map(([track, clips]) => [
      track,
      clips.map((clip) => clip.gain_db ?? 0),
    ]),
  );
}

async function savedGain(page: Page, clipId: string) {
  const clip = (await savedClips(page)).find((row) => row.id === clipId);
  if (!clip) throw new Error("clip missing from saved snapshot");
  return clip.gain_db ?? 0;
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

test.describe("Clip inspector gain", () => {
  test("a key step saves one SetClipGain with its baseline and one Undo restores it", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const commands = recordCommands(page);
    const block = page.locator(".lane-row .clip-block").first();
    const clipId = await block.getAttribute("data-clip-id");
    if (!clipId) throw new Error("clip lacks identity");
    const before = await savedGain(page, clipId);
    await block.click();
    await inspectSelection(page);

    const gain = page.getByRole("spinbutton", { name: "Gain" });
    await expect(gain).not.toHaveAttribute("aria-readonly", "true");
    await expect(gain).toHaveAttribute("aria-valuemin", "-60");
    await expect(gain).toHaveAttribute("aria-valuemax", "12");
    await expect(gain).toHaveAttribute("aria-valuenow", String(before));
    await expectPageAxeClean(page, ".sys-inspector");

    await gain.press("ArrowUp");
    await expect.poll(async () => savedGain(page, clipId)).toBe(before + 0.5);
    const sent = ofType(commands, "SetClipGain");
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({
      clip_id: clipId,
      gain_db: before + 0.5,
      expected: { gain_db: before },
    });

    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect.poll(async () => savedGain(page, clipId)).toBe(before);
    expect(ofType(commands, "UndoHistory")).toHaveLength(1);
  });

  test("a drag only previews the number and its release saves once", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const commands = recordCommands(page);
    const block = page.locator(".lane-row .clip-block").first();
    const clipId = await block.getAttribute("data-clip-id");
    if (!clipId) throw new Error("clip lacks identity");
    await block.click();
    await inspectSelection(page);

    const gain = page.getByRole("spinbutton", { name: "Gain" });
    await gain.scrollIntoViewIfNeeded();
    const box = await gain.boundingBox();
    if (!box) throw new Error("Gain field has no box");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 10, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, y, { steps: 3 });
    await page.mouse.move(box.x + 50, y, { steps: 5 });
    await expect(gain).not.toHaveAttribute("aria-valuenow", "0");
    expect(ofType(commands, "SetClipGain")).toHaveLength(0);
    await page.mouse.up();

    await expect.poll(() => ofType(commands, "SetClipGain").length).toBe(1);
    const [sent] = ofType(commands, "SetClipGain");
    expect(sent.payload.expected).toEqual({ gain_db: 0 });
    expect(Number(sent.payload.gain_db)).toBeGreaterThan(0);
    await expect
      .poll(async () => savedGain(page, clipId))
      .toBe(sent.payload.gain_db);

    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect.poll(async () => savedGain(page, clipId)).toBe(0);
    expect(ofType(commands, "UndoHistory")).toHaveLength(1);
  });

  test("several clips share one absolute Gain, show Mixed, and reset together", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const commands = recordCommands(page);
    const lane = page.locator(".lane-row").first();
    await expect(lane.locator(".clip-block")).toHaveCount(1);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(lane.locator(".clip-block")).toHaveCount(2);
    const undone = () => ofType(commands, "UndoHistory").length;
    const deselect = async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("spinbutton", { name: "Gain" })).toHaveCount(
        0,
      );
      await page.keyboard.press("Escape");
      await expect(
        page.locator('.clip-block [aria-pressed="true"]'),
      ).toHaveCount(0);
    };
    try {
      await inspectSelection(page);
      const gain = page.getByRole("spinbutton", { name: "Gain" });
      await expect(gain).toHaveAttribute("aria-valuetext", /^0\.0 dB$/);

      await setScrub(page, gain, "4");
      await expect
        .poll(() => savedGainsByTrack(page))
        .toEqual({ reference: [0, 4], guest: [0, 4] });
      const [many] = ofType(commands, "SetClipsGain");
      expect(many.payload.gains).toEqual([
        expect.objectContaining({ gain_db: 4, expected: { gain_db: 0 } }),
        expect.objectContaining({ gain_db: 4, expected: { gain_db: 0 } }),
      ]);

      await deselect();
      await lane.locator(".clip-block").nth(1).click();
      await inspectSelection(page);
      await page.getByRole("spinbutton", { name: "Gain" }).press("ArrowUp");
      await expect
        .poll(() => savedGainsByTrack(page))
        .toEqual({ reference: [0, 4.5], guest: [0, 4] });

      await deselect();
      await lane.locator(".clip-block").first().click();
      await lane
        .locator(".clip-block")
        .nth(1)
        .click({ modifiers: ["Shift"] });
      await inspectSelection(page);
      await expect(
        page.getByRole("spinbutton", { name: "Gain" }),
      ).toHaveAttribute("aria-valuetext", "Mixed");
      await page.getByRole("button", { name: /^Reset Gain to 0/ }).click();
      await expect
        .poll(() => savedGainsByTrack(page))
        .toEqual({ reference: [0, 0], guest: [0, 4] });
      expect(ofType(commands, "SetClipsGain")).toHaveLength(2);
    } finally {
      await page.keyboard.press("Escape");
      const edits = commands.filter((command) =>
        ["SetClipsGain", "SetClipGain", "SplitAtTime"].includes(command.type),
      ).length;
      for (let step = 0; step < edits; step++) {
        await page.keyboard.press("ControlOrMeta+Z");
        await expect.poll(undone).toBe(step + 1);
      }
      await expect(lane.locator(".clip-block")).toHaveCount(1);
    }
  });
});

test.describe("Clip gain on a share", () => {
  test("an Editor link may set a clip's gain and a Viewer link may not", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const clipId = await page
        .locator(".lane-row .clip-block")
        .first()
        .getAttribute("data-clip-id");
      if (!clipId) throw new Error("clip lacks identity");
      const send = async (token: string) =>
        page.request.post(`/api/review/${token}/daw/document/command`, {
          data: {
            type: "SetClipGain",
            command_id: randomUUID(),
            client_id: `clip-gain-${randomUUID()}`,
            client_seq: 1,
            payload: { clip_id: clipId, gain_db: -3, expected: { gain_db: 0 } },
          },
        });

      const viewer = await send(
        await createReviewShare(page, projectPath, "viewer"),
      );
      expect(viewer.status()).toBe(403);
      expect(
        (await savedClips(page, projectPath)).find((c) => c.id === clipId)
          ?.gain_db ?? 0,
      ).toBe(0);

      const editor = await send(
        await createReviewShare(page, projectPath, "editor"),
      );
      expect(editor.ok(), await editor.text()).toBe(true);
      expect(
        (await savedClips(page, projectPath)).find((c) => c.id === clipId)
          ?.gain_db,
      ).toBe(-3);
    });
  });
});
