import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { seeEveryHint, withSharedProject } from "./guestLink";
import { afterFrames } from "./guestLoadingProbes";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";

/**
 * The three link roles on real links, at a desktop and a phone window: the
 * palette lists only what the role can run, `q` lands in the comment field,
 * the Editor is told once that an edit is everyone's, the toast answers Esc
 * and Tab, and the page keeps its landmarks.
 */

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
};
const PROOF_DIR = process.env.UI_PROOF_DIR;

const STAKES =
  "You changed the host's episode, and everyone sees it. Undo takes back only your own step.";
const FIRST_VISIT = {
  viewer: "You can listen along. The host decides.",
  commenter: "You can comment and suggest cuts. The host decides.",
  editor: "You can edit and comment. The host decides what ships.",
} as const;
const ROLE_LABEL = {
  viewer: "Viewer",
  commenter: "Commenter",
  editor: "Editor",
} as const;

const VIEWER_ROWS = [
  "Play / pause",
  "Pause and return",
  "Jump back",
  "Speed up (1×/2×/4×)",
  "Nudge playhead back",
  "Nudge playhead forward",
  "Go to start",
  "Go to end",
  "Clear selection",
  "Next occurrence",
  "Play range",
  "Select a range",
  "Stop following",
  "Go to Review",
  "Take the hand-off",
  "Guides",
];
const COMMENTER_ROWS = [
  "Play / pause",
  "Pause and return",
  "Jump back",
  "Speed up (1×/2×/4×)",
  "Nudge playhead back",
  "Nudge playhead forward",
  "Go to start",
  "Go to end",
  "Clear selection",
  "Next occurrence",
  "Play range",
  "Cut selected range",
  "Mute selected range",
  "Comment on range",
  "Select a range",
  "Add comment",
  "Stop following",
  "Go to Review",
  "Take the hand-off",
  "Guides",
];
const GUEST_NEVER = [
  "Go to Record",
  "Go to Prepare",
  "Export selected range",
  "Split speakers…",
  "Report a problem",
];
const VIEWER_NEVER = [
  ...GUEST_NEVER,
  "Go to Edit",
  "Go to Deliver",
  "Open history",
  "Undo",
  "Redo",
  "Add comment",
  "Comment on range",
  "Cut selected range",
  "Mute selected range",
  "Zoom in",
  "Mute",
  "Select all tracks",
  "Import audio…",
  "Refresh mix",
];

type PaletteRow = { label: string; disabled: boolean; note: string | null };

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 600;

async function press(page: Page, name: string | RegExp): Promise<void> {
  const button = page.getByRole("button", { name });
  if (isPhone(page)) await button.tap();
  else await button.click();
}

async function dismissHint(page: Page): Promise<void> {
  await press(page, "Dismiss hint");
  await expect(page.locator(".sys-role-hint [role=note]")).toHaveCount(0);
}

async function openPalette(page: Page): Promise<PaletteRow[]> {
  await press(page, "Palette");
  await expect(
    page.getByRole("combobox", { name: "Search commands" }),
  ).toBeVisible();
  return page.locator(".command-palette-option").evaluateAll((els) =>
    els.map((el) => ({
      label: el.querySelector(".command-palette-label")?.textContent ?? "",
      disabled: el.getAttribute("aria-disabled") === "true",
      note: el.querySelector(".command-palette-note")?.textContent ?? null,
    })),
  );
}

async function closePalette(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("combobox", { name: "Search commands" }),
  ).toHaveCount(0);
}

/** The people the palette lists beside the commands depend on who has the page open. */
const PEOPLE_ROWS = ["Host", "Guest"];
const labels = (rows: PaletteRow[]) =>
  rows.map((row) => row.label).filter((label) => !PEOPLE_ROWS.includes(label));
const row = (rows: PaletteRow[], label: string) =>
  rows.find((entry) => entry.label === label);

