import fs from "node:fs";
import { expect, type Page, type Request, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { inspectSelection, inspectSelectionByKey } from "./stageNav";
import { setTheme, withAppearance } from "./theme";

const SHELLS = [
  { shell: "phone", viewport: { width: 360, height: 800 } },
  { shell: "desktop", viewport: { width: 1440, height: 900 } },
] as const;

type Seeded = {
  timeline: { tracks: { id: string }[] };
  editorial: { chapters: { time: number; title: string }[] };
  social: { clip_candidates: Record<string, unknown>[] };
};

function markerProject(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = JSON.parse(
    fs.readFileSync(fixture.projectPath, "utf8"),
  ) as Seeded;
  project.editorial.chapters = [{ time: 40, title: "Opening" }];
  project.social.clip_candidates = [
    {
      id: "e2e-social",
      track_id: project.timeline.tracks[0].id,
      start: 18,
      end: 24,
      score: 0.8,
      title_suggestion: "Inventory social",
    },
  ];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}

function recordWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (request: Request) => {
    const body = request.postData() ?? "";
    if (
      request.method() === "POST" &&
      /UpdateChapter|UpdateSocialClip/.test(body)
    )
      writes.push(body);
  });
  return (type: string) =>
    writes.filter((body) => body.includes(`"${type}"`)).length;
}

