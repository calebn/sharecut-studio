import { expect, type Locator, type Page } from "@playwright/test";
import {
  openAt,
  projectPath,
  receipt,
  SIZES,
  test,
} from "../e2e/compactChromeFixture";
import { historyHead, postDocumentCommand } from "../e2e/documentCommand";
import { inspectSelectionByKey } from "../e2e/stageNav";
import { lane } from "../e2e/touchTimeline";

test.use({ hasTouch: true, reducedMotion: "reduce" });

async function openPointInspector(
  page: Page,
  size: { width: number; height: number },
) {
  await openAt(page, size);
  const point = page.locator(`${lane} [data-hit-id="env-c"]`);
  await point.focus();
  await page.keyboard.press("Enter");
  await inspectSelectionByKey(page);
  const inspector = page.locator(".sys-inspector");
  await expect(inspector).toBeVisible();
  if (size.width < 768) {
    const grip = page.getByRole("slider", { name: "Sheet height" });
    await grip.focus();
    await page.keyboard.press("End");
    await expect(inspector).toHaveAttribute("data-detent", "full");
  }
  const time = inspector.getByRole("spinbutton", { name: "Time", exact: true });
  const level = inspector.getByRole("spinbutton", {
    name: "Level",
    exact: true,
  });
  await expect(time).toBeVisible();
  await expect(level).toBeVisible();
  await expect(point).toHaveAttribute("data-selected");
  return { inspector, time, level, point };
}

async function saveLevelAndFocusUndo(page: Page, level: Locator) {
  await level.focus();
  await page.keyboard.press("ArrowUp");
  const toast = page.locator(".ui-toast-region--app .ui-toast").first();
  await expect(toast).toBeVisible();
  const message =
    (await toast.locator(".ui-toast-message").textContent()) ?? "";
  const undo = toast.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeEnabled();
  await undo.focus();
  await expect(undo).toBeFocused();
  return { toast, message, undo };
}

async function advancePeerHistory(page: Page) {
  const before = await historyHead(page, projectPath);
  const peer = await page.context().newPage();
  try {
    await postDocumentCommand(
      peer,
      "e2e-feedback-focus-peer",
      "AddChapter",
      { time: 25, title: "Focus recovery peer edit" },
      projectPath,
    );
  } finally {
    await peer.close();
  }
  await expect.poll(() => historyHead(page, projectPath)).not.toBe(before);
  return { before, after: await historyHead(page, projectPath) };
}

for (const profile of [
  { name: "phone", size: SIZES.portrait },
  { name: "card", size: { width: 1280, height: 720 } },
] as const) {
  test.describe(`feedback focus ${profile.name}`, () => {
    test("returns invalidated Undo focus to the visible current Inspector Close", async ({
      page,
    }, info) => {
      test.setTimeout(60_000);
      const { inspector, time, level, point } = await openPointInspector(
        page,
        profile.size,
      );
      const close = inspector.getByRole("button", {
        name: "Close",
        exact: true,
      });
      await expect(close).toBeVisible();
      const beforeEditFields = {
        time: await time.getAttribute("aria-valuenow"),
        level: await level.getAttribute("aria-valuenow"),
      };
      const { toast, message, undo } = await saveLevelAndFocusUndo(page, level);
      const savedFields = {
        time: await time.getAttribute("aria-valuenow"),
        level: await level.getAttribute("aria-valuenow"),
      };
      expect(savedFields.level).not.toBe(beforeEditFields.level);
      await expect(point).toHaveAttribute("data-selected");
      const heads = await advancePeerHistory(page);
      await expect(toast).toBeVisible();
      await expect(toast.locator(".ui-toast-message")).toHaveText(message);
      await expect(undo).toHaveCount(0);
      await expect(inspector).toBeVisible();
      await expect(close).toBeVisible();
      await expect(close).toBeFocused();
      await expect(point).toHaveAttribute("data-selected");
      await expect(time).toHaveAttribute(
        "aria-valuenow",
        savedFields.time ?? "",
      );
      await expect(level).toHaveAttribute(
        "aria-valuenow",
        savedFields.level ?? "",
      );
      await receipt(info, `feedback-focus-${profile.name}-recovery`, {
        profile: profile.name,
        historyHeads: heads,
        selectedPoint: await point.getAttribute("data-hit-id"),
        fields: {
          beforeEdit: beforeEditFields,
          savedBeforePeer: savedFields,
          after: {
            time: await time.getAttribute("aria-valuenow"),
            level: await level.getAttribute("aria-valuenow"),
          },
        },
        focusAfter: await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          className: (document.activeElement as HTMLElement | null)?.className,
          label: document.activeElement?.getAttribute("aria-label"),
        })),
      });
    });
  });
}

test("outside focus stays on header Undo when a peer invalidates toast Undo", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const { inspector, level } = await openPointInspector(page, SIZES.portrait);
  const { toast, message } = await saveLevelAndFocusUndo(page, level);
  const headerUndo = page
    .locator(".sys-app-header-host")
    .getByRole("button", { name: "Undo", exact: true });
  await expect(headerUndo).toBeEnabled();
  await headerUndo.focus();
  await expect(headerUndo).toBeFocused();
  const heads = await advancePeerHistory(page);
  await expect(toast).toBeVisible();
  await expect(toast.locator(".ui-toast-message")).toHaveText(message);
  await expect(
    toast.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(0);
  await expect(headerUndo).toBeFocused();
  await expect(inspector).toBeVisible();
  await receipt(info, "feedback-focus-outside-focus", {
    historyHeads: heads,
    focusAfter: await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      className: (document.activeElement as HTMLElement | null)?.className,
      label: document.activeElement?.getAttribute("aria-label"),
    })),
  });
});
