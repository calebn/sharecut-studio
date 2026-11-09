import fs from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { controlGeometry } from "./inspectorResponsiveEvidence";
import { openHostProject } from "./overlayReachability";
import { openPhoneTimeline } from "./phoneTimeline";
import {
  inspectSelection,
  openPaletteAsTouch,
  openProjectDialog,
  projectMenuButton,
} from "./stageNav";
import { ownsStudioAxe, type StudioAxeOwnership } from "./studioAxeOwnership";
import { setTheme, type Theme } from "./theme";

export type TouchAffordanceViewport = {
  width: number;
  height: number;
  textScale?: boolean;
  requireBodyOverflow?: boolean;
};

type TouchRun = {
  page: Page;
  viewport: TouchAffordanceViewport;
  theme: Theme;
  reducedMotion: boolean;
  owner: StudioAxeOwnership;
};

type MutationBoundary = {
  project: string;
  storage: string;
  commands: string[];
  stop: () => void;
};

type Chrome = {
  shell: string | null;
  folded: boolean;
  header: Awaited<ReturnType<Locator["boundingBox"]>>;
  stageMenu: Awaited<ReturnType<Locator["boundingBox"]>>;
  tabs: Awaited<ReturnType<Locator["boundingBox"]>>;
  player: Awaited<ReturnType<Locator["boundingBox"]>>;
};

type TextScale = { rootFontBefore: number; rootFontAfter: number };

