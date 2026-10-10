import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { InteractionReceipt } from "./interactionEvidence";

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

export async function wheelInspector(
  page: Page,
  receipts: InteractionReceipt[],
  delta: number,
) {
  const sheetBody = page.locator(".bottom-sheet-body");
  const body = (await sheetBody.count())
    ? sheetBody
    : page.locator(".inspector .modifier-body");
  const anchor = await body.evaluate((element) => {
    const box = element.getBoundingClientRect();
    let left = Math.max(0, box.left),
      right = Math.min(innerWidth, box.right);
    let top = Math.max(0, box.top),
      bottom = Math.min(innerHeight, box.bottom);
    for (
      let ancestor = element.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor),
        rect = ancestor.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        left = Math.max(left, rect.left + ancestor.clientLeft);
        right = Math.min(
          right,
          rect.left + ancestor.clientLeft + ancestor.clientWidth,
        );
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        top = Math.max(top, rect.top + ancestor.clientTop);
        bottom = Math.min(
          bottom,
          rect.top + ancestor.clientTop + ancestor.clientHeight,
        );
      }
    }
    const panel =
      element.closest(".bottom-sheet") ?? element.closest(".inspector");
    const fallback = panel?.getBoundingClientRect();
    const visibleBody = right > left && bottom > top;
    if (!visibleBody && fallback) {
      left = Math.max(0, fallback.left);
      right = Math.min(innerWidth, fallback.right);
      top = Math.max(0, fallback.top);
      bottom = Math.min(innerHeight, fallback.bottom);
    }
    const point = { x: left + (right - left) / 2, y: top + (bottom - top) / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      point,
      body: box.toJSON(),
      visibleBody,
      usable: right > left && bottom > top,
      visibleRect: { left, top, right, bottom },
      hit: hit?.outerHTML.slice(0, 250),
    };
  });
  receipts.push({
    checkpoint: "ordinary-body-wheel",
    observation: { ...anchor, delta },
  });
  expect(anchor.usable, JSON.stringify(anchor)).toBe(true);
  const { point } = anchor;
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(100);
}

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
      if (admission.fullyVisible && admission.hitsControl) {
        await page.screenshot();
        await page.mouse.click(admission.point.x, admission.point.y);
        await page.waitForTimeout(100);
        continue;
      }
    }
    const first =
      geometry.measured.find((item) => !item.full) ?? geometry.measured[0];
    // In view but covered: a pinned sheet header covers the top of the
    // scroll, so scroll the content down to it; anything else covers it
    // from below.
    const covered = geometry.fullyVisible && !geometry.hitsControl;
    const direction = covered
      ? geometry.point.y < (page.viewportSize()?.height ?? 0) / 2
        ? -1
        : 1
      : first.rect.top < first.clip.top
        ? -1
        : 1;
    const distance = covered
      ? direction * 100
      : first.rect.top < first.clip.top
        ? first.rect.top - first.clip.top
        : first.rect.bottom - first.clip.bottom;
    await wheelInspector(
      page,
      receipts,
      Math.max(-100, Math.min(100, distance)),
    );
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
  let geometry = identity
    ? await controlGeometry(control, true)
    : await exposeControl(page, control, receipts);
  if (identity && !geometry.fullyVisible) {
    receipts.push({
      checkpoint: "track-identity-before-ordinary-scroll",
      observation: geometry,
    });
    for (let step = 0; step < 20 && !geometry.fullyVisible; step++) {
      const timeline = await controlGeometry(page.locator(".timeline-scroll"));
      const area = timeline.measured[0];
      const left = Math.max(area.rect.left, area.clip.left),
        right = Math.min(area.rect.right, area.clip.right);
      const top = Math.max(area.rect.top, area.clip.top),
        bottom = Math.min(area.rect.bottom, area.clip.bottom);
      expect(right > left && bottom > top, JSON.stringify(timeline)).toBe(true);
      const point = {
        x: left + (right - left) / 2,
        y: top + (bottom - top) / 2,
      };
      const clipped =
        geometry.measured.find((item) => !item.full) ?? geometry.measured[0];
      const delta = clipped.rect.top < clipped.clip.top ? -80 : 80;
      receipts.push({
        checkpoint: "ordinary-timeline-wheel-before-identity",
        observation: { point, delta, timeline },
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(100);
      geometry = await controlGeometry(control, true);
    }
  }
  for (let step = 0; step < 12; step++) {
    const prior = geometry;
    await page.waitForTimeout(80);
    geometry = await controlGeometry(control, identity);
    if (
      Math.abs(geometry.rect.x - prior.rect.x) < 0.25 &&
      Math.abs(geometry.rect.y - prior.rect.y) < 0.25
    )
      break;
  }
  await page.screenshot();
  geometry = await controlGeometry(control, identity);
  receipts.push({
    checkpoint: identity
      ? "track-identity-pointer-admission"
      : "full-control-pointer-admission",
    observation: geometry,
  });
  expect(geometry.fullyVisible, JSON.stringify(geometry)).toBe(true);
  expect(geometry.hitsControl, JSON.stringify(geometry)).toBe(true);
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
  receipts.push({
    checkpoint: `${stage}-before`,
    observation: await controlGeometry(control),
  });
  try {
    await expect(control).toBeFocused();
    await expect
      .poll(async () => (await controlGeometry(control)).fullyVisible)
      .toBe(true);
  } finally {
    receipts.push({
      checkpoint: stage,
      observation: await controlGeometry(control),
    });
  }
}

export async function nativeTabTo(
  page: Page,
  target: Locator,
  receipts: InteractionReceipt[],
  tabKey: "Tab" | "Alt+Tab" = "Tab",
) {
  for (let step = 0; step < 150; step++) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await visibleFocus(target, receipts, "native-tab-visible-target");
      return;
    }
    await page.keyboard.press(tabKey);
    const focusedField = page.locator(
      ".bottom-sheet--compact :is(input, select, textarea):focus:not(.sr-only)",
    );
    if (await focusedField.count())
      await visibleFocus(
        focusedField,
        receipts,
        "native-tab-intermediate-field",
      );
  }
  throw new Error("Native Tab traversal did not reach target");
}