/** Every sentence a polite status region comes to hold, in the order it held them. */
async function recordSpoken(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spoken: string[] = [];
    const last = new WeakMap<Element, string>();
    (window as unknown as { __spoken: string[] }).__spoken = spoken;
    new MutationObserver(() => {
      for (const region of document.querySelectorAll("[role=status]")) {
        const text = region.textContent?.trim() ?? "";
        if (text !== "" && last.get(region) !== text) spoken.push(text);
        last.set(region, text);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

const spokenSoFar = (page: Page) =>
  page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);

async function proof(page: Page, name: string): Promise<void> {
  if (PROOF_DIR === undefined || PROOF_DIR === "") return;
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: path.join(PROOF_DIR, `${name}.png`) });
}

const script = (page: Page) => page.getByRole("region", { name: "Script" });
const word = (page: Page, text: string) =>
  script(page).getByRole("button", { name: text, exact: true }).first();
const bar = (page: Page) =>
  page.getByRole("group", { name: /^(Selection|Edit) actions$/ });
const toast = (page: Page) => page.locator(".ui-toast-region--app");
const PEOPLE = (page: Page) =>
  page.getByRole("group", { name: "People here" }).getByRole("button");
const bubble = (page: Page) => page.locator(".sys-role-hint [role=note]");
const commentField = (page: Page) =>
  page.getByRole("textbox", { name: "Comment", exact: true });

async function cutWord(page: Page, text: string): Promise<void> {
  await word(page, text).click();
  await bar(page).getByRole("button", { name: "Cut", exact: true }).click();
  await expect(toast(page).locator(".ui-toast-message")).toContainText(
    `Cut "${text}"`,
  );
}

const anyWord = (page: Page, index: number) =>
  script(page).locator(".sys-script-word").nth(index);

async function cutWordAt(page: Page, index: number): Promise<void> {
  await anyWord(page, index).click();
  await bar(page).getByRole("button", { name: "Cut", exact: true }).click();
  await expect(toast(page).locator(".ui-toast-message")).toContainText(/^Cut /);
}

async function checkRole(
  page: Page,
  role: keyof typeof ROLE_LABEL,
): Promise<void> {
  await press(page, `Explain ${ROLE_LABEL[role]} role`);
  const dialog = page.getByRole("dialog", { name: `${ROLE_LABEL[role]} role` });
  await expect(dialog).toBeVisible();
  await dialog.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  await expectReadingSurfaceAxeClean(page);
}

for (const [sizeName, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`${sizeName}: the palette lists only what each role can run`, async ({
    browser,
  }) => {
    await withSharedProject(
      browser,
      [size, size, size],
      ["viewer", "commenter", "editor"],
      async ([host, viewer, commenter, editor], links) => {
        for (const guest of [viewer!, commenter!, editor!])
          await seeEveryHint(guest);

        await openGuestShare(viewer!, links.viewer);
        await expectReadingSurfaceAxeClean(viewer!);
        const viewerRows = await openPalette(viewer!);
        expect(labels(viewerRows)).toEqual(VIEWER_ROWS);
        expect(row(viewerRows, "Play range")).toMatchObject({
          disabled: true,
          note: "Choose a range",
        });
        expect(row(viewerRows, "Select a range")).toMatchObject({
          disabled: false,
        });
        for (const never of VIEWER_NEVER)
          expect(labels(viewerRows)).not.toContain(never);
        if (sizeName === "desktop") await proof(viewer!, "palette-viewer");
        if (sizeName === "desktop") {
          await expect(
            viewer!.getByText("00:00.000", { exact: true }),
          ).toHaveCount(1);
          await viewer!
            .locator(".command-palette-option")
            .filter({ hasText: /^Nudge playhead forward/ })
            .click();
          await expect(
            viewer!.getByText("00:00.000", { exact: true }),
          ).toHaveCount(0);
        } else await closePalette(viewer!);
        await expectReadingSurfaceAxeClean(viewer!);

        await openGuestShare(commenter!, links.commenter);
        await expectReadingSurfaceAxeClean(commenter!);
        const commenterRows = await openPalette(commenter!);
        expect(labels(commenterRows)).toEqual(COMMENTER_ROWS);
        for (const greyed of [
          "Cut selected range",
          "Mute selected range",
          "Comment on range",
        ])
          expect(row(commenterRows, greyed)).toMatchObject({
            disabled: true,
            note: "Choose a range",
          });
        expect(row(commenterRows, "Add comment")).toMatchObject({
          disabled: false,
        });
        for (const never of [...GUEST_NEVER, "Go to Edit", "Open history"])
          expect(labels(commenterRows)).not.toContain(never);
        await closePalette(commenter!);

        if (sizeName === "desktop") {
          await word(commenter!, "uncle").click();
          const chosen = await openPalette(commenter!);
          for (const runs of [
            "Cut selected range",
            "Mute selected range",
            "Comment on range",
          ])
            expect(row(chosen, runs)).toMatchObject({
              disabled: false,
              note: null,
            });
          await closePalette(commenter!);
        }
        await openPalette(commenter!);
        await commenter!
          .locator(".command-palette-option")
          .filter({ hasText: /^Add comment/ })
          .click();
        await expect(commentField(commenter!)).toBeFocused();

        await openGuestShare(editor!, links.editor);
        await expectReadingSurfaceAxeClean(editor!);
        const editorRows = await openPalette(editor!);
        for (const never of GUEST_NEVER)
          expect(labels(editorRows)).not.toContain(never);
        for (const present of [
          "Go to Edit",
          "Go to Review",
          "Go to Deliver",
          "Open history",
          "Split at playhead",
          "Import audio…",
        ])
          expect(labels(editorRows)).toContain(present);
        expect(row(editorRows, "Cut selected range")).toMatchObject({
          disabled: true,
          note: "Choose a range",
        });
        if (sizeName === "desktop") await proof(editor!, "palette-editor-edit");
        await closePalette(editor!);

        await editor!.getByRole("tab", { name: /^Review/ }).click();
        const onReview = await openPalette(editor!);
        expect(row(onReview, "Split at playhead")).toMatchObject({
          disabled: true,
          note: "Open Edit to change the timeline",
        });
        expect(labels(onReview)).not.toContain("Export selected range");
        expect(row(onReview, "Go to Edit")).toMatchObject({ disabled: false });
        await editor!
          .locator(".command-palette-option")
          .filter({ hasText: /^Go to Edit/ })
          .click();
        await expect(
          editor!.getByRole("tab", { name: /^Edit/ }),
        ).toHaveAttribute("aria-selected", "true");

        if (sizeName === "desktop") {
          const hostRows = await openPalette(host!);
          for (const present of [
            "Go to Prepare",
            "Go to Record",
            "Export selected range",
            "Split speakers…",
          ])
            expect(labels(hostRows)).toContain(present);
        }
      },
    );
  });

  test(`${sizeName}: each role's name opens a dialog by that name and the page keeps its landmarks`, async ({
    browser,
  }) => {
    await withSharedProject(
      browser,
      [size, size, size],
      ["viewer", "commenter", "editor"],
      async ([, viewer, commenter, editor], links) => {
        for (const [guest, role] of [
          [viewer!, "viewer"],
          [commenter!, "commenter"],
          [editor!, "editor"],
        ] as const) {
          await seeEveryHint(guest);
          await openGuestShare(guest, links[role]);
          await expect(guest.getByRole("banner")).toBeVisible();
          await expect(guest.getByRole("main")).toBeVisible();
          if (role === "editor") {
            await expect(
              guest.getByRole("region", { name: "Playback controls" }),
            ).toBeAttached();
            if (sizeName === "phone")
              await expect(
                guest.getByRole("navigation", { name: "Stages" }),
              ).toBeAttached();
          }
          await expectReadingSurfaceAxeClean(guest);
          await checkRole(guest, role);
          await guest.keyboard.press("Escape");
          await expect(guest.getByRole("dialog")).toHaveCount(0);
        }
      },
    );
  });

  test(`${sizeName}: the first-visit sentence is the only thing spoken while it is up, and a leave waits for it`, async ({
    browser,
  }) => {
    await withSharedProject(
      browser,
      [size],
      ["editor"],
      async ([host, guest], links, projectPath) => {
        await recordSpoken(guest!);
        await openGuestShare(guest!, links.editor);
        await expect(bubble(guest!)).toContainText(FIRST_VISIT.editor);
        await expect(PEOPLE(guest!)).not.toHaveCount(0);
        await afterFrames(guest!);
        const spoken = await spokenSoFar(guest!);
        expect(
          spoken.filter((text) => text.includes(FIRST_VISIT.editor)),
        ).toHaveLength(1);
        expect(spoken.filter((text) => /joined/i.test(text))).toEqual([]);
        await expectReadingSurfaceAxeClean(guest!);

        if (sizeName === "desktop") {
          await host!.goto("about:blank");
          await expect(PEOPLE(guest!)).toHaveCount(0);
          await afterFrames(guest!);
          expect(await spokenSoFar(guest!)).not.toContain("Someone left");
          await dismissHint(guest!);

          await openHostShare(host!, projectPath);
          await expect(PEOPLE(guest!)).not.toHaveCount(0);
          await host!.goto("about:blank");
          await expect
            .poll(() => spokenSoFar(guest!))
            .toContain("Someone left");
        }
      },
    );
  });
}

test("the first-visit bubble ignores a wheel and keys aside from its own controls, and closes on a bare click event", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["viewer"],
    async ([, guest], links) => {
      await openGuestShare(guest!, links.viewer);
      await expect(bubble(guest!)).toContainText(FIRST_VISIT.viewer);
      await guest!.mouse.move(600, 400);
      await guest!.mouse.wheel(0, 300);
      await afterFrames(guest!);
      await expect(bubble(guest!)).toBeVisible();

      await guest!.getByRole("button", { name: "Explain Viewer role" }).focus();
      await guest!.keyboard.press("a");
      await guest!.keyboard.press("ArrowRight");
      await afterFrames(guest!);
      await expect(bubble(guest!)).toBeVisible();
      await guest!.keyboard.press("Enter");
      await expect(bubble(guest!)).toHaveCount(0);

      await guest!.evaluate(() => localStorage.clear());
      await guest!.reload();
      await expect(bubble(guest!)).toBeVisible();
      await guest!
        .getByRole("main")
        .evaluate((el) => (el as HTMLElement).click());
      await expect(bubble(guest!)).toHaveCount(0);
      await guest!.reload();
      await expect(guest!.locator(".stage-frame--guest")).toBeVisible();
      await expect(bubble(guest!)).toHaveCount(0);
    },
  );
});