export async function exerciseInviteAffordances(run: TouchRun): Promise<void> {
  const { page, viewport, theme, reducedMotion, owner } = run;
  const textScale = await prepareTouchPage(run);
  const boundary = await beginMutationBoundary(page);
  try {
    const menuOpener = projectMenuButton(page);
    const headerInvite = page
      .locator(".stage-frame-header")
      .getByRole("button", { name: "Invite", exact: true });
    const useHeader = await headerInvite.isVisible();
    const expectedOpener = useHeader ? headerInvite : menuOpener;
    const expectedOpenerBefore = await controlGeometry(expectedOpener);
    const focusBefore = await activeElement(page);
    await openProjectDialog(page, "share");
    const dialog = page.getByRole("dialog", { name: "Invite", exact: true });
    await expect(dialog).toBeVisible();

    if (viewport.width <= 767) {
      const sheet = page.locator(".bottom-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator(".bottom-sheet-grab")).toHaveCount(0);
      const close = sheet.getByRole("button", { name: "Close", exact: true });
      const height = sheet.getByRole("slider", { name: "Sheet height" });
      const expand = (name: string) =>
        sheet.getByRole("button", { name: `Expand to ${name}`, exact: true });
      const collapse = (name: string) =>
        sheet.getByRole("button", { name: `Collapse to ${name}`, exact: true });
      await settle(sheet);
      await expect(close).toBeFocused();
      await expect(height).toHaveAttribute("aria-valuetext", "Half height");
      const inviteEvidence: Record<string, unknown> = {
        viewport,
        theme,
        reducedMotion,
        textScale: textScaleEvidence(textScale),
        opener: expectedOpenerBefore,
        focusBefore,
      };
      inviteEvidence.halfInitial = await recordInviteGeometry(
        page,
        sheet,
        "invite-half-initial",
      );
      await assertInviteGeometry(page, sheet, viewport, owner);
      const initialHalf = await sheet.boundingBox();
      if (!initialHalf)
        throw new Error("The half Invite sheet has no geometry");
      await expect(expand("full height")).toBeVisible();
      await expect(collapse("strip")).toBeVisible();
      inviteEvidence.initialTargets = await assertPaintedTargets([
        close,
        expand("full height"),
        collapse("strip"),
      ]);

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(expectedOpener).toBeFocused();
      inviteEvidence.focusAfterEscape = await activeElement(page);

      await openProjectDialog(page, "share");
      await expect(dialog).toBeVisible();
      await settle(sheet);
      await expect(close).toBeFocused();
      await expect(height).toHaveValue("1");
      await height.focus();
      await expect(height).toBeFocused();
      await height.press("ArrowUp");
      await settleDrawer(sheet);
      await expect(height).toHaveValue("2");
      await expect(height).toHaveAttribute("aria-valuetext", "Full height");
      await height.press("ArrowDown");
      await settleDrawer(sheet);
      await expect(height).toHaveValue("1");
      await expect(height).toHaveAttribute("aria-valuetext", "Half height");
      await admittedPointerClick(page, expand("full height"));
      await settleDrawer(sheet);
      await expect(height).toHaveAttribute("aria-valuetext", "Full height");
      inviteEvidence.full = await recordInviteGeometry(
        page,
        sheet,
        "invite-full",
      );
      await assertInviteGeometry(page, sheet, viewport, owner);
      const fullBox = await sheet.boundingBox();
      if (!fullBox) throw new Error("The full Invite sheet has no geometry");
      await admittedPointerClick(page, collapse("strip"));
      await settleDrawer(sheet);
      await expect(height).toHaveAttribute("aria-valuetext", "Strip");
      await expect(height).toHaveValue("0");
      await expect(expand("half height")).toBeVisible();
      const peekBox = await sheet.boundingBox();
      if (!peekBox) throw new Error("The peek Invite sheet has no geometry");
      const peekBounds = await invitePeekBounds(page, sheet);
      expect(peekBox.height).toBeGreaterThanOrEqual(peekBounds.minimum - 1);
      expect(peekBox.height).toBeLessThanOrEqual(peekBounds.maximum + 1);
      if (peekBounds.slotHeight > peekBounds.maximum + 1)
        expect(peekBox.height).toBeLessThan(fullBox.height);
      await assertInviteGeometry(page, sheet, viewport, owner);
      inviteEvidence.peek = await recordInviteGeometry(
        page,
        sheet,
        "invite-peek",
      );
      await expect(collapse("strip")).toHaveCount(0);
      await admittedPointerClick(page, expand("half height"));
      await settleDrawer(sheet);
      await expect(height).toHaveAttribute("aria-valuetext", "Half height");
      await expect(height).toHaveValue("1");
      await expect(expand("full height")).toBeVisible();
      const restoredHalf = await sheet.boundingBox();
      if (!restoredHalf)
        throw new Error("The half Invite sheet has no geometry");
      expect(restoredHalf.height).toBeCloseTo(initialHalf.height, 0);
      inviteEvidence.halfRestored = await recordInviteGeometry(
        page,
        sheet,
        "invite-half-restored",
      );
      await admittedPointerClick(page, expand("full height"));
      await settleDrawer(sheet);
      await expect(height).toHaveAttribute("aria-valuetext", "Full height");
      await expect(height).toHaveValue("2");
      inviteEvidence.fullRestored = await recordInviteGeometry(
        page,
        sheet,
        "invite-full-restored",
      );
      inviteEvidence.scroll = await qualifyInviteScroll(page, sheet, viewport);
      if (ownsStudioAxe(owner))
        await expectPageAxeClean(page, ".bottom-sheet-chrome");
      inviteEvidence.closeTarget = await admittedPointerClick(page, close);
      await expect(dialog).toHaveCount(0);
      await expect(expectedOpener).toBeFocused();
      inviteEvidence.focusAfterClose = await activeElement(page);
      await openPaletteAsTouch(page);
      const palette = page.getByRole("dialog", {
        name: "Commands and shortcuts",
      });
      await expect(
        palette
          .getByRole("group", { name: "Gestures" })
          .getByRole("listitem")
          .filter({ hasText: "Optional ShareCut shortcut." }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      await assertBoundary(page, boundary);
      inviteEvidence.nonmutation = mutationEvidence(boundary);
      await attachEvidence("invite", inviteEvidence);
    } else {
      await expect(page.locator(".bottom-sheet")).toHaveCount(0);
      const panel = dialog.locator(".sys-sheet-centered");
      await expect(panel).toBeVisible();
      await expect(
        dialog.getByRole("heading", { name: "Invite", exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("region", { name: "Invite content", exact: true }),
      ).toBeVisible();
      const panelGeometry = {
        panel: await boxEvidence(panel),
        header: await boxEvidence(dialog.locator(".command-palette-header")),
        title: await boxEvidence(
          dialog.getByRole("heading", { name: "Invite", exact: true }),
        ),
        body: await boxEvidence(
          dialog.getByRole("region", { name: "Invite content", exact: true }),
        ),
      };
      await test.info().attach("invite-centered-open.png", {
        body: await page.screenshot({ type: "png" }),
        contentType: "image/png",
      });
      if (ownsStudioAxe(owner))
        await expectPageAxeClean(page, ".sys-sheet-centered");
      const close = dialog.getByRole("button", { name: "Close", exact: true });
      await expect(close).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(expectedOpener).toBeFocused();
      const focusAfterEscape = await activeElement(page);
      await openProjectDialog(page, "share");
      await expect(dialog).toBeVisible();
      const closeTarget = await admittedPointerClick(
        page,
        dialog.getByRole("button", { name: "Close", exact: true }),
      );
      await expect(dialog).toHaveCount(0);
      await expect(expectedOpener).toBeFocused();
      await assertBoundary(page, boundary);
      await attachEvidence("invite-centered", {
        viewport,
        theme,
        reducedMotion,
        textScale: textScaleEvidence(textScale),
        opener: expectedOpenerBefore,
        focusBefore,
        panel: panelGeometry,
        focusAfterEscape,
        closeTarget,
        focusAfterClose: await activeElement(page),
        nonmutation: mutationEvidence(boundary),
      });
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  } finally {
    boundary.stop();
  }
}

export async function exerciseClipInspectorAffordances(
  run: TouchRun,
): Promise<void> {
  const { page, viewport, theme, owner } = run;
  const textScale = await prepareTouchPage(run);
  const boundary = await beginMutationBoundary(page);
  try {
    const clip = page.locator(".lane-row .clip-hit").first();
    await clip.focus();
    await clip.press("Enter");
    await expect(clip).toHaveAttribute("aria-pressed", "true");
    const inspect = page
      .getByRole("group", { name: /^(Selection|Edit) actions$/ })
      .getByRole("button", { name: "Inspect", exact: true });
    const toolsButton = page.getByRole("button", {
      name: /^Tools(, (Timeline|Script))?$/,
    });
    await expect(async () => {
      expect(
        (await inspect.isVisible()) || (await toolsButton.isVisible()),
      ).toBe(true);
    }).toPass({ timeout: 20_000 });
    const routeControl = (await inspect.isVisible()) ? inspect : toolsButton;
    await expect(routeControl).toBeVisible();
    const openerBefore = await controlGeometry(routeControl);
    const focusBefore = await activeElement(page);
    await page.evaluate(() => {
      const capture = (event: MouseEvent) => {
        if (
          !(event.target instanceof Element) ||
          !event.target.closest('button[aria-label="Inspect"]')
        )
          return;
        document.removeEventListener("click", capture, true);
        const active = document.activeElement;
        const fromTools =
          event.target
            .closest('[role="dialog"]')
            ?.querySelector("h2")
            ?.textContent?.trim() === "Tools";
        const opener = fromTools
          ? "tools"
          : active instanceof Element && active.matches(".lane-row .clip-hit")
            ? "clip"
            : active instanceof Element && active.matches(".stage-frame-body")
              ? "stage"
              : active instanceof Element &&
                  active.matches('button[aria-label="Inspect"]')
                ? "inspect"
                : active instanceof Element &&
                    /^Tools/.test(active.getAttribute("aria-label") ?? "")
                  ? "tools"
                  : null;
        (
          window as Window & { __touchInspectorOpener?: string }
        ).__touchInspectorOpener =
          opener ??
          JSON.stringify({
            tag: active instanceof Element ? active.tagName : null,
            className: active instanceof Element ? active.className : null,
            label:
              active instanceof Element
                ? active.getAttribute("aria-label")
                : null,
            text: active instanceof Element ? active.textContent?.trim() : null,
          });
      };
      document.addEventListener("click", capture, {
        capture: true,
      });
    });
    await inspectSelection(page);
    const openerKind = await page.evaluate(() => {
      const target = window as Window & {
        __touchInspectorOpener?: string;
      };
      const opener = target.__touchInspectorOpener ?? "unknown";
      delete target.__touchInspectorOpener;
      return opener;
    });
    expect(["clip", "inspect", "stage", "tools"]).toContain(openerKind);
    const expectedOpener =
      openerKind === "inspect"
        ? inspect
        : openerKind === "tools"
          ? toolsButton
          : openerKind === "stage"
            ? page.locator(".stage-frame-body")
            : clip;
    const inspector = page.getByRole("dialog", { name: "Inspector" });
    await expect(inspector).toBeVisible();
    await expect(page.locator(".bottom-sheet")).toHaveCount(0);
    const heading = inspector.locator(".sys-inspector-header .sys-sheet-title");
    const selectionTitle = await inspectorHeadingText(heading);
    expect(selectionTitle.trim().length).toBeGreaterThan(0);
    const evidence: Record<string, unknown> = {
      viewport,
      theme,
      reducedMotion: run.reducedMotion,
      textScale: textScaleEvidence(textScale),
      opener: openerBefore,
      openerKind,
      focusBefore,
      selectionTitle,
      focusOnOpen: await activeElement(page),
    };
    await assertInspectorInitialFocus(inspector);
    if (viewport.width <= 767) {
      const sheet = page.locator(".sys-inspector--phone");
      const grip = sheet.getByRole("slider", { name: "Sheet height" });
      const close = sheet.getByRole("button", { name: "Close", exact: true });
      await settle(sheet);
      const initial = await sheet.getAttribute("data-detent");
      expect(["half", "full"]).toContain(initial);
      await expect(grip).toBeVisible();
      const gripTarget = await inspectorGripTarget(grip);
      await attachEvidence("inspector-grip-open", gripTarget);
      evidence.targets = {
        grip: gripTarget,
        close: await assertPaintedTargets([close]),
      };
      evidence.phoneOpen = await recordInspectorGeometry(
        page,
        sheet,
        "inspector-phone-open",
      );
      await assertInspectorGeometry(page, sheet, viewport);
      if (ownsStudioAxe(owner))
        await expectPageAxeClean(page, ".sys-inspector");

      await page.keyboard.press("Escape");
      await expect(inspector).toHaveCount(0);
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(expectedOpener).toBeFocused();
      evidence.focusAfterEscape = await activeElement(page);

      await clip.focus();
      await expect(clip).toBeFocused();
      await page.keyboard.press("i");
      await expect(inspector).toBeVisible();
      await expect(heading).toBeVisible();
      expect(await inspectorHeadingText(heading)).toBe(selectionTitle);
      evidence.reopenedTitle = await inspectorHeadingText(heading);
      await expect(inspector.locator(".sys-inspector-grip")).toHaveAttribute(
        "aria-valuetext",
        initial === "full" ? "Full height" : "Half height",
      );
      await settle(sheet);
      await assertInspectorInitialFocus(inspector);
      if (initial === "full") {
        await grip.press("Home");
        await expect(sheet).toHaveAttribute("data-detent", "dock");
        await expect(sheet.locator(".sys-inspector-content")).toHaveAttribute(
          "inert",
          "",
        );
        await expect(grip).toHaveAttribute("aria-valuetext", "Dock");
        evidence.dock = await recordInspectorGeometry(
          page,
          sheet,
          "inspector-dock",
        );
        await grip.press("ArrowUp");
        await expect(sheet).toHaveAttribute("data-detent", "half");
        evidence.half = await recordInspectorGeometry(
          page,
          sheet,
          "inspector-half",
        );
      } else {
        await grip.press("End");
        await expect(sheet).toHaveAttribute("data-detent", "full");
        evidence.fullFromHalf = await recordInspectorGeometry(
          page,
          sheet,
          "inspector-full-from-half",
        );
        await grip.press("Home");
        await expect(sheet).toHaveAttribute("data-detent", "dock");
        await expect(sheet.locator(".sys-inspector-content")).toHaveAttribute(
          "inert",
          "",
        );
        evidence.dock = await recordInspectorGeometry(
          page,
          sheet,
          "inspector-dock",
        );
        await grip.press("ArrowUp");
        await expect(sheet).toHaveAttribute("data-detent", "half");
        evidence.half = await recordInspectorGeometry(
          page,
          sheet,
          "inspector-half",
        );
        await grip.press("ArrowUp");
        await expect(sheet).toHaveAttribute("data-detent", "full");
        evidence.full = await recordInspectorGeometry(
          page,
          sheet,
          "inspector-full",
        );
      }
      await grip.press("End");
      await expect(sheet).toHaveAttribute("data-detent", "full");
      const pointerGrip = await inspectorGripTarget(grip);
      await page.mouse.click(pointerGrip.point.x, pointerGrip.point.y);
      evidence.pointerGrip = pointerGrip;
      await expect(sheet).toHaveAttribute("data-detent", "half");
      evidence.pointerHalf = await recordInspectorGeometry(
        page,
        sheet,
        "inspector-pointer-half",
      );
      await grip.press("End");
      await expect(sheet).toHaveAttribute("data-detent", "full");
      evidence.phoneFull = await recordInspectorGeometry(
        page,
        sheet,
        "inspector-phone-full",
      );
      evidence.scroll = await qualifyInspectorScroll(page, sheet, viewport);
      if (ownsStudioAxe(owner))
        await expectPageAxeClean(page, ".sys-inspector");
      evidence.closeTarget = await admittedPointerClick(page, close);
      await expect(inspector).toHaveCount(0);
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      evidence.focusAfterClose = await activeElement(page);
      await test.info().attach("inspector-close-focus.json", {
        body: JSON.stringify({
          expected: await controlGeometry(clip),
          actual: evidence.focusAfterClose,
          openerKind,
        }),
        contentType: "application/json",
      });
      await expect(clip).toBeFocused();

      await page.keyboard.press("i");
      await expect(inspector).toBeVisible();
      await expect(heading).toBeVisible();
      expect(await inspectorHeadingText(heading)).toBe(selectionTitle);
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(sheet).toHaveAttribute(
        "data-detent",
        initial === "full" ? "full" : "half",
      );
      await expect(grip).toHaveAttribute(
        "aria-valuetext",
        initial === "full" ? "Full height" : "Half height",
      );
      evidence.reopenedFromFullTitle = await inspectorHeadingText(heading);
      await assertInspectorInitialFocus(inspector);
      evidence.reopenedCloseTarget = await admittedPointerClick(page, close);
      await expect(inspector).toHaveCount(0);
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(clip).toBeFocused();
      evidence.focusAfterReopenedClose = await activeElement(page);
    } else {
      await expect(page.locator(".sys-inspector--card")).toBeVisible();
      await expect(page.locator(".bottom-sheet")).toHaveCount(0);
      await expect(heading).toBeVisible();
      evidence.card = await recordInspectorCardGeometry(page, inspector);
      if (ownsStudioAxe(owner))
        await expectPageAxeClean(page, ".sys-inspector");
      await page.keyboard.press("Escape");
      await expect(inspector).toHaveCount(0);
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(expectedOpener).toBeFocused();
      evidence.focusAfterEscape = await activeElement(page);

      await clip.focus();
      await page.keyboard.press("i");
      await expect(page.locator(".sys-inspector--card")).toBeVisible();
      expect(await inspectorHeadingText(heading)).toBe(selectionTitle);
      evidence.reopenedTitle = await inspectorHeadingText(heading);
      await assertInspectorInitialFocus(inspector);
      evidence.cardAfterKey = await recordInspectorCardGeometry(
        page,
        inspector,
      );
      evidence.closeTarget = await admittedPointerClick(
        page,
        inspector.getByRole("button", { name: "Close", exact: true }),
      );
      await expect(inspector).toHaveCount(0);
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(clip).toBeFocused();
      evidence.focusAfterClose = await activeElement(page);
    }
    await assertBoundary(page, boundary);
    evidence.nonmutation = mutationEvidence(boundary);
    await attachEvidence("clip-inspector", evidence);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  } finally {
    boundary.stop();
  }
}

async function prepareTouchPage(run: TouchRun): Promise<TextScale> {
  const { page, viewport, theme, reducedMotion } = run;
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  const pointer = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    touchPoints: navigator.maxTouchPoints,
  }));
  expect(pointer.coarse).toBe(true);
  await page.emulateMedia({
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await openHostProject(page);
  if (viewport.width <= 767) await openPhoneTimeline(page);
  else if (viewport.width <= 1194) {
    const scriptToggle = page
      .getByRole("group", { name: "Timeline view" })
      .getByRole("button", { name: "Show or hide Script", exact: true });
    if ((await scriptToggle.getAttribute("aria-pressed")) === "true")
      await scriptToggle.click();
  }
  await setTheme(page, theme);
  let rootFontBefore = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  let rootFontAfter = rootFontBefore;
  if (viewport.textScale) {
    const [before, after] = await page.evaluate(() => {
      const root = document.documentElement;
      const initial = Number.parseFloat(getComputedStyle(root).fontSize);
      root.style.fontSize = `${initial * 2}px`;
      return [initial, Number.parseFloat(getComputedStyle(root).fontSize)];
    });
    expect(after).toBe(before * 2);
    rootFontBefore = before;
    rootFontAfter = after;
  }
  return { rootFontBefore, rootFontAfter };
}

async function beginMutationBoundary(page: Page): Promise<MutationBoundary> {
  const commands: string[] = [];
  const listener = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname === "/api/document/command") {
      commands.push(request.postData() ?? "");
    }
  };
  const project = fs.readFileSync(e2eProjectPath, "utf8");
  const storage = await browserStorageState(page);
  page.on("request", listener);
  return {
    project,
    storage,
    commands,
    stop: () => page.off("request", listener),
  };
}

async function assertBoundary(page: Page, boundary: MutationBoundary) {
  expect(boundary.commands).toEqual([]);
  expect(fs.readFileSync(e2eProjectPath, "utf8")).toBe(boundary.project);
  expect(await browserStorageState(page)).toBe(boundary.storage);
}

async function assertInviteGeometry(
  page: Page,
  sheet: Locator,
  viewport: TouchAffordanceViewport,
  owner: StudioAxeOwnership,
) {
  await settleDrawer(sheet);
  const sheetBox = await sheet.boundingBox();
  const header = await sheet.locator(".bottom-sheet-header").boundingBox();
  const title = await sheet.locator(".bottom-sheet-title").boundingBox();
  const body = await sheet.locator(".sys-sheet-bottom").boundingBox();
  const scrollGeometry = await controlGeometry(
    sheet.locator(".sys-sheet-scroll"),
  );
  const chrome = await shellChrome(page);
  if (!sheetBox || !header || !title || !body) {
    throw new Error("Invite sheet geometry is incomplete");
  }
  expect(body.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(scrollGeometry.measured[0].visibleArea.state).toBe("positive");
  expectExpectedShellChrome(chrome);
  expectSheetClearsShellChrome(sheetBox, chrome);
  if (viewport.textScale) {
    const titleMetrics = await sheet
      .locator(".bottom-sheet-title")
      .evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
    expect(titleMetrics.scrollWidth).toBeLessThanOrEqual(
      titleMetrics.clientWidth,
    );
    const resizeControls = await sheet
      .locator(".bottom-sheet-resize-action")
      .all();
    for (const control of resizeControls) {
      const controlBox = await control.boundingBox();
      if (!controlBox)
        throw new Error("A visible Invite resize control has no geometry");
      const separated =
        title.y + title.height <= controlBox.y + 1 ||
        controlBox.y + controlBox.height <= title.y + 1 ||
        title.x + title.width <= controlBox.x + 1 ||
        controlBox.x + controlBox.width <= title.x + 1;
      expect({ separated, title, controlBox }).toMatchObject({
        separated: true,
      });
    }
  }
  if (ownsStudioAxe(owner))
    await expectPageAxeClean(page, ".bottom-sheet-chrome");
}

async function invitePeekBounds(page: Page, sheet: Locator) {
  const root = page.locator(".bottom-sheet-root");
  const [rootFont, slotHeight] = await Promise.all([
    page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
    root.evaluate((element) => element.clientHeight),
  ]);
  const detent = sheet.getByRole("slider", { name: "Sheet height" });
  await expect(detent).toHaveValue("0");
  await expect(detent).toHaveAttribute("aria-valuetext", "Strip");
  return {
    minimum: Math.min(4 * rootFont, slotHeight),
    maximum: Math.min(7.5 * rootFont, slotHeight),
    rootFont,
    slotHeight,
  };
}

async function recordInviteGeometry(
  page: Page,
  sheet: Locator,
  name: string,
): Promise<Record<string, unknown>> {
  await settleDrawer(sheet);
  const range = sheet.getByRole("slider", { name: "Sheet height" });
  const scroll = sheet.locator(".sys-sheet-scroll");
  const resizeControls = await sheet
    .locator(".bottom-sheet-resize-action")
    .all();
  const evidence = {
    sheet: await boxEvidence(sheet),
    header: await boxEvidence(sheet.locator(".bottom-sheet-header")),
    title: await boxEvidence(sheet.locator(".bottom-sheet-title")),
    body: await boxEvidence(sheet.locator(".sys-sheet-bottom")),
    scroll: await controlGeometry(scroll),
    scrollState: await scroll.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    })),
    detent: {
      value: await range.inputValue(),
      text: await range.getAttribute("aria-valuetext"),
    },
    resizeControls: await Promise.all(
      resizeControls.map(async (control) => ({
        name: await control.getAttribute("aria-label"),
        geometry: await controlGeometry(control),
      })),
    ),
    close: await controlGeometry(
      sheet.getByRole("button", { name: "Close", exact: true }),
    ),
    active: await activeElement(page),
  };
  await attachEvidence(name, evidence);
  await test.info().attach(`${name}.png`, {
    body: await page.screenshot({ type: "png" }),
    contentType: "image/png",
  });
  return evidence;
}

async function qualifyInviteScroll(
  page: Page,
  sheet: Locator,
  viewport: TouchAffordanceViewport,
): Promise<Record<string, unknown>> {
  const scroll = sheet.locator(".sys-sheet-scroll");
  const before = await scroll.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY,
    detent: element
      .closest(".bottom-sheet")
      ?.querySelector<HTMLInputElement>('input[aria-label="Sheet height"]')
      ?.value,
    panel: element.closest(".bottom-sheet")?.getBoundingClientRect().toJSON(),
    header: element
      .closest(".bottom-sheet")
      ?.querySelector(".bottom-sheet-header")
      ?.getBoundingClientRect()
      .toJSON(),
  }));
  expect(before.scrollTop).toBe(0);
  if (viewport.requireBodyOverflow) {
    expect(before.clientHeight).toBeGreaterThan(0);
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 1);
    expect(["auto", "scroll"]).toContain(before.overflowY);
    await expect(scroll.locator("input, select, button").first()).toBeVisible();
  }
  if (before.scrollHeight > before.clientHeight + 1) {
    const wheel = await nativeWheel(page, scroll);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before.scrollTop);
    await settleDrawer(sheet);
    const after = await scroll.evaluate((element) => ({
      scrollTop: element.scrollTop,
      detent: element
        .closest(".bottom-sheet")
        ?.querySelector<HTMLInputElement>('input[aria-label="Sheet height"]')
        ?.value,
      panel: element.closest(".bottom-sheet")?.getBoundingClientRect().toJSON(),
      header: element
        .closest(".bottom-sheet")
        ?.querySelector(".bottom-sheet-header")
        ?.getBoundingClientRect()
        .toJSON(),
    }));
    expect(after.detent).toBe(before.detent);
    expect(after.panel).toEqual(before.panel);
    expect(after.header).toEqual(before.header);
    const evidence = { before, wheel, after };
    await attachEvidence("invite-scroll", evidence);
    return evidence;
  }
  return { before, after: before, wheel: null };
}

