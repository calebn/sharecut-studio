import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Stage-level navigation for specs. Every helper here says what the spec wants
 * (open the Comments panel, open the Share dialog) and none of them names the
 * chrome that gets there, so the stage shell can replace the dock tabs, the
 * phone More hub and the transport Menu by changing only this file (#2292).
 * Today's implementation drives the dock tabs, the phone nav and the transport
 * Menu.
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

const PANEL_NAME: Record<Panel, string | RegExp> = {
  transcript: "Transcript",
  history: "History",
  impact: "Impact",
  tighten: "Tighten",
  // The dock tab and the More row carry a live-job dot while the pipeline runs.
  pipeline: /^Pipeline(?: ●)?$/,
  comments: "Comments",
};

const DIALOG_ITEM: Record<ProjectDialog, string> = {
  share: "Share…",
  export: "Export deliverables…",
  bounce: "Bounce…",
  record: "Record room…",
  palette: "Commands and shortcuts",
};

/** The panel each stage opens to; Record and Deliver have none in the dock shell. */
const STAGE_PANEL: Record<Stage, Panel | null> = {
  record: null,
  prepare: "pipeline",
  edit: "transcript",
  review: "comments",
  deliver: null,
};

export async function isPhoneShell(page: Page): Promise<boolean> {
  return (
    (await page.locator(".daw-shell").getAttribute("data-shell")) === "phone"
  );
}

export const phone = {
  async show(page: Page, mode: "listen" | "timeline" | "text"): Promise<void> {
    const name = { listen: "Listen", timeline: "Timeline", text: "Text" }[mode];
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name, exact: true })
      .click();
  },
  showTimeline: (page: Page) => phone.show(page, "timeline"),
  showText: (page: Page) => phone.show(page, "text"),
  showListen: (page: Page) => phone.show(page, "listen"),
  async openMore(page: Page): Promise<void> {
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "More", exact: true })
      .click();
  },
};

/** Open `panel` in the dock (desktop) or through the phone Text mode and More hub. */
export async function openPanel(page: Page, panel: Panel): Promise<void> {
  const name = PANEL_NAME[panel];
  if (await isPhoneShell(page)) {
    if (panel === "transcript") {
      await phone.showText(page);
      return;
    }
    await phone.openMore(page);
    await page
      .locator(".mobile-more-list")
      .getByRole("button", { name, exact: typeof name === "string" })
      .click();
    return;
  }
  await page
    .getByLabel("Editor panels")
    .getByRole("tab", { name, exact: typeof name === "string" })
    .click();
}

/**
 * Go to `stage`. The dock shell has no Record or Deliver surface, so those two
 * leave the screen as it is; they open their dialogs through `openProjectDialog`.
 */
export async function goToStage(page: Page, stage: Stage): Promise<void> {
  const panel = STAGE_PANEL[stage];
  if (panel) await openPanel(page, panel);
}

/** Open the project menu (the transport Menu) and return it. */
export async function openProjectMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", { name: "Transport menu" });
  if (await menu.isVisible()) {
    return menu;
  }
  const menuButton = page.getByRole("button", { name: "Menu", exact: true });
  if ((await menuButton.count()) === 0) {
    // The phone Listen mode intentionally hides transport chrome. Enter More,
    // where the compact transport and its project menu are available.
    await phone.openMore(page);
  }
  await menuButton.click();
  return menu;
}

/** Open the project menu and choose the entry that opens `dialog`. */
export async function openProjectDialog(
  page: Page,
  dialog: ProjectDialog,
): Promise<void> {
  await openProjectMenuItem(page, DIALOG_ITEM[dialog]);
}

/** Open the project menu and choose `item` by its visible name. */
export async function openProjectMenuItem(
  page: Page,
  item: string,
): Promise<void> {
  await openProjectMenu(page);
  await page.getByRole("menuitem", { name: item }).click();
}

/** Open the host Record room dialog and wait for it. */
export async function openRecordRoom(page: Page): Promise<Locator> {
  await openProjectDialog(page, "record");
  const roomDialog = page.getByRole("dialog", { name: "Record room" });
  await expect(roomDialog).toBeVisible();
  return roomDialog;
}