test("m on a Viewer or Commenter link says nothing and shows no toast", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP, DESKTOP],
    ["viewer", "commenter"],
    async ([, viewer, commenter], links) => {
      for (const [guest, token] of [
        [viewer!, links.viewer],
        [commenter!, links.commenter],
      ] as const) {
        await seeEveryHint(guest);
        await recordSpoken(guest);
        await openGuestShare(guest, token);
        await guest.keyboard.press("m");
        await afterFrames(guest);
        expect(await spokenSoFar(guest)).not.toContain("No track selected");
        await expect(guest.locator(".ui-toast")).toHaveCount(0);
      }
    },
  );
});

test("q puts a Commenter or Editor in the comment field with the q typed, and does nothing for a Viewer, on a phone, or over a dialog", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP, DESKTOP, DESKTOP, PHONE],
    ["viewer", "commenter", "editor"],
    async ([, viewer, commenter, editor, phone], links) => {
      for (const guest of [viewer!, commenter!, editor!, phone!])
        await seeEveryHint(guest);

      await openGuestShare(commenter!, links.commenter);
      await commenter!.keyboard.press("q");
      await expect(commentField(commenter!)).toBeFocused();
      await expect(commentField(commenter!)).toHaveValue("q");
      await commenter!.keyboard.press("q");
      await expect(commentField(commenter!)).toHaveValue("qq");
      await expectReadingSurfaceAxeClean(commenter!);

      await openGuestShare(editor!, links.editor);
      await editor!.getByRole("tab", { name: /^Review/ }).click();
      await editor!.keyboard.press("q");
      await expect(commentField(editor!)).toBeFocused();
      await expect(commentField(editor!)).toHaveValue("q");

      await openGuestShare(viewer!, links.viewer);
      await viewer!.keyboard.press("q");
      await afterFrames(viewer!);
      await expect(commentField(viewer!)).toHaveCount(0);
      await expect(viewer!.locator("textarea:focus, input:focus")).toHaveCount(
        0,
      );

      await openGuestShare(phone!, links.commenter);
      await phone!.keyboard.press("q");
      await afterFrames(phone!);
      await expect(phone!.locator("textarea:focus, input:focus")).toHaveCount(
        0,
      );

      await openGuestShare(commenter!, links.commenter);
      await press(commenter!, "Explain Commenter role");
      await expect(
        commenter!.getByRole("dialog", { name: "Commenter role" }),
      ).toBeVisible();
      await commenter!.keyboard.press("q");
      await afterFrames(commenter!);
      await expect(
        commenter!.locator("textarea:focus, input:focus"),
      ).toHaveCount(0);
    },
  );
});

