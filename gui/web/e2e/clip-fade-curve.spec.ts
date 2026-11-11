import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";
import { ensureInspected, inspectSelection, openProject } from "./stageNav";

type SavedClip = {
  id: string;
  fade_in_ms: number;
  fade_out_ms: number;
  fade_in_curve?: string;
  fade_out_curve?: string;
};
type Command = { type: string; payload: Record<string, unknown> };

async function savedClips(page: Page, path = e2eProjectPath, trackId?: string) {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(path)}&phase=full`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    clips: { tracks: Record<string, SavedClip[]> };
  };
  return Object.entries(body.clips.tracks)
    .filter(([id]) => trackId === undefined || id === trackId)
    .flatMap(([, clips]) => clips);
}

async function savedClip(page: Page, clipId: string) {
  const clip = (await savedClips(page)).find((row) => row.id === clipId);
  if (!clip) throw new Error("clip missing from saved snapshot");
  return clip;
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

const shape = (page: Page, name: string): Locator =>
  page.getByRole("group", { name: new RegExp(`^${name}`) });

async function undo(page: Page) {
  await page.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Z");
}

test.describe("Clip inspector fade shape", () => {
  test("a click saves one SetClipFade with the full baseline and one Undo restores it", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const commands = recordCommands(page);
    const block = page.locator(".lane-row .clip-block").first();
    const clipId = await block.getAttribute("data-clip-id");
    if (!clipId) throw new Error("clip lacks identity");
    const before = await savedClip(page, clipId);
    await block.click();
    await inspectSelection(page);

    const group = shape(page, "Fade in shape");
    await expect(group.getByRole("button", { name: "Linear" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectPageAxeClean(page, ".sys-inspector");

    await group.getByRole("button", { name: "Equal power" }).click();
    await expect
      .poll(async () => (await savedClip(page, clipId)).fade_in_curve)
      .toBe("equal_power");
    const sent = ofType(commands, "SetClipFade");
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({
      clip_id: clipId,
      fade_in_ms: before.fade_in_ms,
      fade_out_ms: before.fade_out_ms,
      fade_in_curve: "equal_power",
      expected: {
        fade_in_ms: before.fade_in_ms,
        fade_out_ms: before.fade_out_ms,
        fade_in_curve: "linear",
        fade_out_curve: "linear",
      },
    });
    await expect(
      group.getByRole("button", { name: "Equal power" }),
    ).toHaveAttribute("aria-pressed", "true");

    await undo(page);
    await expect
      .poll(async () => (await savedClip(page, clipId)).fade_in_curve)
      .toBeUndefined();
    expect(ofType(commands, "UndoHistory")).toHaveLength(1);
    await expect(group.getByRole("button", { name: "Linear" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("a fade length edit on a curved clip is not refused", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const commands = recordCommands(page);
    const block = page.locator(".lane-row .clip-block").first();
    const clipId = await block.getAttribute("data-clip-id");
    if (!clipId) throw new Error("clip lacks identity");
    const before = await savedClip(page, clipId);
    await block.click();
    await inspectSelection(page);

    await shape(page, "Fade out shape")
      .getByRole("button", { name: "S" })
      .click();
    await expect
      .poll(async () => (await savedClip(page, clipId)).fade_out_curve)
      .toBe("s");

    await page.getByRole("spinbutton", { name: "Fade in" }).press("ArrowUp");
    await expect
      .poll(async () => (await savedClip(page, clipId)).fade_in_ms)
      .toBe(before.fade_in_ms + 1);
    const lengths = ofType(commands, "SetClipFade").filter(
      (command) =>
        command.payload.fade_in_curve === undefined &&
        command.payload.fade_out_curve === undefined,
    );
    expect(lengths).toHaveLength(1);
    expect(lengths[0].payload.expected).toEqual({
      fade_in_ms: before.fade_in_ms,
      fade_out_ms: before.fade_out_ms,
      fade_in_curve: "linear",
      fade_out_curve: "s",
    });
    expect((await savedClip(page, clipId)).fade_out_curve).toBe("s");
    await expect(page.getByRole("alert")).toHaveCount(0);

    await undo(page);
    await expect
      .poll(async () => (await savedClip(page, clipId)).fade_in_ms)
      .toBe(before.fade_in_ms);
    await undo(page);
    await expect
      .poll(async () => (await savedClip(page, clipId)).fade_out_curve)
      .toBeUndefined();
  });

  test("several clips show Mixed, apply one absolute shape in one command and undo together", async ({
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
    const trackId = await lane.getAttribute("data-track-id");
    if (!trackId) throw new Error("lane lacks identity");
    const curves = async () =>
      (await savedClips(page, e2eProjectPath, trackId)).map(
        (clip) => clip.fade_in_curve ?? "linear",
      );
    try {
      await expect(async () => {
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await lane.locator(".clip-block").nth(1).click();
        await ensureInspected(page);
        await expect(page.getByText(/^\d+ clips$/)).toHaveCount(0, {
          timeout: 1500,
        });
      }).toPass({ timeout: 15_000 });
      await shape(page, "Fade in shape")
        .getByRole("button", { name: "S" })
        .click();
      await expect.poll(curves).toEqual(["linear", "s"]);

      await page.keyboard.press("Escape");
      await lane.locator(".clip-block").first().click();
      await lane
        .locator(".clip-block")
        .nth(1)
        .click({ modifiers: ["Shift"] });
      await inspectSelection(page);
      const mixed = page.getByRole("group", { name: "Fade in shape, Mixed" });
      await expect(mixed).toBeVisible();
      await expect(mixed.locator('[aria-pressed="true"]')).toHaveCount(0);

      await mixed.getByRole("button", { name: "Equal power" }).click();
      await expect.poll(curves).toEqual(["equal_power", "equal_power"]);
      const [many] = ofType(commands, "SetClipsFade");
      expect(many.payload.fades).toEqual([
        expect.objectContaining({ fade_in_curve: "equal_power" }),
        expect.objectContaining({ fade_in_curve: "equal_power" }),
      ]);
      expect(ofType(commands, "SetClipsFade")).toHaveLength(1);
      await expect(
        shape(page, "Fade in shape").getByRole("button", {
          name: "Equal power",
        }),
      ).toHaveAttribute("aria-pressed", "true");

      await undo(page);
      await expect.poll(curves).toEqual(["linear", "s"]);
    } finally {
      await page.keyboard.press("Escape");
      const edits = commands.filter((command) =>
        ["SetClipsFade", "SetClipFade", "SplitAtTime"].includes(command.type),
      ).length;
      const already = undone();
      for (let step = already; step < edits; step++) {
        await page.keyboard.press("ControlOrMeta+Z");
        await expect.poll(undone).toBe(step + 1);
      }
      await expect(lane.locator(".clip-block")).toHaveCount(1);
    }
  });
});

test.describe("Clip fade shape on a share", () => {
  test("an Editor link may set a clip's fade shape and a Viewer link may not", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const clipId = await page
        .locator(".lane-row .clip-block")
        .first()
        .getAttribute("data-clip-id");
      if (!clipId) throw new Error("clip lacks identity");
      const before = (await savedClips(page, projectPath)).find(
        (c) => c.id === clipId,
      );
      if (!before) throw new Error("clip missing");
      const send = async (token: string) =>
        page.request.post(`/api/review/${token}/daw/document/command`, {
          data: {
            type: "SetClipFade",
            command_id: randomUUID(),
            client_id: `clip-fade-curve-${randomUUID()}`,
            client_seq: 1,
            payload: {
              clip_id: clipId,
              fade_in_ms: before.fade_in_ms,
              fade_out_ms: before.fade_out_ms,
              fade_in_curve: "s",
              expected: {
                fade_in_ms: before.fade_in_ms,
                fade_out_ms: before.fade_out_ms,
                fade_in_curve: "linear",
                fade_out_curve: "linear",
              },
            },
          },
        });

      const viewer = await send(
        await createReviewShare(page, projectPath, "viewer"),
      );
      expect(viewer.status()).toBe(403);
      expect(
        (await savedClips(page, projectPath)).find((c) => c.id === clipId)
          ?.fade_in_curve,
      ).toBeUndefined();

      const editor = await send(
        await createReviewShare(page, projectPath, "editor"),
      );
      expect(editor.ok(), await editor.text()).toBe(true);
      expect(
        (await savedClips(page, projectPath)).find((c) => c.id === clipId)
          ?.fade_in_curve,
      ).toBe("s");
    });
  });
});