async function assertInspectorGeometry(
  page: Page,
  sheet: Locator,
  viewport: TouchAffordanceViewport,
) {
  await settle(sheet);
  const box = await sheet.boundingBox();
  const header = await sheet.locator(".sys-inspector-header").boundingBox();
  const title = await sheet
    .locator(".sys-inspector-header .sys-sheet-title")
    .boundingBox();
  const body = await sheet.locator(".sys-inspector-scroll").boundingBox();
  const chrome = await shellChrome(page);
  if (!box || !header || !title || !body)
    throw new Error("Inspector geometry is incomplete");
  expectExpectedShellChrome(chrome);
  expectSheetClearsShellChrome(box, chrome);
  expect(title.y).toBeGreaterThanOrEqual(header.y - 1);
  expect(title.y + title.height).toBeLessThanOrEqual(
    header.y + header.height + 1,
  );
  expect(body.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(
    (await controlGeometry(sheet.locator(".sys-inspector-scroll"))).measured[0]
      .visibleArea.state,
  ).toBe("positive");
  if (viewport.textScale) {
    const scroll = sheet.locator(".sys-inspector-scroll");
    const state = await scroll.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(state.clientHeight).toBeGreaterThan(0);
    expect(state.scrollHeight).toBeGreaterThan(state.clientHeight + 1);
    expect(["auto", "scroll"]).toContain(state.overflowY);
  }
}

async function recordInspectorGeometry(
  page: Page,
  sheet: Locator,
  name: string,
): Promise<Record<string, unknown>> {
  await settle(sheet);
  const scroll = sheet.locator(".sys-inspector-scroll");
  const grip = sheet.getByRole("slider", { name: "Sheet height" });
  const evidence = {
    sheet: await boxEvidence(sheet),
    header: await boxEvidence(sheet.locator(".sys-inspector-header")),
    title: await boxEvidence(
      sheet.locator(".sys-inspector-header .sys-sheet-title"),
    ),
    body: await boxEvidence(scroll),
    detent: {
      value: await grip.getAttribute("aria-valuenow"),
      text: await grip.getAttribute("aria-valuetext"),
    },
    grip: await controlGeometry(grip),
    scroll: await controlGeometry(scroll),
    scrollState: await scroll.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    })),
    close: await controlGeometry(
      sheet.getByRole("button", { name: "Close", exact: true }),
    ),
    active: await activeElement(page),
  };
  await attachEvidence(name, evidence);
  await test.info().attach(`${name}.png`, {
    body: await page.screenshot({ type: "png" }),
    contentType: "image/png",
  });
  return evidence;
}