test("the Editor's first applied edit raises the stakes sentence once per link, after the edit's own status", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([host, guest], links, projectPath) => {
      await recordSpoken(guest!);
      await openGuestShare(guest!, links.editor);
      await dismissHint(guest!);

      await cutWord(guest!, "uncle");
      await expect(bubble(guest!)).toContainText(STAKES);
      const spoken = await spokenSoFar(guest!);
      const edit = spoken.findIndex((text) => text.startsWith('Cut "uncle"'));
      expect(edit).toBeGreaterThanOrEqual(0);
      expect(spoken.indexOf(STAKES)).toBeGreaterThan(edit);
      await expect(
        guest!.locator("[role=status]").filter({ hasText: STAKES }),
      ).toHaveCount(1);
      await expectReadingSurfaceAxeClean(guest!);
      await proof(guest!, "stakes-bubble");

      await word(guest!, "moody").click();
      await expect(bubble(guest!)).toHaveCount(0);

      await guest!.reload();
      await expect(guest!.locator(".stage-frame--guest")).toBeVisible();
      await cutWordAt(guest!, 0);
      await expect(bubble(guest!)).toHaveCount(0);

      const second = await createReviewShare(host!, projectPath, "editor");
      await openGuestShare(guest!, second);
      await expect(bubble(guest!)).toHaveCount(0);
      await cutWordAt(guest!, 5);
      await expect(bubble(guest!)).toContainText(STAKES);
    },
  );
});

