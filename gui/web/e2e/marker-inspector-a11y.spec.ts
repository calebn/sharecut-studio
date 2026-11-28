import fs from "node:fs";
import { expect, type Page, type Request, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { contrastRatio } from "./contrastRatio";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { inspectSelection, inspectSelectionByKey } from "./stageNav";
import { setTheme, withAppearance } from "./theme";

async function undo(page: Page) {
  await page.locator(".sys-inspector").getByRole("heading").first().click();
  await page.keyboard.press("ControlOrMeta+z");
}

const SHELLS = [
  { shell: "phone", viewport: { width: 360, height: 800 } },
  { shell: "desktop", viewport: { width: 1440, height: 900 } },
] as const;

type Seeded = {
  timeline: { tracks: { id: string }[] };
  editorial: { chapters: { time: number; title: string }[] };
  social: { clip_candidates: Record<string, unknown>[] };
};

function markerProject(prefix: string, qualityBoundary = false) {
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
      score: qualityBoundary ? 0.09 : 0.8,
      title_suggestion: "Inventory social",
    },
  ];
  if (qualityBoundary) {
    project.social.clip_candidates.push({
      id: "manual-e2e",
      track_id: project.timeline.tracks[0].id,
      start: 30,
      end: 35,
      score: 0,
      reasons: ["manual"],
      title_suggestion: "Manual social",
    });
  }
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

test("Quality meter dots stay distinct in light, dark and forced colors", async ({
  page,
}) => {
  await page.setViewportSize(SHELLS[1].viewport);
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      await page
        .getByRole("button", { name: /^Clip idea Inventory social/ })
        .click();
      await inspectSelectionByKey(page);
      const meter = page.getByRole("img", { name: "Quality 4 of 5" });
      await expect(meter).toBeVisible();
      const empty = meter.locator(".sys-dots-dot:not([data-filled])");
      const filled = meter.locator(".sys-dots-dot[data-filled]");
      await expect(empty).toHaveCount(1);
      await expect(filled).toHaveCount(4);

      for (const appearance of ["light", "dark", "forced"] as const) {
        await setTheme(page, appearance === "light" ? "light" : "dark");
        await page.emulateMedia({
          forcedColors: appearance === "forced" ? "active" : "none",
        });
        const surface = await empty.evaluate((dot) => {
          for (
            let ancestor = dot.parentElement;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            const color = getComputedStyle(ancestor).backgroundColor;
            if (color !== "rgba(0, 0, 0, 0)") return color;
          }
          throw new Error("Missing opaque Inspector surface");
        });
        const ring = await empty.evaluate(
          (dot) => getComputedStyle(dot).borderTopColor,
        );
        const ink = await filled
          .first()
          .evaluate((dot) => getComputedStyle(dot).backgroundColor);
        expect
          .soft(contrastRatio(ring, surface), `${appearance} empty ring`)
          .toBeGreaterThanOrEqual(3);
        expect
          .soft(contrastRatio(ink, surface), `${appearance} filled dot`)
          .toBeGreaterThanOrEqual(3);
      }
    },
    undefined,
    markerProject,
  );
});

test("Quality distinguishes zero filled dots from a manually added clip", async ({
  page,
}) => {
  await page.setViewportSize(SHELLS[1].viewport);
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      const inspector = page.locator(".sys-inspector");

      await page
        .getByRole("button", { name: /^Clip idea Inventory social/ })
        .click();
      await inspectSelectionByKey(page);
      const meter = inspector.getByRole("img", { name: "Quality 0 of 5" });
      await expect(meter).toBeVisible();
      await expect(meter.locator(".sys-dots-dot")).toHaveCount(5);
      await expect(meter.locator("[data-filled]")).toHaveCount(0);

      await page.getByRole("button", { name: /Manual social/ }).click();
      await inspectSelectionByKey(page);
      await expect(
        inspector.getByRole("textbox", { name: "Title" }),
      ).toHaveValue("Manual social");
      await expect(
        inspector.getByRole("img", { name: /^Quality/ }),
      ).toHaveCount(0);
      await expect(inspector.getByText("Quality", { exact: true })).toHaveCount(
        0,
      );
    },
    undefined,
    (prefix) => markerProject(prefix, true),
  );
});

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
            if (shell === "phone") {
              const gap = await title.evaluate((field) => {
                const label = field
                  .closest(".sys-inspector-row")!
                  .querySelector(".sys-inspector-label")!;
                const text = document.createRange();
                text.selectNodeContents(label);
                const labelBox = text.getBoundingClientRect();
                const fieldBox = field.getBoundingClientRect();
                return Math.max(
                  fieldBox.left - labelBox.right,
                  fieldBox.top - labelBox.bottom,
                );
              });
              expect(gap, "the Title label clears its input").toBeGreaterThan(
                0,
              );
            }
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
            await undo(page);
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
            const inspect = page
              .getByRole("group", { name: /^(Selection|Edit) actions$/ })
              .getByRole("button", { name: "Inspect", exact: true });
            const tools = page.getByRole("button", {
              name: /^Tools(, (Timeline|Script))?(, range armed)?$/,
            });
            const folded = shell === "phone" && !(await inspect.isVisible());
            const opener = folded ? tools : inspect;
            if (shell === "phone") await expect(opener).toBeVisible();
            await inspectSelection(page);
            const dialog = sheet(page);
            const time = dialog.getByRole("spinbutton", { name: "Time" });
            await expect(time).toBeVisible();
            if (shell === "phone") {
              expect(
                await page.evaluate(
                  () => matchMedia("(pointer: fine)").matches,
                ),
              ).toBe(true);
              expect(
                (await time.boundingBox())?.height,
                "the phone's Time target stays full height with a mouse",
              ).toBeGreaterThanOrEqual(44);
            }
            await time.press("Enter");
            const input = dialog.getByRole("textbox", { name: "Time" });
            await input.fill("48");
            await input.press("Enter");
            await expect(
              page.getByRole("button", { name: /^Chapter Opening, .*48/ }),
            ).toBeVisible();
            expect(count("UpdateChapter")).toBe(1);
            await undo(page);
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
            if (shell === "phone") {
              const active = await page.evaluate(() => ({
                tag: document.activeElement?.tagName,
                label: document.activeElement?.getAttribute("aria-label"),
                text: document.activeElement?.textContent?.trim().slice(0, 80),
              }));
              console.log("Marker Inspector dismissal focus", {
                folded,
                active,
              });
              await expect(opener).toBeFocused();
            }

            await inspectSelection(page);
            await expect(title).toHaveValue("Opening");
            await title.press("Escape");
            await expect(dialog).toHaveCount(0);
            expect(count("UpdateChapter")).toBe(1);
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
            const end = dialog.getByRole("spinbutton", { name: "End" });
            if (shell === "phone") {
              for (const field of [start, end]) {
                await expect(field).toBeVisible();
                expect(
                  (await field.boundingBox())?.height,
                ).toBeGreaterThanOrEqual(44);
              }
            }
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
            await undo(page);
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
            await undo(page);
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