async function recordInspectorCardGeometry(page: Page, inspector: Locator) {
  const header = inspector.locator(".sys-inspector-header");
  const title = inspector.locator(".sys-inspector-header .sys-sheet-title");
  const body = inspector.locator(".sys-inspector-scroll");
  const headerBox = await header.boundingBox();
  const titleBox = await title.boundingBox();
  const bodyBox = await body.boundingBox();
  if (!headerBox || !titleBox || !bodyBox)
    throw new Error("Inspector card geometry is incomplete");
  expect(titleBox.y).toBeGreaterThanOrEqual(headerBox.y - 1);
  expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(
    headerBox.y + headerBox.height + 1,
  );
  expect(bodyBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
  const bodyGeometry = await controlGeometry(body);
  expect(bodyGeometry.measured[0].visibleArea.state).toBe("positive");
  const evidence = {
    card: await boxEvidence(inspector),
    header: await boxEvidence(header),
    title: await boxEvidence(title),
    body: await boxEvidence(body),
    active: await activeElement(page),
  };
  await attachEvidence("inspector-card", evidence);
  await test.info().attach("inspector-card.png", {
    body: await page.screenshot({ type: "png" }),
    contentType: "image/png",
  });
  return evidence;
}

async function qualifyInspectorScroll(
  page: Page,
  sheet: Locator,
  viewport: TouchAffordanceViewport,
): Promise<Record<string, unknown>> {
  const scroll = sheet.locator(".sys-inspector-scroll");
  const before = await scroll.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollTop: element.scrollTop,
    detent: element.closest(".sys-inspector")?.getAttribute("data-detent"),
    panel: element.closest(".sys-inspector")?.getBoundingClientRect().toJSON(),
    header: element
      .closest(".sys-inspector")
      ?.querySelector(".sys-inspector-header")
      ?.getBoundingClientRect()
      .toJSON(),
  }));
  expect(before.scrollTop).toBe(0);
  if (viewport.requireBodyOverflow) {
    expect(before.clientHeight).toBeGreaterThan(0);
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 1);
  }
  if (before.scrollHeight > before.clientHeight + 1) {
    const wheel = await nativeWheel(page, scroll);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before.scrollTop);
    await settle(sheet);
    const after = await scroll.evaluate((element) => ({
      scrollTop: element.scrollTop,
      detent: element.closest(".sys-inspector")?.getAttribute("data-detent"),
      panel: element
        .closest(".sys-inspector")
        ?.getBoundingClientRect()
        .toJSON(),
      header: element
        .closest(".sys-inspector")
        ?.querySelector(".sys-inspector-header")
        ?.getBoundingClientRect()
        .toJSON(),
    }));
    expect(after.detent).toBe(before.detent);
    expect(after.panel).toEqual(before.panel);
    expect(after.header).toEqual(before.header);
    const evidence = { before, wheel, after };
    await attachEvidence("inspector-scroll", evidence);
    return evidence;
  }
  expect(viewport.requireBodyOverflow).toBe(false);
  return { before, after: before, wheel: null };
}