test("with storage blocked the stakes sentence shows once in the session and nothing errors", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([, guest], links) => {
      const errors: string[] = [];
      guest!.on("pageerror", (error) => errors.push(error.message));
      guest!.on("console", (message) => {
        if (
          message.type() === "error" &&
          !message.location().url.endsWith("/daw/proxy/manifest")
        )
          errors.push(message.text());
      });
      await guest!.addInitScript(() => {
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException("blocked", "SecurityError");
          },
        });
      });
      await openGuestShare(guest!, links.editor);
      await dismissHint(guest!);
      await cutWord(guest!, "uncle");
      await expect(bubble(guest!)).toContainText(STAKES);
      await dismissHint(guest!);
      await cutWord(guest!, "moody");
      await afterFrames(guest!);
      await expect(bubble(guest!)).toHaveCount(0);
      expect(errors).toEqual([]);
    },
  );
});

test("the toast answers Esc, is early in the Tab order, and clears itself", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([, guest], links) => {
      await seeEveryHint(guest!);
      await openGuestShare(guest!, links.editor);

      await cutWord(guest!, "uncle");
      await expectReadingSurfaceAxeClean(guest!);
      await proof(guest!, "toast-editor");
      await guest!.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );
      await guest!.keyboard.press("Escape");
      await expect(guest!.locator(".ui-toast")).toHaveCount(0);

      await cutWord(guest!, "moody");
      await guest!.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );
      const stops: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        await guest!.keyboard.press("Tab");
        const here = await guest!.evaluate(() => {
          const el = document.activeElement;
          return {
            inMain: el?.closest("main") != null,
            dismiss:
              el?.closest(".ui-toast-region--app") != null &&
              el?.textContent === "Dismiss",
          };
        });
        stops.push(JSON.stringify(here));
        if (here.dismiss) break;
        expect(
          here.inMain,
          `Tab reached the page body first: ${stops.join(" ")}`,
        ).toBe(false);
      }
      expect(stops.at(-1)).toContain('"dismiss":true');
      await guest!.keyboard.press("Escape");
      await expect(guest!.locator(".ui-toast")).toHaveCount(0);
      await guest!.keyboard.press("Tab");
      const reached = await guest!.evaluate(
        () => document.activeElement !== document.body,
      );
      expect(reached).toBe(true);

      await cutWordAt(guest!, 40);
      await expect(guest!.locator(".ui-toast")).toHaveCount(0, {
        timeout: 12_000,
      });
    },
  );
});

