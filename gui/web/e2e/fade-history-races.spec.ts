import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

test("refuses a fade drafted before the Undo projection arrives, then saves a fresh retry", async ({
  page,
}) => {
  let hold = false;
  const messages: Array<() => void> = [];
  await page.routeWebSocket(/\/api\/host\/ws/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (hold) messages.push(() => socket.send(message));
      else socket.send(message);
    });
  });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  const block = page.locator(".lane-row").first().locator(".clip-block");
  await expect(block).toHaveCount(1);
  const id = await block.getAttribute("data-clip-id");
  const pair = async () => {
    const response = await page.request.get(
      `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
    );
    const project = (await response.json()) as {
      clips: {
        tracks: Record<
          string,
          Array<{ id: string; fade_in_ms: number; fade_out_ms: number }>
        >;
      };
    };
    const clip = Object.values(project.clips.tracks)
      .flat()
      .find((row) => row.id === id);
    if (!clip) throw new Error("The test clip is missing");
    return [clip.fade_in_ms, clip.fade_out_ms];
  };
  const documentState = async () => {
    const response = await page.request.get(
      `/api/document/state?path=${encodeURIComponent(e2eProjectPath)}`,
    );
    return (await response.json()) as { server_seq: number; history: unknown };
  };
  expect(await pair()).toEqual([0, 0]);
  await block.locator(".fade-corner.in").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(pair).toEqual([1, 0]);
  await expect(block.locator(".fade-corner.in")).not.toHaveClass(/zero/);

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let undoReachedServer = false;
  let staleReply:
    | { status: number; code: string | undefined; payload: unknown }
    | undefined;
  await page.route(
    (url) => url.pathname === "/api/document/command",
    async (route) => {
      const body = route.request().postDataJSON() as {
        type: string;
        payload: unknown;
      };
      if (body.type === "UndoHistory") {
        hold = true;
        const response = await route.fetch();
        undoReachedServer = true;
        await gate;
        await route.fulfill({ response });
      } else if (
        undoReachedServer &&
        body.type === "SetClipFade" &&
        !staleReply
      ) {
        const response = await route.fetch();
        staleReply = {
          status: response.status(),
          code: response.headers()["x-sharecut-error-code"],
          payload: body.payload,
        };
        await route.fulfill({ response });
      } else {
        await route.continue();
      }
    },
  );
  try {
    await page.keyboard.press("ControlOrMeta+Z");
    await expect.poll(() => undoReachedServer).toBe(true);
    await expect.poll(pair).toEqual([0, 0]);
    const savedAfterUndo = await readFile(e2eProjectPath, "utf8");
    const stateAfterUndo = await documentState();
    await block.locator(".fade-corner.out").focus();
    await page.keyboard.press("ArrowLeft");
    release();
    await expect.poll(() => staleReply?.status).toBe(409);
    expect(staleReply).toEqual({
      status: 409,
      code: "clip_fade_changed",
      payload: {
        clip_id: id,
        fade_in_ms: 1,
        fade_out_ms: 1,
        expected: { fade_in_ms: 1, fade_out_ms: 0 },
      },
    });
    await expect(page.locator(".ui-toast-region--app")).toContainText(
      "This clip changed. Nothing was saved. Adjust the fade again.",
    );
    expect(await pair()).toEqual([0, 0]);
    expect(await readFile(e2eProjectPath, "utf8")).toBe(savedAfterUndo);
    const refusedState = await documentState();
    expect(refusedState.server_seq).toBe(stateAfterUndo.server_seq);
    expect(refusedState.history).toEqual(stateAfterUndo.history);
    hold = false;
    for (const send of messages.splice(0)) send();
    await expect(block.locator(".fade-corner.in")).toHaveClass(/zero/);
    await block.locator(".fade-corner.out").focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(pair).toEqual([0, 1]);
    expect((await documentState()).server_seq).toBe(
      stateAfterUndo.server_seq + 1,
    );
  } finally {
    hold = false;
    release();
    for (const send of messages) send();
  }
});
