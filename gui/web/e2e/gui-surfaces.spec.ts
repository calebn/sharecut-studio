import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { PipelineConfigResponse } from "../src/types/pipeline";
import { setByPath } from "../src/utils/configPath";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openTransportMenu } from "./overlayReachability";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { setTheme } from "./theme";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1024 },
  { name: "phone", width: 360, height: 800 },
] as const;

type PanelName = "Comments" | "History" | "Impact" | "Tighten" | "Pipeline";

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
  if ((page.viewportSize()?.width ?? 0) < 720) {
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "More", exact: true })
      .click();
    const back = page.getByRole("button", { name: "← More", exact: true });
    if (await back.isVisible()) await back.click();
    await page
      .locator(".mobile-more-list")
      .getByRole("button", { name, exact: true })
      .click();
  } else {
    await page
      .getByLabel("Editor panels")
      .getByRole("button", { name, exact: true })
      .click();
  }
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

for (const viewport of VIEWPORTS) {
  test.describe(`Editor reading areas at ${viewport.name} size`, () => {
    test.use({ viewport });

    for (const theme of ["light", "dark"] as const) {
      test(`keeps all editor panels reachable and named in ${theme}`, async ({
        page,
      }) => {
        await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
        await setTheme(page, theme);
        await expect(
          page.locator(`.daw-shell--${viewport.name}`),
        ).toBeVisible();
        for (const [name, selector] of [
          ["Comments", ".comments-panel"],
          ["History", ".history-panel"],
          ["Impact", ".impact-panel"],
          ["Tighten", ".tighten-panel"],
          ["Pipeline", ".pipeline-panel"],
        ] as const) {
          await openPanel(page, name);
          await expect(page.locator(selector)).toBeVisible();
          await expectEditorAxeClean(page, selector);
        }
        await expect(
          page.getByRole("button", { name: "Run pipeline", exact: true }),
        ).toBeVisible();
      });
    }

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
      await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
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

    test("keeps a maximum-length vocabulary entry and Remove action within the panel", async ({
      page,
    }) => {
      await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
      await openPanel(page, "Pipeline");
      const vocabulary = page.getByRole("region", {
        name: "Transcription vocabulary",
      });
      const term = `${viewport.name}-`.padEnd(100, "W");
      await vocabulary.getByLabel("Terms", { exact: true }).fill(term);
      await vocabulary
        .getByRole("button", { name: "Add term", exact: true })
        .click();
      const remove = vocabulary.getByRole("button", {
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

    for (const theme of ["light", "dark"] as const) {
      test(`wraps a long chapter title in its named inspector in ${theme}`, async ({
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
          if (viewport.name === "phone") {
            await rememberInspectorDetent(page, "half");
          }
          await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
          await setTheme(page, theme);
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
    }
  });
}

test("phone pipeline step parameters trap focus, close on Escape, and restore the trigger", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await openPanel(page, "Pipeline");
  const step = page.locator(".pipeline-step-select").first();
  await expect(step).toBeVisible();
  await step.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Step parameters",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(step).toHaveAttribute("aria-expanded", "true");
  expect(
    await dialog.evaluate((element) => element.closest("[inert]")),
  ).toBeNull();
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await expectEditorAxeClean(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(step).toBeFocused();
  await expect(step).toHaveAttribute("aria-expanded", "false");
});

test("phone pipeline hands focus to a missing Whisper model dialog and back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const response = await page.request.get(
    `/api/pipeline/config?path=${encodeURIComponent(e2eProjectPath)}`,
  );
  expect(response.ok()).toBe(true);
  const config = (await response.json()) as PipelineConfigResponse;
  const currentModel = config.whisper_models?.[0];
  if (!currentModel) throw new Error("The Whisper catalog must contain models");
  const models = (config.whisper_models ?? []).map((model) => ({
    ...model,
    cached: model.id === currentModel.id,
  }));
  expect(models.length).toBeGreaterThan(1);
  const pickerConfig: PipelineConfigResponse = {
    ...config,
    config: setByPath(config.config, "transcribe.model", currentModel.id),
    components: {
      ...config.components,
      whisper: {
        ...config.components.whisper,
        ok: true,
        model: currentModel.id,
      },
    },
    whisper_models: models,
  };
  await page.route("**/api/pipeline/config**", async (route) => {
    await route.fulfill({
      response,
      json: pickerConfig,
    });
  });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await openPanel(page, "Pipeline");
  await page
    .getByRole("button", { name: "Transcribe tracks", exact: true })
    .click();
  const parameters = page.getByRole("dialog", {
    name: "Step parameters",
    exact: true,
  });
  const picker = parameters.getByRole("combobox");
  const originalModel = await picker.inputValue();
  expect(originalModel).toBe(currentModel.id);
  const missingModel = models.find((model) => model.id !== originalModel);
  expect(missingModel).toBeDefined();
  expect(missingModel?.cached).toBe(false);
  await picker.selectOption(missingModel!.id);
  const download = page.getByRole("dialog", {
    name: "Download Whisper model?",
    exact: true,
  });
  await expect(download).toBeVisible();
  await expect(parameters).toHaveCount(0);
  await expect(
    download.getByRole("button", { name: "Download", exact: true }),
  ).toBeFocused();
  expect(
    await download.evaluate((element) => element.closest("[inert]")),
  ).toBeNull();
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await download.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await expectEditorAxeClean(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  await expect(download).toHaveCount(0);
  await expect(parameters).toBeVisible();
  await expect(parameters.getByRole("combobox")).toHaveValue(originalModel);
  expect(
    await parameters.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(parameters).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Transcribe tracks", exact: true }),
  ).toBeFocused();
});

test("transport menu trigger closes on a second pointer click", async ({
  page,
}) => {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  const menu = await openTransportMenu(page);
  await expect(menu).toBeVisible();
  const trigger = page.getByRole("button", { name: "Menu", exact: true });
  await trigger.click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