async function stageHeldCut(host: Page, projectPath: string): Promise<void> {
  const waived = await host.request.post("/api/transcript/refine/waive", {
    data: { path: projectPath, reason: "e2e roles polish" },
  });
  expect(waived.ok(), await waived.text()).toBe(true);
  const command = (type: string, payload: Record<string, unknown>) =>
    postDocumentCommand(host, "e2e-roles-polish", type, payload, projectPath);
  await command("StageWordsCut", {
    track_id: "reference",
    start_word_index: 1,
    end_word_index: 1,
  });
  await command("SplitAtTime", { at_time: 2.65, track_ids: ["reference"] });
  const project = await host.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const right = (
    (await project.json()) as {
      clips: { tracks: Record<string, { id: string; source_start: number }[]> };
    }
  ).clips.tracks["reference"]!.find((clip) => clip.source_start > 2)!;
  await command("MoveClips", {
    clips: [
      {
        clip_id: right.id,
        timeline_start: right.source_start + 1,
        track_id: "reference",
      },
    ],
  });
}

async function openReviewCard(guest: Page, token: string, stages: boolean) {
  await seeEveryHint(guest);
  await openGuestShare(guest, token);
  if (stages) await guest.getByRole("tab", { name: /^Review/ }).click();
  const card = guest.getByRole("article");
  await expect(card).toBeVisible();
  return card;
}

test("a held cut on Review tells an Editor to keep it or cut less", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([host, guest], links, projectPath) => {
      await stageHeldCut(host!, projectPath);
      const card = await openReviewCard(guest!, links.editor, true);
      await card.getByRole("button", { name: "Cut", exact: true }).click();
      await expect(card).toContainText(
        "Keep it, or cut a smaller part in Edit.",
      );
      await expectReadingSurfaceAxeClean(guest!);
    },
  );
});

test("a held cut is not offered to a Commenter or a Viewer, so neither is told to keep it or cut less", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP, DESKTOP],
    ["commenter", "viewer"],
    async ([host, commenter, viewer], links, projectPath) => {
      await stageHeldCut(host!, projectPath);
      for (const [guest, token] of [
        [commenter!, links.commenter],
        [viewer!, links.viewer],
      ] as const) {
        await seeEveryHint(guest);
        await openGuestShare(guest, token);
        await expect(guest.getByRole("main", { name: "Review" })).toBeVisible();
        await expect(guest.getByText("No comments yet")).toBeVisible();
        await expect(guest.getByRole("article")).toHaveCount(0);
        await expect(
          guest.getByText("Keep it, or cut a smaller part"),
        ).toHaveCount(0);
        await expectReadingSurfaceAxeClean(guest);
      }
    },
  );
});
