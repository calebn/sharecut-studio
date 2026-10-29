import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import {
  openProject,
  openProjectMenu,
  type Panel,
  projectMenuButton,
  saveStatus,
  openPanel as stageOpenPanel,
} from "./stageNav";
import { setTheme, withAppearance } from "./theme";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1024 },
  { name: "phone", width: 360, height: 800 },
] as const;

type PanelName = "Comments" | "History" | "Queue" | "Pipeline";

async function expectEditorAxeClean(
  page: Page,
  selector: string,
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .include(selector)
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual(
    [],
  );
}

async function openPanel(page: Page, name: PanelName): Promise<void> {
  await stageOpenPanel(page, name.toLowerCase() as Panel);
}

async function expectTextFits(locator: Locator): Promise<void> {
  await expect(async () => {
    const widths = await locator.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
      overflow: [...element.querySelectorAll("*")]
        .filter(
          (child) =>
            child.getBoundingClientRect().right >
            element.getBoundingClientRect().right + 1,
        )
        .map((child) => ({
          tag: child.tagName,
          class: child.className,
          width: child.getBoundingClientRect().width,
          text: child.textContent?.slice(0, 80),
        }))
        .slice(0, 12),
    }));
    expect(widths.scroll, JSON.stringify(widths)).toBeLessThanOrEqual(
      widths.client + 1,
    );
  }).toPass({ timeout: 5000 });
}

const panelThemes = withAppearance(VIEWPORTS);
const chapterThemes = withAppearance(VIEWPORTS, 1);

for (const [index, viewport] of VIEWPORTS.entries()) {
  const panelTheme = panelThemes[index]!.theme;
  const chapterTheme = chapterThemes[index]!.theme;
  test.describe(`Editor reading areas at ${viewport.name} size`, () => {
    test.use({ viewport });

    test(`keeps all editor panels reachable and named in ${panelTheme}`, async ({
      page,
    }) => {
      // History opens from a right-click on Undo, which stays disabled until the
      // project has a step to undo; the comment is that step.
      await postDocumentCommand(
        page,
        `e2e-panels-comment-${viewport.name}`,
        "AddComment",
        {
          body: `Panels reachable ${viewport.name}`,
          author: "Panels",
          timeline_start: 1,
          timeline_end: null,
          track_ids: [],
          action_texts: [],
        },
      );
      await openProject(page, e2eProjectPath);
      await expect(
        page
          .locator(".sys-header-history")
          .getByRole("button", { name: /^Undo/ }),
      ).toBeEnabled();
      await setTheme(page, panelTheme);
      await expect(
        page.locator(`.stage-frame--${viewport.name}`),
      ).toBeVisible();
      for (const [name, selector] of [
        ["Comments", ".comments-panel"],
        ["History", ".history-panel"],
        ["Queue", ".rv-stage"],
        ["Pipeline", ".sys-prepare"],
      ] as const) {
        await openPanel(page, name);
        await expect(page.locator(selector)).toBeVisible();
        await expectEditorAxeClean(page, selector);
        if (name === "History") {
          // History is a sheet over the stage: close it to reach the next panel.
          await page.keyboard.press("Escape");
          await expect(
            page.getByRole("dialog", { name: "History" }),
          ).toBeHidden();
        }
      }
      await expect(
        page.getByRole("heading", { name: "Sources", exact: true }),
      ).toBeVisible();
    });

    test("wraps long comments without moving reply or resolve controls sideways", async ({
      page,
    }) => {
      const body = `https://example.com/${viewport.name}/${"longpath".repeat(30)}`;
      await postDocumentCommand(
        page,
        `e2e-long-comment-${viewport.name}`,
        "AddComment",
        {
          body,
          author: "LongCommentAuthor".repeat(6),
          timeline_start: 1,
          timeline_end: null,
          track_ids: [],
          action_texts: [],
        },
      );
      await openProject(page, e2eProjectPath);
      await openPanel(page, "Comments");
      const card = page.locator(".comment-card").filter({ hasText: body });
      await expect(card).toBeVisible();
      await expectTextFits(card);
      await expectTextFits(card.locator(".comment-card-main"));
      await expectTextFits(card.locator(".comment-card-body"));
      const resolve = card.getByRole("button", {
        name: "Resolve",
        exact: true,
      });
      await resolve.scrollIntoViewIfNeeded();
      const box = await resolve.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      await expectEditorAxeClean(page, ".comments-panel");
    });

    test("keeps a maximum-length vocabulary entry and Remove action within the stage", async ({
      page,
    }) => {
      await openProject(page, e2eProjectPath);
      await openPanel(page, "Pipeline");
      const vocabulary = page.locator(".sys-vocab, .sys-chipinput").first();
      const term = `${viewport.name}-`.padEnd(100, "W");
      const input = page.getByLabel("Names and terms", { exact: true });
      await input.fill(term);
      await input.press("Enter");
      const remove = page.getByRole("button", {
        name: `Remove ${term}`,
        exact: true,
      });
      await expectTextFits(remove.locator(".."));
      await expectTextFits(vocabulary);
      await remove.scrollIntoViewIfNeeded();
      const box = await remove.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      await remove.click();
      await expect(remove).toHaveCount(0);
    });

    test(`wraps a long chapter title in its named inspector in ${chapterTheme}`, async ({
      page,
    }) => {
      const title = `${viewport.name}-`.padEnd(100, "X");
      await postDocumentCommand(
        page,
        `e2e-long-chapter-${viewport.name}`,
        "AddChapter",
        { time: 1, title },
      );
      try {
        if (viewport.name !== "desktop") {
          await rememberInspectorDetent(page, "half");
        }
        await openProject(page, e2eProjectPath);
        await setTheme(page, chapterTheme);
        if (viewport.name === "phone") await openPhoneTimeline(page);
        await page
          .getByRole("button", { name: `Chapter ${title}`, exact: true })
          .click();
        const inspector = page.locator(".modifier-inspector");
        await expect(
          inspector.getByRole("heading", { name: title, exact: true }),
        ).toBeVisible();
        await expect(
          inspector.getByRole("textbox", { name: "Chapter title" }),
        ).toHaveValue(title);
        await expect(
          inspector.getByRole("spinbutton", { name: "Chapter time" }),
        ).toHaveValue("1");
        await expectTextFits(inspector.locator(".modifier-header"));
        await expectTextFits(inspector);
        await expectEditorAxeClean(page, ".modifier-inspector");
      } finally {
        await postDocumentCommand(
          page,
          `e2e-remove-chapter-${viewport.name}`,
          "DeleteChapter",
          { time: 1, title },
        );
      }
    });
  });
}

