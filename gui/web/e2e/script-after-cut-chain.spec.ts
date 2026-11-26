import { expect, type Page, test } from "@playwright/test";
import { deferred } from "../src/test/deferred";
import { historyHead } from "./documentCommand";
import { e2eBaseURL, e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { goToStage, openProject } from "./stageNav";
import {
  openScript,
  SCRIPT_SELECTED,
  SCRIPT_WORD,
  servePendingEditsCleared,
} from "./transcriptEdit";

/**
 * After a Script words cut, Tab selects the next occurrence and Backspace cuts
 * it, so the chain Tab, Backspace, Tab, Backspace runs to the last occurrence
 * with focus staying in the Script; the Tab after the last one is native.
 * The cuts are made on a disposable copy so no other spec sees them.
 */
let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-after-cut-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

const focusInScript = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.closest(".sys-script-body") != null,
  );

async function holdAppliedWordCut(page: Page) {
  const reply = deferred();
  await page.route(
    (url) => url.pathname === "/api/document/command",
    async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        request.postDataJSON()?.type !== "EditSelectedRange"
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      await reply.promise;
      await route.fulfill({ response });
    },
  );
  return reply;
}

async function walkChain(page: Page, settled: boolean) {
  await servePendingEditsCleared(page);
  if (!settled)
    await page.route(
      /\/api\/document\/state\?.*phase=detail/,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.continue();
      },
    );
  await openProject(page, projectPath);
  const body = await openScript(page);
  const first = body.locator(SCRIPT_WORD).filter({ hasText: /^the$/ }).first();
  await first.click();
  await page.keyboard.press("Backspace");
  const toast = page.locator(".ui-toast-message");
  await expect(toast).toContainText(/Cut .* · \d+ more/);
  const remaining = Number(/(\d+) more/.exec(await toast.innerText())![1]);
  expect(remaining).toBeGreaterThan(1);
  if (settled) {
    await expect.poll(() => focusInScript(page)).toBe(true);
    await body.focus();
    await expect(body).toBeFocused();
  }

  const picked = page.locator(SCRIPT_SELECTED);
  for (let left = remaining; left > 0; left -= 1) {
    await page.keyboard.press("Tab");
    await expect(picked).toHaveCount(1);
    await expect(picked).toHaveText("the");
    await page.keyboard.press("Backspace");
    await expect(picked).toHaveCount(0);
    if (settled) await expect.poll(() => focusInScript(page)).toBe(true);
  }

  await expect.poll(() => focusInScript(page)).toBe(true);
  await page.keyboard.press("Tab");
  await expect.poll(() => focusInScript(page)).toBe(false);
  await expect(picked).toHaveCount(0);
}

test("Tab then Backspace walks every remaining occurrence with focus kept in the Script", async ({
  page,
}) => {
  await walkChain(page, true);
});

test("a Tab pressed while the cut's transcript refresh is still loading waits for it", async ({
  page,
}) => {
  await walkChain(page, false);
});

test("Tab moves focus without selecting another match after leaving Edit", async ({
  page,
}) => {
  await servePendingEditsCleared(page);
  await openProject(page, projectPath);
  const body = await openScript(page);
  const beforeCut = await historyHead(page, projectPath);
  await body.locator(SCRIPT_WORD).filter({ hasText: /^the$/ }).first().click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".ui-toast-message")).toContainText(
    /Cut .* · \d+ more/,
  );
  await expect.poll(() => historyHead(page, projectPath)).not.toBe(beforeCut);
  const cut = await historyHead(page, projectPath);
  const selected = body.locator(SCRIPT_SELECTED);
  await expect(selected).toHaveCount(0);
  await expect.poll(() => focusInScript(page)).toBe(true);

  await goToStage(page, "review");
  await goToStage(page, "edit");
  await expect(body.locator(SCRIPT_WORD).first()).toBeVisible();

  const focusedText = body.locator(
    ":is(.sys-script-word, .sys-seam-hit):focus",
  );
  for (let i = 0; i < 40 && !(await focusedText.count()); i += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(focusedText).toHaveCount(1);
  await expect(selected).toHaveCount(0);
  expect(await historyHead(page, projectPath)).toBe(cut);

  await page.keyboard.press("Tab");
  await expect(selected).toHaveCount(0);
  await expect.poll(() => focusInScript(page)).toBe(false);
  expect(await historyHead(page, projectPath)).toBe(cut);
});

