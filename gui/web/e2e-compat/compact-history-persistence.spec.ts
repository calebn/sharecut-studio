import { expect, type Locator, type TestInfo } from "@playwright/test";
import {
  compactHistory,
  edited,
  type Fixtures,
  openAt,
  original,
  railHistory,
  receipt,
  SIZES,
  savedEnvelope,
  test,
} from "../e2e/compactChromeFixture";
import { newFinger } from "../e2e/finger";
import {
  controlGeometry,
  exposeControl,
} from "../e2e/inspectorResponsiveEvidence";
import type { InteractionReceipt } from "../e2e/interactionEvidence";
import { centerOf, lane, watchCommands } from "../e2e/touchTimeline";

test.use({ hasTouch: true });
test.describe.configure({ timeout: 240_000 });

/** Undo and Redo are in view and on top before and after an edit, and a tap on Undo undoes it. */
async function undoStaysReachable(
  name: keyof typeof SIZES,
  rootPx: number,
  theme: "dark" | "light",
  { page, context, browserName }: Fixtures,
  info: TestInfo,
): Promise<void> {
  await openAt(page, SIZES[name], 16, theme);
  const laneHeights = () =>
    page
      .locator(".lane-row")
      .evaluateAll((rows) =>
        rows.map((row) => row.getBoundingClientRect().height),
      );
  await page.locator("html").evaluate((html, px) => {
    html.style.fontSize = `${px}px`;
  }, rootPx);
  await page.waitForTimeout(350);
  const closedLaneHeights = await laneHeights();
  await page.locator("html").evaluate((html) => {
    html.style.fontSize = "16px";
  });
  await page.waitForTimeout(350);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const discovery: InteractionReceipt[] = [];
  const measure = async (controls: Locator) => {
    const undo = controls.getByRole("button", { name: "Undo" });
    const redo = controls.getByRole("button", { name: "Redo" });
    const otherControls = await Promise.all(
      (
        await page
          .locator(".bottom-sheet--compact .bottom-sheet-header-actions button")
          .all()
      ).map((button) => controlGeometry(button)),
    );
    const undoGeometry = await controlGeometry(undo),
      redoGeometry = await controlGeometry(redo);
    const intersects = (
      a: { left: number; right: number; top: number; bottom: number },
      b: { left: number; right: number; top: number; bottom: number },
    ) =>
      a.left < b.right &&
      a.right > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top;
    const otherBoxes = otherControls.filter(
      (control) =>
        control.measured[0].label !== "Undo" &&
        control.measured[0].label !== "Redo",
    );
    const overlaps = [undoGeometry, redoGeometry].some((control) =>
      otherBoxes.some((other) => intersects(control.rect, other.rect)),
    );
    const card = page.locator(".ui-toast-region--app .ui-toast");
    let feedback = null;
    if (await card.count()) {
      const geometry = await controlGeometry(card);
      const feedbackVisible = geometry.measured[0].visibleArea;
      const controls = [];
      for (const element of await page
        .locator(
          ".bottom-sheet--compact :is(button, input, select, textarea, label, [role='button'])",
        )
        .all()) {
        if (await element.evaluate((node) => !!node.closest(".ui-toast")))
          continue;
        const control = await controlGeometry(element);
        const area = control.measured[0].visibleArea;
        if (area.state !== "positive") continue;
        controls.push({
          geometry: control,
          visible: area.bounds,
          overlaps:
            feedbackVisible.state === "positive" &&
            intersects(area.bounds, feedbackVisible.bounds),
        });
      }
      const dismiss = await controlGeometry(card.locator("button:last-child"));
      feedback = {
        geometry,
        visible: feedbackVisible,
        inView: geometry.fullyVisible,
        dismissOnTop: dismiss.hitsControl,
        controls,
        overlaps: controls.filter((control) => control.overlaps),
      };
    }
    return {
      undo: undoGeometry,
      redo: redoGeometry,
      otherControls,
      overlaps,
      feedback,
      feedbackActions: await Promise.all(
        (await page.locator(".ui-toast-region--app button").all()).map(
          (button) => controlGeometry(button),
        ),
      ),
      visibleLaneHeight: await page.evaluate(() => {
        const lane = document
          .querySelector(".timeline-scroll")
          ?.getBoundingClientRect();
        const strip = document
          .querySelector(".bottom-sheet")
          ?.getBoundingClientRect();
        const chrome = document
          .querySelector(".bottom-sheet-chrome")
          ?.getBoundingClientRect();
        return {
          visible:
            lane && strip
              ? Math.max(0, Math.min(lane.bottom, strip.top) - lane.top)
              : 0,
          lane: lane?.toJSON(),
          strip: strip?.toJSON(),
          chrome: chrome?.toJSON(),
          bottomChrome: document
            .querySelector(
              document.documentElement.dataset.shell === "phone"
                ? ".mobile-nav"
                : ".daw-shell > .status-bar",
            )
            ?.getBoundingClientRect()
            .toJSON(),
          shell: document.documentElement.dataset.shell,
          layout: document.documentElement.dataset.layout,
        };
      }),
    };
  };
  const seen: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  const check = async (step: string, controls: Locator) => {
    const beforeReveal = await measure(controls);
    await receipt(
      info,
      `hit-${name}-${rootPx}-${theme}-${step}-before-header-reveal`,
      beforeReveal,
    );
    for (const control of [
      beforeReveal.undo,
      beforeReveal.redo,
      ...beforeReveal.otherControls,
    ]) {
      expect({ step, ...control }).toMatchObject({
        step,
        fullyVisible: true,
        hitsControl: true,
      });
      expect(control.rect.width).toBeGreaterThanOrEqual(44);
      expect(control.rect.height).toBeGreaterThanOrEqual(44);
    }
    if (beforeReveal.feedback)
      expect(beforeReveal.feedback.overlaps).toEqual([]);
    if (
      beforeReveal.feedback &&
      (step === "strip-open-after-edit" ||
        step.startsWith("feedback-") ||
        step === "level-saved")
    ) {
      await exposeControl(
        page,
        page.locator(".ui-toast-region--app .ui-toast"),
        discovery,
      );
      for (const action of await page
        .locator(".ui-toast-region--app button")
        .all()) {
        await exposeControl(page, action, discovery);
        const geometry = await controlGeometry(action);
        expect(geometry.fullyVisible).toBe(true);
        expect(geometry.hitsControl).toBe(true);
        expect(geometry.rect.width).toBeGreaterThanOrEqual(44);
        expect(geometry.rect.height).toBeGreaterThanOrEqual(44);
      }
      await receipt(info, `feedback-discovery-${step}`, discovery);
    }
    seen[step] = await measure(controls);
    await receipt(info, `hit-${name}-${rootPx}-${theme}-${step}`, seen[step]);
    await info.attach(`hit-${step}`, {
      body: await page.screenshot({
        path: info.outputPath(`hit-${step}.png`),
      }),
      contentType: "image/png",
    });
  };
  await check("rail", railHistory(page));

  const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
  await finger.down(at);
  await page.waitForTimeout(60);
  await finger.up();
  await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  await page.waitForTimeout(600);
  const headerHistory = compactHistory(page);
  await check("peek", headerHistory);
  const census = await page
    .locator(".bottom-sheet--compact")
    .evaluate((panel) => {
      const selectors = [
        ".bottom-sheet-chrome",
        ".bottom-sheet-header",
        ".bottom-sheet-title",
        ".bottom-sheet-header-actions",
        ".bottom-sheet-body",
        ".peek-strip",
      ];
      return {
        viewport: {
          width: innerWidth,
          height: innerHeight,
          scrollX,
          scrollY,
          visualHeight: visualViewport?.height,
          visualOffset: visualViewport?.offsetTop,
        },
        root: {
          rect: panel.parentElement?.getBoundingClientRect().toJSON(),
          bottom: panel.parentElement
            ? getComputedStyle(panel.parentElement).bottom
            : null,
        },
        shell: {
          rect: document
            .querySelector(".daw-shell")
            ?.getBoundingClientRect()
            .toJSON(),
          style: document.documentElement.style.cssText,
        },
        panel: {
          className: panel.className,
          rect: panel.getBoundingClientRect().toJSON(),
        },
        children: selectors.map((selector) => {
          const el = panel.querySelector(selector);
          const style = el ? getComputedStyle(el) : null;
          return {
            selector,
            text: el?.textContent,
            rect: el?.getBoundingClientRect().toJSON(),
            padding: style?.padding,
            gap: style?.gap,
            flex: style?.flex,
          };
        }),
        buttons: [...panel.querySelectorAll("button")].map((el) => ({
          name: el.getAttribute("aria-label"),
          rect: el.getBoundingClientRect().toJSON(),
          padding: getComputedStyle(el).padding,
        })),
      };
    });
  await receipt(info, `census-${name}-${rootPx}-${theme}`, census);
  const screenshot = info.outputPath(`peek-${name}-${rootPx}-${theme}.png`);
  const image = await page.screenshot({ path: screenshot });
  await info.attach("peek", { body: image, contentType: "image/png" });

  for (const detent of ["half", "full", "peek"] as const) {
    if (detent === "half") {
      await page.getByRole("button", { name: "Expand to half height" }).click();
    } else if (detent === "full") {
      await page.getByRole("button", { name: "Expand to full height" }).click();
    } else {
      await page.getByRole("button", { name: "Collapse to strip" }).click();
    }
    await page.waitForTimeout(350);
    await check(detent, headerHistory);
  }

  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  const nudge = page.getByRole("button", {
    name: "Envelope point 0.01 s later",
    exact: true,
  });
  const nudgeBox = await nudge.boundingBox();
  if (!nudgeBox) throw new Error("Nudge has no box");
  await finger.down({
    x: nudgeBox.x + nudgeBox.width / 2,
    y: nudgeBox.y + nudgeBox.height / 2,
  });
  await page.waitForTimeout(60);
  await finger.up();
  await expect.poll(() => savedEnvelope(page)).toEqual(edited);
  await page.waitForTimeout(900);
  await expect(page.locator(".guest-attention")).not.toBeVisible();
  await check("strip-open-after-edit", headerHistory);
  for (const detent of ["half", "full", "peek"] as const) {
    await page
      .getByRole("button", {
        name:
          detent === "half"
            ? "Expand to half height"
            : detent === "full"
              ? "Expand to full height"
              : "Collapse to strip",
      })
      .click();
    await check(`feedback-${detent}`, headerHistory);
  }
  await page
    .locator(".ui-toast-region--app")
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(page.locator(".ui-toast-region--app .ui-toast")).toHaveCount(0);
  await check("feedback-dismissed", headerHistory);
  await receipt(
    info,
    `chrome-undo-${name}-${rootPx}-${theme}-${browserName}`,
    seen,
  );

  for (const [step, row] of Object.entries(seen)) {
    expect({ step, ...row.undo }).toMatchObject({
      step,
      fullyVisible: true,
      hitsControl: true,
    });
    expect({ step, ...row.redo }).toMatchObject({
      step,
      fullyVisible: true,
      hitsControl: true,
    });
    expect(row.undo.rect.width).toBeGreaterThanOrEqual(44);
    expect(row.undo.rect.height).toBeGreaterThanOrEqual(44);
    expect(row.redo.rect.width).toBeGreaterThanOrEqual(44);
    expect(row.redo.rect.height).toBeGreaterThanOrEqual(44);
    for (const control of row.otherControls) {
      expect({ step, ...control }).toMatchObject({
        step,
        fullyVisible: true,
        hitsControl: true,
      });
      expect(control.rect.width).toBeGreaterThanOrEqual(44);
      expect(control.rect.height).toBeGreaterThanOrEqual(44);
    }
    expect(row.overlaps).toBe(false);
    if (
      step === "strip-open-after-edit" ||
      ["feedback-peek", "feedback-half", "feedback-full"].includes(step)
    ) {
      expect(
        row.feedback,
        "Saved feedback must still be visible",
      ).not.toBeNull();
      for (const action of row.feedbackActions) {
        expect(action).toMatchObject({ fullyVisible: true, hitsControl: true });
        expect(action.rect.width).toBeGreaterThanOrEqual(44);
        expect(action.rect.height).toBeGreaterThanOrEqual(44);
      }
      expect(row.feedback).toMatchObject({
        inView: true,
        dismissOnTop: true,
        overlaps: [],
      });
    }
    if (step !== "rail") {
      expect(row.visibleLaneHeight.strip?.bottom).toBeCloseTo(
        row.visibleLaneHeight.bottomChrome?.top ?? -1,
        0,
      );
    }
    if (rootPx === 16 && (step === "peek" || step === "feedback-dismissed")) {
      expect(row.visibleLaneHeight.visible).toBeCloseTo(
        name === "portrait" ? 547 : 191,
        0,
      );
    }
  }

  await expect(page.locator(".bottom-sheet--peek")).toBeVisible();
  const undo = headerHistory.getByRole("button", { name: "Undo" });
  await expect(undo).not.toHaveAttribute("aria-disabled", "true");
  const box = await undo.boundingBox();
  if (!box) throw new Error("Undo has no box");
  commands.length = 0;
  await finger.down({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.waitForTimeout(60);
  await finger.up();
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  const savedUndo = await savedEnvelope(page);
  const undoCommands = commands.map((c) => c.type);
  expect(undoCommands).toEqual(["UndoHistory"]);
  const redo = headerHistory.getByRole("button", { name: "Redo" });
  await expect(redo).not.toHaveAttribute("aria-disabled", "true");
  const redoBox = await redo.boundingBox();
  if (!redoBox) throw new Error("Redo has no box");
  commands.length = 0;
  await finger.down({
    x: redoBox.x + redoBox.width / 2,
    y: redoBox.y + redoBox.height / 2,
  });
  await page.waitForTimeout(60);
  await finger.up();
  await expect.poll(() => savedEnvelope(page)).toEqual(edited);
  expect(commands.map((c) => c.type)).toEqual(["RedoHistory"]);
  await receipt(
    info,
    `saved-history-${name}-${rootPx}-${theme}-${browserName}`,
    {
      original,
      edited,
      savedUndo,
      savedRedo: await savedEnvelope(page),
      undoCommands,
      redoCommands: commands,
    },
  );
  await undo.click();
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  const levelEdited = [
    { id: "env-a", time: 5, value: 1 },
    { id: "env-edge", time: 10, value: 0.8 },
    { id: "env-c", time: 16, value: 1.01 },
    { id: "env-join", time: 40, value: 1.2 },
  ];
  const level = page.getByRole("button", {
    name: "Envelope point level 0.01 higher",
    exact: true,
  });
  await level.click();
  await expect.poll(() => savedEnvelope(page)).toEqual(levelEdited);
  await check("level-saved", headerHistory);
  expect(seen["level-saved"].feedback).toMatchObject({
    inView: true,
    dismissOnTop: true,
    overlaps: [],
  });
  commands.length = 0;
  await undo.click();
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  expect(commands.map((c) => c.type)).toEqual(["UndoHistory"]);
  const levelUndo = await savedEnvelope(page);
  commands.length = 0;
  await redo.click();
  await expect.poll(() => savedEnvelope(page)).toEqual(levelEdited);
  expect(commands.map((c) => c.type)).toEqual(["RedoHistory"]);
  await receipt(
    info,
    `level-history-${name}-${rootPx}-${theme}-${browserName}`,
    {
      original,
      levelEdited,
      savedUndo: levelUndo,
      savedRedo: await savedEnvelope(page),
      redoCommands: commands,
    },
  );
  const liveCard = page.locator(".ui-toast-region--app .ui-toast");
  await expect(liveCard).toBeVisible();
  await liveCard.evaluate((card) =>
    card.setAttribute("data-host-proof", "same-card"),
  );
  await page
    .locator(".bottom-sheet-header")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator(".bottom-sheet--compact")).toHaveCount(0);
  await expect(liveCard).toHaveAttribute("data-host-proof", "same-card");
  await expect(page.locator(".ui-toast-region--app")).not.toHaveClass(
    /inspector-flow/,
  );
  const floatingDismiss = liveCard.getByRole("button", { name: "Dismiss" });
  expect(await controlGeometry(floatingDismiss)).toMatchObject({
    fullyVisible: true,
    hitsControl: true,
  });
  await floatingDismiss.click();
  await expect(liveCard).toHaveCount(0);
  await expect.poll(() => savedEnvelope(page)).toEqual(levelEdited);
  await expect.poll(laneHeights).toEqual(closedLaneHeights);
  await receipt(info, "closed-lane-height-restored", {
    before: closedLaneHeights,
    after: await laneHeights(),
  });
}

for (const name of ["portrait", "landscape"] as const) {
  for (const rootPx of [16, 32]) {
    for (const theme of ["dark", "light"] as const) {
      test.describe(`compact history ${name} root${rootPx} ${theme}`, () => {
        test("Undo and Redo stay on top, and a tap on Undo undoes the edit, with the strip open", ({
          page,
          context,
          browserName,
        }, info) =>
          undoStaysReachable(
            name,
            rootPx,
            theme,
            { page, context, browserName },
            info,
          ));
      });
    }
  }
}

for (const name of ["portrait", "landscape"] as const) {
  for (const rootPx of [16, 32]) {
    test.describe(`unavailable compact history ${name} root${rootPx}`, () => {
      test("unavailable compact history keeps geometry", async ({
        page,
        context,
        browserName,
      }, info) => {
        await openAt(page, SIZES[name]);
        const finger = await newFinger(context, page, browserName);
        const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
        await finger.down(at);
        await page.waitForTimeout(60);
        await finger.up();
        await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
        await page.evaluate((px) => {
          document.documentElement.style.fontSize = `${px}px`;
        }, rootPx);
        await page.waitForTimeout(600);
        const history = compactHistory(page);
        const commands = watchCommands(page);
        const geometry = () =>
          page.locator(".bottom-sheet--compact").evaluate((panel) => ({
            panel: panel.getBoundingClientRect().toJSON(),
            header: panel
              .querySelector(".bottom-sheet-header")
              ?.getBoundingClientRect()
              .toJSON(),
            body: panel
              .querySelector(".bottom-sheet-body")
              ?.getBoundingClientRect()
              .toJSON(),
            controls: [
              ...panel.querySelectorAll(".bottom-sheet-header button"),
            ].map((button) => button.getBoundingClientRect().toJSON()),
          }));
        for (const detent of ["peek", "half", "full"] as const) {
          if (detent !== "peek") {
            await page
              .getByRole("button", {
                name:
                  detent === "half"
                    ? "Expand to half height"
                    : "Expand to full height",
              })
              .click();
            await page.waitForTimeout(350);
          }
          const before = await geometry();
          const redo = history.getByRole("button", {
            name: "Redo",
            exact: true,
          });
          await expect(redo).toHaveAttribute("aria-disabled", "true");
          const box = await redo.boundingBox();
          if (!box) throw new Error("Redo has no box");
          await finger.down({
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          });
          await page.waitForTimeout(60);
          await finger.up();
          const hint = history.getByRole("status");
          await expect(hint).toHaveText("Nothing to redo");
          await expect(hint).toBeInViewport({ ratio: 1 });
          const after = await geometry();
          expect(after).toEqual(before);
          expect(commands).toEqual([]);
          await receipt(
            info,
            `unavailable-${name}-${rootPx}-${detent}-${browserName}`,
            { before, after },
          );
        }
      });
    });
  }
}