const failedSaveInit = () => {
  // An unreadable offline queue is the Failed save state.
  indexedDB.open = () => {
    throw new Error("queue unreadable");
  };
};

async function headerScroll(header: Locator) {
  return header.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
}

test("tablet unreadable save indicator names the failure and the banner Retry has a full touch target", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 834, height: 1194 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(failedSaveInit);
    await openProject(page, e2eProjectPath);
    const status = page.getByRole("group", { name: "Save status" });
    await expect(status).toBeVisible();
    await expect(status.getByRole("alert")).toContainText("Save failed");
    const { scrollHeight, clientHeight } = await headerScroll(
      page.locator(".stage-frame-header"),
    );
    expect(scrollHeight, "failed header does not scroll").toBeLessThanOrEqual(
      clientHeight,
    );
    const attention = page.getByRole("region", {
      name: /Saved edits could not be read/,
    });
    await attention.locator("summary").click();
    const retry = attention.getByRole("button", { name: "Retry", exact: true });
    const retryBox = await retry.boundingBox();
    expect(retryBox).not.toBeNull();
    expect(retryBox!.width).toBeGreaterThanOrEqual(44);
    expect(retryBox!.height).toBeGreaterThanOrEqual(44);
    for (const offset of [-20, 0, 20]) {
      expect(
        await retry.evaluate((element, offset) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2 + offset,
          );
          return hit === element || (hit !== null && element.contains(hit));
        }, offset),
        `tap ${offset}px from centre reaches Retry`,
      ).toBe(true);
    }
    const reads = await page.evaluateHandle(() => {
      const reads = { attempts: 0 };
      indexedDB.open = () => {
        reads.attempts++;
        throw new Error("queue remains unreadable");
      };
      return reads;
    });
    await retry.click();
    await expect
      .poll(() => reads.evaluate((reads) => reads.attempts))
      .toBeGreaterThan(0);
    await expect(attention).toContainText(
      "Could not read saved edits on this device.",
    );
    await expect(retry).toBeVisible();
    await reads.dispose();
  } finally {
    await context.close();
  }
});

for (const state of ["saved", "failed"] as const) {
  test(`desktop header does not scroll while the save indicator is ${state}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    if (state === "failed") {
      await page.addInitScript(failedSaveInit);
    }
    await openProject(page, e2eProjectPath);
    await expect(
      state === "failed"
        ? page.getByRole("group", { name: "Save status" })
        : saveStatus(page),
    ).toBeVisible();
    const { scrollHeight, clientHeight } = await headerScroll(
      page.locator(".stage-frame-header"),
    );
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight);
  });
}

test("Project menu trigger closes on a second pointer click", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  const menu = await openProjectMenu(page);
  await expect(menu).toBeVisible();
  const trigger = projectMenuButton(page);
  await trigger.click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
