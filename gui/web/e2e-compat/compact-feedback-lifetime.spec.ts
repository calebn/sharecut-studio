import { expect } from "@playwright/test";
import {
  compactHistory,
  edited,
  openAt,
  original,
  projectPath,
  receipt,
  SIZES,
  savedEnvelope,
  test,
} from "../e2e/compactChromeFixture";
import { newFinger } from "../e2e/finger";
import {
  controlGeometry,
  exposeControl,
  wheelInspector,
} from "../e2e/inspectorResponsiveEvidence";
import type { InteractionReceipt } from "../e2e/interactionEvidence";
import { centerOf, lane, watchCommands } from "../e2e/touchTimeline";

test.use({ hasTouch: true });
test.describe.configure({ timeout: 240_000 });

test("clipped saved feedback pauses its remaining visible lifetime", async ({
  page,
  context,
  browserName,
}, info) => {
  await openAt(page, SIZES.landscape);
  const finger = await newFinger(context, page, browserName);
  const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
  await finger.down(at);
  await page.waitForTimeout(60);
  await finger.up();
  await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await page.waitForTimeout(600);
  const discovery: InteractionReceipt[] = [];
  const commands = watchCommands(page);
  await page
    .getByRole("button", { name: "Envelope point 0.01 s later", exact: true })
    .click();
  await expect.poll(() => savedEnvelope(page)).toEqual(edited);
  const card = page.locator(".ui-toast-region--app .ui-toast");
  const headerUndo = compactHistory(page).getByRole("button", {
    name: "Undo",
    exact: true,
  });
  const checkHeader = async (stage: string) => {
    const geometry = await controlGeometry(headerUndo);
    await receipt(info, stage, geometry);
    expect(geometry.fullyVisible).toBe(true);
    expect(geometry.hitsControl).toBe(true);
    expect(geometry.rect.width).toBeGreaterThanOrEqual(44);
    expect(geometry.rect.height).toBeGreaterThanOrEqual(44);
  };
  await checkHeader("timer-initial-header");
  await exposeControl(page, card, discovery);
  await headerUndo.focus();
  await page.mouse.move(0, 0);
  const initial = await controlGeometry(card);
  expect(initial.fullyVisible).toBe(true);
  await page.waitForTimeout(3000);
  await wheelInspector(page, discovery, 400);
  await page.mouse.move(0, 0);
  const clipped = await controlGeometry(card);
  expect(clipped.fullyVisible).toBe(false);
  expect(
    await card.evaluate((element) => ({
      hover: element.matches(":hover"),
      focus: element.contains(document.activeElement),
    })),
  ).toEqual({ hover: false, focus: false });
  await checkHeader("timer-clipped-header");
  await receipt(info, "timer-actual-clipped-card", clipped);
  await info.attach("timer-clipped", {
    body: await page.screenshot({ path: info.outputPath("timer-clipped.png") }),
    contentType: "image/png",
  });
  await page.waitForTimeout(9000);
  await expect(card).toHaveCount(1);
  await expect.poll(() => savedEnvelope(page)).toEqual(edited);
  expect(commands.map((command) => command.type)).toEqual(["SetEnvelope"]);
  await exposeControl(page, card, discovery);
  await page.mouse.move(0, 0);
  const restored = await controlGeometry(card);
  expect(restored.fullyVisible).toBe(true);
  const dismiss = card.getByRole("button", { name: "Dismiss" });
  const action = await controlGeometry(dismiss);
  expect(action.fullyVisible).toBe(true);
  expect(action.hitsControl).toBe(true);
  expect(action.rect.width).toBeGreaterThanOrEqual(44);
  expect(action.rect.height).toBeGreaterThanOrEqual(44);
  await receipt(info, "timer-restored-card-and-action", {
    restored,
    action,
    discovery,
  });
  await info.attach("timer-restored", {
    body: await page.screenshot({
      path: info.outputPath("timer-restored.png"),
    }),
    contentType: "image/png",
  });
  await expect(card).toHaveCount(0, { timeout: 6500 });
  await checkHeader("timer-expired-header");
  await expect.poll(() => savedEnvelope(page)).toEqual(edited);
});