async function nativeWheel(page: Page, owner: Locator) {
  const geometry = await controlGeometry(owner);
  const visible = geometry.measured[0].visibleArea;
  expect(visible.state).toBe("positive");
  expect(geometry.hitsControl).toBe(true);
  if (visible.state !== "positive")
    throw new Error("The inner scroll owner has no visible intersection");
  const point = {
    x: (visible.bounds.left + visible.bounds.right) / 2,
    y: (visible.bounds.top + visible.bounds.bottom) / 2,
  };
  const hit = await owner.evaluate((element, location) => {
    const target = document.elementFromPoint(location.x, location.y);
    return {
      owner: element.className,
      target: target instanceof HTMLElement ? target.className : null,
      admitted:
        target === element || (target !== null && element.contains(target)),
    };
  }, point);
  expect(hit.admitted, JSON.stringify(hit)).toBe(true);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 240);
  return { point, geometry, hit };
}

async function inspectorGripTarget(grip: Locator) {
  await expect(grip).toBeVisible();
  const geometry = await controlGeometry(grip);
  const visible = geometry.measured[0].visibleArea;
  expect(visible.state).toBe("positive");
  if (visible.state !== "positive")
    throw new Error("The Inspector grip has no visible hit area");
  expect(visible.bounds.right - visible.bounds.left).toBeGreaterThanOrEqual(44);
  expect(visible.bounds.bottom - visible.bounds.top).toBeGreaterThanOrEqual(44);
  expect(geometry.hitsControl).toBe(true);
  const point = {
    x: (visible.bounds.left + visible.bounds.right) / 2,
    y: (visible.bounds.top + visible.bounds.bottom) / 2,
  };
  const ownsPoint = await grip.evaluate((element, location) => {
    const target = document.elementFromPoint(location.x, location.y);
    return target === element || (target !== null && element.contains(target));
  }, point);
  expect(ownsPoint).toBe(true);
  return { geometry, point };
}