for (const cutReply of ["settled", "pending"] as const) {
  test(`undoing another tab’s cut does not resume Tab with the previous cut reply ${cutReply}`, async ({
    page,
    browser,
  }) => {
    await servePendingEditsCleared(page);
    await openProject(page, projectPath);
    const body = await openScript(page);
    const peerContext = await browser.newContext({
      baseURL: e2eBaseURL,
      viewport: page.viewportSize() ?? undefined,
      storageState: await page.context().storageState(),
    });
    const reply =
      cutReply === "pending" ? await holdAppliedWordCut(page) : null;
    try {
      const peer = await peerContext.newPage();
      await servePendingEditsCleared(peer);
      await openProject(peer, projectPath);
      const peerBody = await openScript(peer);
      const repeated = body.locator(SCRIPT_WORD).filter({ hasText: /^the$/ });
      const peerWord = peerBody
        .locator(SCRIPT_WORD)
        .filter({ hasText: /^my$/ });
      const peerWordInScript = body
        .locator(SCRIPT_WORD)
        .filter({ hasText: /^my$/ });
      const toast = page.locator(".ui-toast-message");
      await page.bringToFront();
      const headBefore = await historyHead(page, projectPath);
      await repeated.first().click();
      await page.keyboard.press("Backspace");
      await expect
        .poll(() => historyHead(page, projectPath))
        .not.toBe(headBefore);
      const cutHead = await historyHead(page, projectPath);
      await expect(repeated).toHaveCount(3);
      await expect(
        peerBody.locator(SCRIPT_WORD).filter({ hasText: /^the$/ }),
      ).toHaveCount(3);
      if (reply) {
        await expect(toast).toHaveCount(0);
      } else {
        await expect(toast).toContainText(/Cut .* · \d+ more/);
        await expect(body.locator(".sys-seam-hit:focus")).toHaveCount(1);
      }

      await peer.bringToFront();
      await expect(peerWordInScript).toHaveCount(2);
      await peerWord.first().click();
      await peer.keyboard.press("Backspace");
      const peerToast = peer.locator(".ui-toast");
      await expect(peerToast.locator(".ui-toast-message")).toContainText(
        /Cut .*my/,
      );
      await expect.poll(() => historyHead(page, projectPath)).not.toBe(cutHead);
      await expect(peerWordInScript).toHaveCount(1);

      await peerToast.getByRole("button", { name: "Undo" }).click();
      await expect.poll(() => historyHead(page, projectPath)).toBe(cutHead);
      await expect(peerWordInScript).toHaveCount(2);
      await page.bringToFront();
      if (reply) {
        await expect(toast).toHaveCount(0);
        reply.resolve();
        await expect(toast).toContainText(/Cut .* · \d+ more/);
        await body.locator(".sys-seam-hit").first().focus();
      }

      await expect(body.locator(".sys-seam-hit:focus")).toHaveCount(1);
      const picked = body.locator(SCRIPT_SELECTED);
      await expect(picked).toHaveCount(0);
      await page.keyboard.press("Tab");
      await expect(picked).toHaveCount(0);
      await expect.poll(() => focusInScript(page)).toBe(false);
      expect(await historyHead(page, projectPath)).toBe(cutHead);
    } finally {
      reply?.resolve();
      await peerContext.close();
    }
  });
}

for (const preview of [false, true]) {
  test(`the same cut’s Undo and Redo pause and restore Tab ${preview ? "after a mix preview" : "without a preview"}`, async ({
    page,
  }) => {
    const seenHeads = new Set<string>();
    if (preview) {
      page.on("websocket", (socket) => {
        if (new URL(socket.url()).pathname !== "/api/host/ws") return;
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload !== "string") return;
          const event = JSON.parse(payload);
          const head = event.snapshot?.history?.head_id;
          if (event.plane === "document" && typeof head === "string") {
            seenHeads.add(head);
          }
        });
      });
    }
    await servePendingEditsCleared(page);
    await openProject(page, projectPath);
    const body = await openScript(page);
    const repeated = body.locator(SCRIPT_WORD).filter({ hasText: /^the$/ });
    const initialCount = await repeated.count();
    const headBefore = await historyHead(page, projectPath);

    await repeated.first().click();
    await page.keyboard.press("Backspace");
    const toast = page.locator(".ui-toast");
    await expect(toast.locator(".ui-toast-message")).toContainText(
      /Cut .* · \d+ more/,
    );
    await expect
      .poll(() => historyHead(page, projectPath))
      .not.toBe(headBefore);
    const cutHead = await historyHead(page, projectPath);
    await expect(repeated).toHaveCount(initialCount - 1);

    if (preview) {
      const render = await page.request.post("/api/pipeline/render-preview", {
        data: { path: projectPath },
      });
      expect(render.ok()).toBe(true);
      await expect
        .poll(() => historyHead(page, projectPath), { timeout: 30_000 })
        .not.toBe(cutHead);
      const previewHead = await historyHead(page, projectPath);
      await expect.poll(() => seenHeads.has(previewHead)).toBe(true);
      await expect(repeated).toHaveCount(initialCount - 1);
    }

    const picked = body.locator(SCRIPT_SELECTED);
    const undo = (
      preview ? page.locator(".sys-app-header-host") : toast
    ).getByRole("button", { name: "Undo", exact: true });
    await undo.click();
    await expect(repeated).toHaveCount(initialCount);
    await expect.poll(() => historyHead(page, projectPath)).not.toBe(cutHead);
    expect(headBefore).toBe("root");
    expect(await historyHead(page, projectPath)).not.toBe(headBefore);
    await repeated.first().focus();
    await page.keyboard.press("Tab");
    await expect(picked).toHaveCount(0);
    await expect.poll(() => focusInScript(page)).toBe(false);

    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(repeated).toHaveCount(initialCount - 1);
    await expect.poll(() => historyHead(page, projectPath)).toBe(cutHead);

    await expect(picked).toHaveCount(0);
    await body.locator(".sys-seam-hit").first().focus();

    await page.keyboard.press("Tab");
    await expect(picked).toHaveText("the");
  });
}

test("Tab waits when the next cut is visible before its reply arrives", async ({
  page,
}) => {
  await servePendingEditsCleared(page);
  await openProject(page, projectPath);
  const body = await openScript(page);
  const words = body.locator(SCRIPT_WORD).filter({ hasText: /^the$/ });
  const picked = body.locator(SCRIPT_SELECTED);
  await words.first().click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".ui-toast-message")).toContainText(
    /Cut .* · \d+ more/,
  );
  await expect(words).toHaveCount(3);
  await page.keyboard.press("Tab");
  await expect(picked).toHaveText("the");

  const reply = await holdAppliedWordCut(page);
  try {
    await page.keyboard.press("Backspace");
    await expect(words).toHaveCount(2);
    await body.locator(".sys-seam-hit").first().focus();
    await page.keyboard.press("Tab");
    await expect(body.locator(".sys-seam-hit:focus")).toHaveCount(1);
  } finally {
    reply.resolve();
  }
  await expect(picked).toHaveText("the");
  await expect.poll(() => focusInScript(page)).toBe(true);
});
