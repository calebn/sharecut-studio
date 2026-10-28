import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Stage-level navigation for specs. Every helper here says what the spec wants
 * (open the Comments panel, open the Share dialog) and none of them names the
 * chrome that gets there. It drives the stage frame: the Stage bar in
 * the App header (the tab bar on a phone), the Project menu, the Edit stage's
 * eye sheet, and the Player's hear menu.
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
  | "palette"
  | "gestures";

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
export function stageTab(page: Page, stage: Stage): Locator {
  return page
    .getByRole("tablist", { name: "Stages" })
    .getByRole("tab", { name: new RegExp(`^${STAGE_LABEL[stage]}\\b`) })
    .first();
}

/** Wait for the frame to be up and the first stage to be showing. */
export async function waitForFrame(page: Page): Promise<void> {
  await expect(page.locator(".stage-frame")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
}

/** Go to `stage` by its Stage bar tab and wait for it to be the open one. */
export async function goToStage(page: Page, stage: Stage): Promise<void> {
  // A window too short or too narrow for the tab bar folds it into the
  // header's Stage menu, and the fold is decided by measuring the frame, so it
  // can flip while the page settles. Retry the whole step against whichever
  // control the frame shows now.
  await expect(async () => {
    const menu = page.getByRole("button", { name: /^Stage menu, / });
    const tab = stageTab(page, stage);
    await expect(menu.or(tab)).toBeVisible({ timeout: 2000 });
    if (await menu.isVisible()) {
      if (
        !(await menu.getAttribute("aria-label"))?.endsWith(STAGE_LABEL[stage])
      ) {
        await menu.click({ timeout: 2000 });
        await page
          .getByRole("menuitem", {
            name: new RegExp(`^${STAGE_LABEL[stage]}\\b`),
          })
          .click({ timeout: 2000 });
      }
      await expect(menu).toHaveAttribute(
        "aria-label",
        `Stage menu, ${STAGE_LABEL[stage]}`,
        { timeout: 2000 },
      );
    } else {
      if ((await tab.getAttribute("aria-selected")) !== "true") {
        await tab.click({ timeout: 2000 });
      }
      await expect(tab).toHaveAttribute("aria-selected", "true", {
        timeout: 2000,
      });
    }
    await expect(
      page.getByRole("main", { name: STAGE_LABEL[stage] }),
    ).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
}

/**
 * Open a project as its host and land on `stage` (Edit by default). A project
 * opens on the stage it needs next (Review while edits wait for a decision), so
 * a spec that drives the timeline says where it wants to be.
 */
export async function openProject(
  page: Page,
  projectPath: string,
  options: { stage?: Stage; query?: string } = {},
): Promise<void> {
  await page.goto(
    `/?project=${encodeURIComponent(projectPath)}${options.query ?? ""}`,
  );
  await waitForFrame(page);
  // The Save indicator shows once the project has loaded, which is also when
  // the landing stage is picked; a stage chosen before that gets overruled.
  await expect(saveStatus(page)).toBeVisible();
  await goToStage(page, options.stage ?? "edit");
}

/**
 * Reload the open project and wait until the frame is up and the landing stage
 * has been picked, so a stage the spec goes to next is not overruled by it.
 */
export async function reloadProject(page: Page): Promise<void> {
  await page.reload();
  await waitForLanding(page);
}

/** Wait for the frame to be up and the landing stage to have been picked. */
export async function waitForLanding(page: Page): Promise<void> {
  await waitForFrame(page);
  await expect(saveStatus(page)).toBeVisible();
}

/**
 * A window too short or too narrow for the Edit rows folds the surface switch
 * and the timeline corner behind the header's Tools button. Open its sheet when it
 * is there; the controls it holds are then visible. Returns whether it opened.
 */
export async function openToolsIfFolded(page: Page): Promise<boolean> {
  const button = page.getByRole("button", { name: "Tools", exact: true });
  if (!(await button.isVisible())) return false;
  const sheet = page.getByRole("dialog", { name: "Tools" });
  if (!(await sheet.isVisible())) {
    await button.click();
    await expect(sheet).toBeVisible();
  }
  return true;
}

/** Close the Tools sheet after a control inside it was used, if it is open. */
export async function closeTools(page: Page): Promise<void> {
  const sheet = page.getByRole("dialog", { name: "Tools" });
  if (await sheet.isVisible()) {
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
  }
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
    // Only the phone has one Edit surface at a time; wider shells show both.
    if (!(await isPhoneShell(page))) return;
    const folded = await openToolsIfFolded(page);
    const name = mode === "text" ? "Script" : "Timeline";
    const toggle = page
      .getByRole("group", { name: "Edit surface" })
      .getByRole("button", { name, exact: true });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    if (folded) await closeTools(page);
  },
  showTimeline: (page: Page) => phone.show(page, "timeline"),
  showText: (page: Page) => phone.show(page, "text"),
  showListen: (page: Page) => phone.show(page, "listen"),
  /** The phone's Mix button on the Edit stage; returns the Mix sheet. */
  async openMix(page: Page): Promise<Locator> {
    await goToStage(page, "edit");
    await page.getByRole("button", { name: "Mix", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Mix", exact: true });
    await expect(sheet).toBeVisible();
    return sheet;
  },
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

/** The Save indicator in the App header. */
export function saveStatus(page: Page): Locator {
  return page.locator(".sys-app-header-host .sys-save").first();
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

/** Dialog rows and the Project menu item that opens each. */
const MOVED_MENU_ITEMS: Record<string, ProjectDialog> = {
  "Share…": "share",
  "Export deliverables…": "export",
  "Bounce…": "bounce",
  "Record room…": "record",
  "Commands and shortcuts": "palette",
};

/** Rows with no menu item; the palette runs them. */
const PALETTE_ONLY_ITEMS = new Set(["Export diagnostics…"]);

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
  if (PALETTE_ONLY_ITEMS.has(item)) {
    await openProjectDialog(page, "palette");
    const search = page.getByRole("combobox", { name: "Search commands" });
    await search.fill(item);
    await search.press("Enter");
    return;
  }
  const menu = await openProjectMenu(page);
  // The Project menu names its rows without the trailing ellipsis.
  const name = item.replace(/…$/, "");
  await menu.getByRole("menuitem", { name, exact: true }).click();
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
    case "palette": {
      const search = page.getByRole("button", { name: /^Palette\b/ });
      if (await search.isVisible()) {
        await search.click();
        return;
      }
      // A folded or narrow header gives its right side to the Project menu.
      const menu = await openProjectMenu(page);
      await menu
        .getByRole("menuitem", { name: "Search commands and people" })
        .click();
      return;
    }
    case "gestures":
      await openProjectDialog(page, "palette");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Gestures", exact: true })
        .click();
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
  // The eye sits on the Timeline surface; the phone shows one surface at a time.
  await phone.showTimeline(page);
  const sheet = page.getByRole("dialog", { name: "View" });
  if (await sheet.isVisible()) return sheet;
  // A folded frame moves the corner (zoom, the eye) into the Tools sheet.
  await openToolsIfFolded(page);
  await page.getByRole("button", { name: "View options" }).click();
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Press the eye sheet's "Track height +" or "Track height −" once, then close it. */
export async function stepTrackHeight(
  page: Page,
  direction: "increase" | "decrease",
): Promise<void> {
  const sheet = await openViewSheet(page);
  await sheet
    .getByRole("button", {
      name: direction === "increase" ? "Track height +" : "Track height −",
    })
    .click();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
}

/** Show or hide a timeline layer ("Volume envelope", "Markers"…) in the eye sheet. */
export async function setLayer(
  page: Page,
  label: string,
  checked: boolean,
): Promise<void> {
  const sheet = await openViewSheet(page);
  const toggle = sheet.getByRole("checkbox", { name: label, exact: true });
  if (checked) await toggle.check();
  else await toggle.uncheck();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
}

/** Alt-click `target` (a lane, a clip) at `position` in its own box. */
export async function altClickSplit(
  page: Page,
  target: Locator,
  position?: { x: number; y: number },
): Promise<void> {
  await goToStage(page, "edit");
  await target.click({ modifiers: ["Alt"], position });
}

/** Add a track from the Edit stage's + menu. */
export async function addTrack(page: Page): Promise<void> {
  await goToStage(page, "edit");
  await page.getByRole("button", { name: "+", exact: true }).click();
  await page.getByRole("menuitem", { name: /^New track/ }).click();
}

export async function runPaletteCommand(
  page: Page,
  label: string,
): Promise<void> {
  await openProjectDialog(page, "palette");
  const search = page.getByRole("combobox", { name: "Search commands" });
  await search.fill(label);
  await search.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Commands and shortcuts" }),
  ).toBeHidden();
}

/**
 * Arm range selection; the Range actions form opens. A touch screen has the
 * bracket toggle in the timeline corner; a mouse drags a range directly, so
 * the same command `range.arm` runs from the palette there.
 */
export async function armRange(page: Page): Promise<void> {
  await goToStage(page, "edit");
  // Folded, the Range actions open over the Tools sheet and leave it be.
  const folded = await openToolsIfFolded(page);
  const toggle = page
    .getByRole("group", { name: "Timeline view" })
    .getByRole("button", { name: "Select range", exact: true });
  if (await toggle.isVisible()) {
    // A mouse move would flip the pointer to fine and unmount the touch toggle.
    await toggle.tap();
  } else {
    if (folded) await closeTools(page);
    await runPaletteCommand(page, "Select a range");
  }
  await expect(
    page.getByRole("region", { name: "Range actions" }),
  ).toBeVisible();
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

/**
 * On the phone the Player bar hides the skip buttons; the expanded form has
 * them. Open it (a no-op when it is open) and return it.
 */
export async function expandPlayer(page: Page): Promise<Locator> {
  const expanded = page.locator(".sys-player--expanded");
  if (!(await expanded.isVisible())) {
    await page.getByRole("button", { name: /Expand player/ }).click();
  }
  await expect(expanded).toBeVisible();
  return expanded;
}

/** Close the expanded Player back to its bar. */
export async function collapsePlayer(page: Page): Promise<void> {
  const expanded = page.locator(".sys-player--expanded");
  if (await expanded.isVisible()) {
    await expanded.getByRole("button", { name: "Collapse player" }).click();
  }
  await expect(expanded).toBeHidden();
}
