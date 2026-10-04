import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { InteractionReceipt } from "./interactionEvidence";

/** Measure the whole control and its native label against every clipping ancestor. */
export async function controlGeometry(control: Locator, identity = false) {
  return control.evaluate((element, useIdentity) => {
    const describe = (node: Element) => ({
      tag: node.tagName,
      class: node.getAttribute("class"),
      label: node.getAttribute("aria-label"),
      text: node.textContent?.trim().slice(0, 160),
    });
    const label =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement
        ? element.labels?.[0]
        : null;
    const row = element.closest(".track-header-row");
    const chip = row?.querySelector(".track-chip");
    const title = row?.querySelector(".track-title");
    const visible = (node: Element | null | undefined) => {
      if (!node) return false;
      const box = node.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        getComputedStyle(node).visibility === "visible"
      );
    };
    const subject = useIdentity
      ? visible(chip)
        ? chip!
        : visible(title)
          ? title!
          : element
      : element;
    const rect = element.getBoundingClientRect();
    const labels = label ? [label] : [];
    const measured = [
      element,
      ...(useIdentity && subject !== element ? [subject] : []),
      ...labels,
    ].map((node) => {
      const box = node.getBoundingClientRect();
      let left = 0,
        top = 0,
        right = innerWidth,
        bottom = innerHeight;
      const ancestors = [];
      for (
        let ancestor = node.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        const clipsX = /hidden|clip|auto|scroll/.test(style.overflowX);
        const clipsY = /hidden|clip|auto|scroll/.test(style.overflowY);
        if (!clipsX && !clipsY) continue;
        const area = ancestor.getBoundingClientRect();
        const clipLeft = area.left + ancestor.clientLeft;
        const clipTop = area.top + ancestor.clientTop;
        const clipRight = clipLeft + ancestor.clientWidth;
        const clipBottom = clipTop + ancestor.clientHeight;
        ancestors.push({
          ...describe(ancestor),
          rect: area.toJSON(),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          scrollTop: ancestor.scrollTop,
          clientHeight: ancestor.clientHeight,
          scrollHeight: ancestor.scrollHeight,
        });
        if (clipsX) {
          left = Math.max(left, clipLeft);
          right = Math.min(right, clipRight);
        }
        if (clipsY) {
          top = Math.max(top, clipTop);
          bottom = Math.min(bottom, clipBottom);
        }
      }
      return {
        ...describe(node),
        rect: box.toJSON(),
        ancestors,
        clip: { left, top, right, bottom },
        full:
          box.width > 0 &&
          box.height > 0 &&
          box.left >= left - 1 &&
          box.right <= right + 1 &&
          box.top >= top - 1 &&
          box.bottom <= bottom + 1,
      };
    });
    const hitRect = subject.getBoundingClientRect();
    const point = {
      x: hitRect.left + hitRect.width / 2,
      y: hitRect.top + hitRect.height / 2,
    };
    const hit = document.elementFromPoint(point.x, point.y);
    const identityInsideControl =
      !useIdentity ||
      (subject !== element &&
        hitRect.left >= rect.left - 1 &&
        hitRect.top >= rect.top - 1 &&
        hitRect.right <= rect.right + 1 &&
        hitRect.bottom <= rect.bottom + 1);
    return {
      rect: rect.toJSON(),
      point,
      measured,
      identityInsideControl,
      fullyVisible:
        measured.every((item) => item.full) && identityInsideControl,
      hitsControl: hit === element || (!!hit && element.contains(hit)),
      hit: hit ? describe(hit) : null,
      focused: document.activeElement === element,
    };
  }, identity);
}