for (const width of [667, 844]) {
  test.describe(`guarded feedback short width${width}`, () => {
    test("guarded feedback actions retain their saved edit and touch targets", async ({
      page,
      context,
      browserName,
    }, info) => {
      test.setTimeout(60_000);
      await openAt(page, { width, height: 360 });
      await page
        .getByRole("button", {
          name: "Reorder track reference",
          exact: true,
        })
        .click();
      await expect(page.locator(".modifier-inspector")).toBeVisible();
      const savedOrder = async () => {
        const response = await page.request.get(
          `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
        );
        const project = (await response.json()) as { tracks: { id: string }[] };
        return project.tracks.map((track) => track.id);
      };
      const before = await savedOrder();
      const commands = watchCommands(page);
      const header = page.locator(".bottom-sheet-header");
      const checkHeader = async (stage: string) => {
        for (const name of ["Undo", "Redo", "Expand to half height", "Close"]) {
          const geometry = await controlGeometry(
            header.getByRole("button", { name, exact: true }),
          );
          await receipt(info, `${stage}-${name}`, geometry);
          expect(geometry.fullyVisible).toBe(true);
          expect(geometry.hitsControl).toBe(true);
          expect(geometry.rect.width).toBeGreaterThanOrEqual(44);
          expect(geometry.rect.height).toBeGreaterThanOrEqual(44);
        }
      };
      await header.getByRole("button", { name: "Close", exact: true }).focus();
      await page.keyboard.press("ArrowDown");
      await expect.poll(savedOrder).toEqual([before[1], before[0]]);
      const liveCard = page.locator(".ui-toast-region--app .ui-toast");
      await expect(liveCard).toContainText("Reordered track");
      await liveCard.evaluate((card) =>
        card.setAttribute("data-guarded-host-proof", "same-card"),
      );
      await header.getByRole("button", { name: "Close", exact: true }).click();
      const finger = await newFinger(context, page, browserName);
      const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
      await finger.down(at);
      await page.waitForTimeout(60);
      await finger.up();
      await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
      await page.locator("html").evaluate((html) => {
        html.style.fontSize = "32px";
      });
      await page.waitForTimeout(600);
      const card = page.locator(".ui-toast-region--inspector-flow .ui-toast");
      await expect(card).toHaveAttribute(
        "data-guarded-host-proof",
        "same-card",
      );
      await expect(card).toContainText("Reordered track");
      await checkHeader("active-feedback-before-discovery");
      const discovery: InteractionReceipt[] = [];
      for (const name of ["Dismiss", "Undo"]) {
        const action = card.getByRole("button", { name, exact: true });
        await exposeControl(page, action, discovery);
        const geometry = await controlGeometry(action);
        await receipt(info, `guarded-feedback-${name}`, geometry);
        expect(geometry.fullyVisible).toBe(true);
        expect(geometry.hitsControl).toBe(true);
        expect(geometry.rect.width).toBeGreaterThanOrEqual(44);
        expect(geometry.rect.height).toBeGreaterThanOrEqual(44);
        await checkHeader(`discovered-${name}`);
      }
      await receipt(info, "guarded-card-active", {
        card: await controlGeometry(card),
        discovery,
      });
      await info.attach("guarded-card-active", {
        body: await page.screenshot({
          path: info.outputPath("guarded-card-active.png"),
        }),
        contentType: "image/png",
      });
      await card.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(savedOrder).toEqual(before);
      expect(commands.map((command) => command.type)).toEqual([
        "ReorderTrack",
        "UndoHistory",
      ]);
      await expect.poll(() => savedEnvelope(page)).toEqual(original);
      await checkHeader("guarded-undo-restored");
      await receipt(info, "guarded-undo-saved-order", {
        before,
        after: await savedOrder(),
        commands,
      });
    });
  });
}