async function assertPaintedTargets(controls: Locator[]) {
  const evidence = [];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const geometry = await controlGeometry(control);
    expect(geometry.fullyVisible).toBe(true);
    expect(geometry.hitsControl).toBe(true);
    const rect = geometry.rect;
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
    evidence.push(geometry);
  }
  return evidence;
}

async function admittedPointerClick(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  const geometry = await controlGeometry(control);
  expect(geometry.fullyVisible).toBe(true);
  expect(geometry.hitsControl).toBe(true);
  expect(geometry.rect.width).toBeGreaterThanOrEqual(44);
  expect(geometry.rect.height).toBeGreaterThanOrEqual(44);
  await page.mouse.click(geometry.point.x, geometry.point.y);
  return geometry;
}

async function settleDrawer(sheet: Locator): Promise<void> {
  await expect.poll(() => sheet.getAttribute("data-drawer-motion")).toBeNull();
  await settle(sheet);
}

async function settle(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
}

async function boxEvidence(locator: Locator) {
  return {
    box: await locator.boundingBox(),
    geometry: await controlGeometry(locator),
  };
}

async function assertInspectorInitialFocus(inspector: Locator): Promise<void> {
  const focus = await inspector.evaluate((box) => {
    const selector =
      ".sys-inspector-scroll :is(button, input:not([type='hidden']), select, textarea, [tabindex]):not(:disabled, [aria-disabled='true'], [tabindex='-1'])";
    const first = [...box.querySelectorAll<HTMLElement>(selector)].find(
      (element) => !element.closest("[hidden], [inert]"),
    );
    const takesText =
      first?.matches("input, textarea, select, [role='spinbutton']") ||
      first?.isContentEditable;
    const target =
      !first || takesText
        ? box.querySelector<HTMLElement>("[data-inspector-anchor]")
        : first;
    return {
      expected: target?.outerHTML ?? null,
      active:
        document.activeElement instanceof HTMLElement
          ? document.activeElement.outerHTML
          : null,
      matches: target !== null && target === document.activeElement,
    };
  });
  expect(focus.matches, JSON.stringify(focus)).toBe(true);
}