export async function captureInspector(
  page: Page,
  info: TestInfo,
  receipts: InteractionReceipt[],
  stage: string,
) {
  receipts.push({
    checkpoint: stage,
    observation: await page.evaluate(() => ({
      rootFont: getComputedStyle(document.documentElement).fontSize,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      active: document.activeElement?.outerHTML.slice(0, 400),
    })),
  });
  await info.attach(stage, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
}

/** Native wheel at the ordinary body center, including when a numeric input occupies it. */
export async function wheelInspector(
  page: Page,
  receipts: InteractionReceipt[],
  delta: number,
) {
  const sheetBody = page.locator(".bottom-sheet-body");
  const body = (await sheetBody.count())
    ? sheetBody
    : page.locator(".inspector .modifier-body");
  const box = await body.boundingBox();
  if (!box) throw new Error("Inspector has no ordinary scroll body");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("No viewport");
  const top = Math.max(0, box.y),
    bottom = Math.min(viewport.height, box.y + box.height);
  const point = { x: box.x + box.width / 2, y: top + (bottom - top) / 2 };
  receipts.push({
    checkpoint: "ordinary-body-wheel",
    observation: { point, delta, body: box },
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(100);
}

/** Expose a full label/control using only native wheel or the public Expand action. */
export async function exposeControl(
  page: Page,
  control: Locator,
  receipts: InteractionReceipt[],
) {
  await expect(control).toBeAttached();
  for (let step = 0; step < 28; step++) {
    const geometry = await controlGeometry(control);
    if (geometry.fullyVisible && geometry.hitsControl) return geometry;
    const expand = page.getByRole("button", { name: "Expand", exact: true });
    if (step === 0 && (await expand.count())) {
      const admission = await controlGeometry(expand);
      receipts.push({
        checkpoint: "public-expand-admission",
        observation: admission,
      });
      expect(admission.fullyVisible).toBe(true);
      expect(admission.hitsControl).toBe(true);
      await page.screenshot();
      await page.mouse.click(admission.point.x, admission.point.y);
      await page.waitForTimeout(100);
      continue;
    }
    const first =
      geometry.measured.find((item) => !item.full) ?? geometry.measured[0];
    const direction = first.rect.top < first.clip.top ? -1 : 1;
    await wheelInspector(page, receipts, direction * 100);
  }
  const geometry = await controlGeometry(control);
  receipts.push({
    checkpoint: "full-control-exposure-failed",
    observation: geometry,
  });
  expect(geometry.fullyVisible, JSON.stringify(geometry)).toBe(true);
  expect(geometry.hitsControl, JSON.stringify(geometry)).toBe(true);
  return geometry;
}

export async function pointerControl(
  page: Page,
  control: Locator,
  receipts: InteractionReceipt[],
  identity = false,
) {
  const geometry = identity
    ? await controlGeometry(control, true)
    : await exposeControl(page, control, receipts);
  receipts.push({
    checkpoint: identity
      ? "track-identity-pointer-admission"
      : "full-control-pointer-admission",
    observation: geometry,
  });
  expect(geometry.fullyVisible, JSON.stringify(geometry)).toBe(true);
  expect(geometry.hitsControl, JSON.stringify(geometry)).toBe(true);
  await page.screenshot();
  await page.mouse.click(geometry.point.x, geometry.point.y);
}

export async function typeControl(
  page: Page,
  control: Locator,
  value: string,
  receipts: InteractionReceipt[],
) {
  await pointerControl(page, control, receipts);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(value);
  await expect(control).toHaveValue(value);
}

export async function visibleFocus(
  control: Locator,
  receipts: InteractionReceipt[],
  stage: string,
) {
  await expect(control).toBeFocused();
  await expect
    .poll(async () => (await controlGeometry(control)).fullyVisible)
    .toBe(true);
  receipts.push({
    checkpoint: stage,
    observation: await controlGeometry(control),
  });
}

/** Independent keyboard route: native Tab traversal, without programmatic focus. */
export async function nativeTabTo(
  page: Page,
  target: Locator,
  receipts: InteractionReceipt[],
) {
  for (let step = 0; step < 150; step++) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await visibleFocus(target, receipts, "native-tab-visible-target");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Native Tab traversal did not reach target");
}
