import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Stage-level navigation for specs. Every helper here says what the spec wants
 * (open the Comments panel, open the Share dialog) and none of them names the
 * chrome that gets there. It drives the stage frame (#2292): the Stage bar in
 * the App header (the tab bar on a phone), the Project menu, the Edit stage's
 * eye sheet and tool strip, and the Player's hear menu.
 *
 * Browsers keep Mod+1 to Mod+9 for their own tabs, so stages are switched by
 * clicking the Stage bar, never by key.
 */

export type Stage = "record" | "prepare" | "edit" | "review" | "deliver";

export type Panel =
  | "transcript"
  | "history"
  | "impact"
  | "tighten"
  | "pipeline"
  | "comments";

export type ProjectDialog =
  | "share"
  | "export"
  | "bounce"
  | "record"
  | "palette";

export type Audition = "mix" | "fx" | "raw";

const STAGE_LABEL: Record<Stage, string> = {
  record: "Record",
  prepare: "Prepare",
  edit: "Edit",
  review: "Review",
  deliver: "Deliver",
};

/** Where each panel lives: its stage and, for Review, the section tab. */
const PANEL_HOME: Record<
  Panel,
  { stage: Stage; section?: string; sheet?: "history" }
> = {
  transcript: { stage: "edit" },
  history: { stage: "edit", sheet: "history" },
  impact: { stage: "review", section: "Impact" },
  tighten: { stage: "review", section: "Tighten" },
  pipeline: { stage: "prepare" },
  comments: { stage: "review", section: "Comments" },
};

const AUDITION_LABEL: Record<Audition, string> = {
  mix: "Full mix",
  fx: "Without mix processing",
  raw: "Original",
};

export async function isPhoneShell(page: Page): Promise<boolean> {
  return (
    (await page
      .locator("html")
      .getAttribute("data-shell")
      .catch(() => null)) === "phone"
  );
}

/** The Stage bar tab for `stage`: in the header, or the tab bar on a phone. */
function stageTab(page: Page, stage: Stage): Locator {
  return page
    .getByRole("tablist", { name: "Stages" })
    .getByRole("tab", { name: new RegExp(`^${STAGE_LABEL[stage]}\\b`) });
}

/** Wait for the frame to be up and the first stage to be showing. */
export async function waitForFrame(page: Page): Promise<void> {
  await expect(page.locator(".stage-frame")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
}

/** Go to `stage` by its Stage bar tab and wait for it to be the open one. */
export async function goToStage(page: Page, stage: Stage): Promise<void> {
  const tab = stageTab(page, stage);
  if ((await tab.getAttribute("aria-selected")) !== "true") {
    await tab.click();
  }
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("main", { name: STAGE_LABEL[stage] }),
  ).toBeVisible();
}

export const phone = {
  /**
   * The phone shows one Edit surface at a time. `listen` has no surface of its
   * own now: it is the Review stage, where the Player and the comments are.
   */
  async show(page: Page, mode: "listen" | "timeline" | "text"): Promise<void> {
    if (mode === "listen") {
      await goToStage(page, "review");
      return;
    }
    await goToStage(page, "edit");
    const name = mode === "text" ? "Script" : "Timeline";
    const toggle = page
      .getByRole("group", { name: "Edit surface" })
      .getByRole("button", { name, exact: true });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  },
  showTimeline: (page: Page) => phone.show(page, "timeline"),
  showText: (page: Page) => phone.show(page, "text"),
  showListen: (page: Page) => phone.show(page, "listen"),
  /** The More hub is gone; the project menu is the nearest thing to it. */
  async openMore(page: Page): Promise<void> {
    await openProjectMenu(page);
  },
};

/** Open `panel`: its stage, then its section tab or sheet. */
export async function openPanel(page: Page, panel: Panel): Promise<void> {
  const home = PANEL_HOME[panel];
  if (panel === "transcript" && (await isPhoneShell(page))) {
    await phone.showText(page);
    return;
  }
  await goToStage(page, home.stage);
  if (home.section) {
    const tab = page
      .getByRole("tablist", { name: "Review sections" })
      .getByRole("tab", { name: new RegExp(`^${home.section}\\b`) });
    if ((await tab.getAttribute("aria-selected")) !== "true") {
      await tab.click();
    }
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  if (home.sheet === "history") {
    await openHistorySheet(page);
  }
}

/** Open the History sheet from the header's Undo (a right-click does it). */
export async function openHistorySheet(page: Page): Promise<Locator> {
  const sheet = page.getByRole("dialog", { name: "History" });
  if (await sheet.isVisible()) return sheet;
  await page
    .locator(".sys-header-history")
    .getByRole("button", { name: /^Undo/ })
    .click({ button: "right" });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The Project menu button in the App header. */
export function projectMenuButton(page: Page): Locator {
  return page.locator(".sys-header-project");
}

/** Open the Project menu (the header's title button) and return it. */
export async function openProjectMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", { name: "Project menu" });
  if (await menu.isVisible()) {
    return menu;
  }
  await projectMenuButton(page).click();
  await expect(menu).toBeVisible();
  return menu;
}

/** The old transport Menu's dialog rows, and where each lives now. */
const MOVED_MENU_ITEMS: Record<string, ProjectDialog> = {
  "Share…": "share",
  "Export deliverables…": "export",
  "Bounce…": "bounce",
  "Record room…": "record",
  "Commands and shortcuts": "palette",
};

/**
 * Open the Project menu and choose the entry named `item`. A name the old
 * transport Menu carried (Share…, Export deliverables…) goes to where it
 * lives now, so the specs that still say it keep working until they are
 * rewritten.
 */
export async function openProjectMenuItem(
  page: Page,
  item: string,
): Promise<void> {
  const moved = MOVED_MENU_ITEMS[item];
  if (moved) {
    await openProjectDialog(page, moved);
    return;
  }
  const menu = await openProjectMenu(page);
  await menu.getByRole("menuitem", { name: item }).click();
}

/**
 * Open the dialog `dialog` from where it lives now: Share, Export and Bounce on
 * Deliver, the Record room on Record, the palette on the header's search.
 */
export async function openProjectDialog(
  page: Page,
  dialog: ProjectDialog,
): Promise<void> {
  switch (dialog) {
    case "share":
      await goToStage(page, "deliver");
      await page.getByRole("button", { name: "Share a listen link" }).click();
      return;
    case "export":
      await goToStage(page, "deliver");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      return;
    case "bounce":
      await goToStage(page, "deliver");
      await page.getByRole("button", { name: "Bounce…", exact: true }).click();
      return;
    case "record":
      await goToStage(page, "record");
      await page
        .getByRole("button", { name: /^(Open|Back to) the room$/ })
        .click();
      return;
    case "palette":
      await page.getByRole("button", { name: /^Palette\b/ }).click();
      return;
  }
}

/** Open the host Record room dialog and wait for it. */
export async function openRecordRoom(page: Page): Promise<Locator> {
  await openProjectDialog(page, "record");
  const roomDialog = page.getByRole("dialog", { name: "Record room" });
  await expect(roomDialog).toBeVisible();
  return roomDialog;
}

/** Open the Edit stage's eye sheet (view options) and return it. */
export async function openViewSheet(page: Page): Promise<Locator> {
  await goToStage(page, "edit");
  const sheet = page.getByRole("dialog", { name: "View" });
  if (await sheet.isVisible()) return sheet;
  await page.getByRole("button", { name: "View options" }).click();
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The Edit tool strip's Select and Blade toggle. */
export async function selectTool(
  page: Page,
  tool: "select" | "blade",
): Promise<void> {
  await goToStage(page, "edit");
  const strip = page.getByRole("group", { name: "Editing tools" });
  const button = strip.getByRole("button", {
    name: tool === "select" ? "Select tool" : "Blade tool",
    exact: true,
  });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/** Pick how the Player plays: the hear menu next to A/B. It closes on a pick. */
export async function setAudition(page: Page, mode: Audition): Promise<void> {
  const menuButton = page.getByRole("button", { name: "Hear options" });
  const row = page.getByRole("menuitemradio", { name: AUDITION_LABEL[mode] });
  await menuButton.click();
  await row.click();
  await expect(row).toBeHidden();
  await menuButton.click();
  await expect(row).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(row).toBeHidden();
}