async function inspectorHeadingText(heading: Locator): Promise<string> {
  const input = heading.locator("input");
  return (await input.count()) ? input.inputValue() : heading.innerText();
}

async function activeElement(page: Page) {
  return page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    className:
      document.activeElement instanceof HTMLElement
        ? document.activeElement.className
        : null,
    label:
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute("aria-label")
        : null,
    text: document.activeElement?.textContent?.trim().slice(0, 120) ?? null,
  }));
}

function textScaleEvidence(scale: TextScale) {
  return {
    method: "CSS root font size doubling; not browser zoom or OS Dynamic Type",
    beforePx: scale.rootFontBefore,
    afterPx: scale.rootFontAfter,
  };
}

function mutationEvidence(boundary: MutationBoundary) {
  return {
    documentCommands: boundary.commands,
    projectBytesUnchanged: true,
    browserStorageUnchanged: true,
  };
}

async function attachEvidence(name: string, value: unknown): Promise<void> {
  await test.info().attach(`${name}.json`, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}

async function shellChrome(page: Page): Promise<Chrome> {
  const optional = async (locator: Locator) => {
    if (!(await locator.count()) || !(await locator.first().isVisible()))
      return null;
    return locator.first().boundingBox();
  };
  const root = page.locator("html");
  return {
    shell: await root.getAttribute("data-shell"),
    folded: await root.evaluate(
      (element) => "frameShort" in (element as HTMLElement).dataset,
    ),
    header: await optional(page.locator(".stage-frame-header")),
    stageMenu: await optional(page.locator(".sys-header-stage-button")),
    tabs: await optional(page.locator(".stage-frame-tabs")),
    player: await optional(page.locator(".stage-frame-player")),
  };
}

function expectExpectedShellChrome(chrome: Chrome): void {
  if (chrome.shell === "phone") {
    if (chrome.folded) expect(chrome.stageMenu).not.toBeNull();
    else expect(chrome.tabs).not.toBeNull();
  }
  if (chrome.shell !== null) expect(chrome.player).not.toBeNull();
}

function expectSheetClearsShellChrome(
  sheet: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>,
  chrome: Chrome,
): void {
  for (const chromeBox of [chrome.tabs, chrome.player]) {
    if (chromeBox)
      expect(sheet.y + sheet.height).toBeLessThanOrEqual(chromeBox.y + 1);
  }
  if (chrome.shell === "phone" && chrome.header) {
    expect(sheet.y).toBeGreaterThanOrEqual(
      chrome.header.y + chrome.header.height - 1,
    );
  }
}

async function browserStorageState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const entries = (storage: Storage): Array<[string, string | null]> =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index);
        return key === null ? null : [key, storage.getItem(key)];
      })
        .filter((entry): entry is [string, string | null] => entry !== null)
        .sort(([first], [second]) => first.localeCompare(second));
    return JSON.stringify({
      local: entries(localStorage),
      session: entries(sessionStorage),
    });
  });
}