for (const { shell, viewport } of SHELLS) {
  for (const { cell: rootFont, theme, reducedMotion } of withAppearance([
    16, 32,
  ] as const)) {
    test.describe(`Marker Inspector ${shell} root${rootFont} ${theme}`, () => {
      test.use({
        viewport,
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });

      async function open(page: Page, projectPath: string) {
        if (shell === "phone") await rememberInspectorDetent(page, "full");
        await openHostShare(page, projectPath);
        await openPhoneTimeline(page);
        await setTheme(page, theme);
        await page.locator("html").evaluate((html, px) => {
          html.style.fontSize = `${px}px`;
        }, rootFont);
      }

      const sheet = (page: Page) => page.locator(".sys-inspector");

      test(`renames a chapter without closing the sheet and undoes each edit at root${rootFont}`, async ({
        page,
      }) => {
        await withShareableProject(
          async (projectPath) => {
            const count = recordWrites(page);
            await open(page, projectPath);
            await page
              .getByRole("button", { name: /^Chapter Opening,/ })
              .click();
            await inspectSelection(page);
            const dialog = sheet(page);
            await expect(dialog).toBeVisible();
            await expect(
              dialog.getByRole("heading", { name: "Chapter", exact: true }),
            ).toBeVisible();
            const title = dialog.getByRole("textbox", {
              name: "Title",
              exact: true,
            });
            await expect(title).toHaveValue("Opening");
            await expect(
              dialog.getByRole("spinbutton", { name: "Time" }),
            ).toHaveAttribute("aria-valuenow", "40");
            await expect(
              dialog.getByRole("button", { name: "Apply" }),
            ).toHaveCount(0);
            await expect(
              dialog.getByRole("button", { name: /Seek/ }),
            ).toHaveCount(0);
            await expectPageAxeClean(page, ".sys-inspector");

            await title.fill("Interview");
            await title.press("Enter");
            await expect(dialog).toBeVisible();
            await expect(title).toHaveValue("Interview");
            await expect(
              page.getByRole("button", { name: /^Chapter Interview,/ }),
            ).toBeVisible();
            expect(count("UpdateChapter")).toBe(1);
            await title.press("Tab");
            await expect(
              page.getByRole("button", { name: "Undo", exact: true }),
            ).toBeEnabled();
            await page
              .getByRole("button", { name: "Undo", exact: true })
              .dispatchEvent("click");
            await expect(
              page.getByRole("button", { name: /^Chapter Opening,/ }),
            ).toBeVisible();
          },
          undefined,
          markerProject,
        );
      });

      test(`moves a chapter from Time and escapes the title at root${rootFont}`, async ({
        page,
      }) => {
        await withShareableProject(
          async (projectPath) => {
            const count = recordWrites(page);
            await open(page, projectPath);
            await page
              .getByRole("button", { name: /^Chapter Opening,/ })
              .click();
            await inspectSelection(page);
            const dialog = sheet(page);
            const time = dialog.getByRole("spinbutton", { name: "Time" });
            await time.press("Enter");
            const input = dialog.getByRole("textbox", { name: "Time" });
            await input.fill("48");
            await input.press("Enter");
            await expect(
              page.getByRole("button", { name: /^Chapter Opening, .*48/ }),
            ).toBeVisible();
            expect(count("UpdateChapter")).toBe(1);
            await dialog.getByRole("spinbutton", { name: "Time" }).press("Tab");
            await page.keyboard.press("ControlOrMeta+z");
            await expect(
              page.getByRole("button", { name: /^Chapter Opening, 0:40/ }),
            ).toBeVisible();

            const title = dialog.getByRole("textbox", {
              name: "Title",
              exact: true,
            });
            await title.fill("x");
            await title.press("Escape");
            await expect(title).toHaveValue("Opening");
            await title.press("Escape");
            await expect(dialog).toHaveCount(0);
          },
          undefined,
          markerProject,
        );
      });

      test(`edits a social clip's title and range and passes axe at root${rootFont}`, async ({
        page,
      }) => {
        test.slow();
        await withShareableProject(
          async (projectPath) => {
            const count = recordWrites(page);
            await open(page, projectPath);
            await page
              .getByRole("button", { name: /^Clip idea Inventory social/ })
              .click();
            await inspectSelectionByKey(page);
            const dialog = sheet(page);
            await expect(
              dialog.getByRole("heading", { name: "Social clip", exact: true }),
            ).toBeVisible();
            await expect(
              dialog.getByRole("img", { name: "Quality 4 of 5" }),
            ).toBeVisible();
            const title = dialog.getByRole("textbox", {
              name: "Title",
              exact: true,
            });
            await expect(title).toHaveValue("Inventory social");
            for (const text of ["Score", "Approved", "Review required"])
              await expect(dialog.getByText(text)).toHaveCount(0);
            await expect(
              dialog.getByRole("button", { name: "Seek to start" }),
            ).toHaveCount(0);
            if (shell === "phone")
              expect(
                (await title.boundingBox())!.height,
              ).toBeGreaterThanOrEqual(44);
            await expectPageAxeClean(page, ".sys-inspector");

            const start = dialog.getByRole("spinbutton", { name: "Start" });
            await start.press("Enter");
            const input = dialog.getByRole("textbox", { name: "Start" });
            await input.fill("19");
            await input.press("Enter");
            await expect.poll(() => count("UpdateSocialClip")).toBe(1);
            await expect(
              page.getByRole("button", {
                name: /^Clip idea Inventory social, proposed, 0:19/,
              }),
            ).toBeVisible();
            await dialog
              .getByRole("spinbutton", { name: "Start" })
              .press("Tab");
            await page
              .getByRole("button", { name: "Undo", exact: true })
              .dispatchEvent("click");
            await expect(
              page.getByRole("button", {
                name: /^Clip idea Inventory social, proposed, 0:18/,
              }),
            ).toBeVisible();

            await title.fill("Bread");
            await title.press("Enter");
            await expect(
              page.getByRole("button", { name: /^Clip idea Bread/ }),
            ).toBeVisible();
            await title.press("Tab");
            await expect(
              page.getByRole("button", { name: "Undo", exact: true }),
            ).toBeEnabled();
            await page
              .getByRole("button", { name: "Undo", exact: true })
              .dispatchEvent("click");
            await expect(
              page.getByRole("button", { name: /^Clip idea Inventory social/ }),
            ).toBeVisible();
            await expectPageAxeClean(page, ".sys-inspector");
          },
          undefined,
          markerProject,
        );
      });
    });
  }
}
