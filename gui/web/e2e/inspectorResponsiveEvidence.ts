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
      text: node.textContent?.trim().slice(0, 160) ?? null,
    });
    const label =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement
        ? element.labels?.[0]
        : null;
    const row = element.closest(".track-header-row");
    const chip = row?.querySelector(".track-chip");
    const title = row?.querySelector(".track-title");
    const measure = (node: Element, paintExtent = 0) => {
      const box = node.getBoundingClientRect();
      let left = 0,
        top = 0,
        right = innerWidth,
        bottom = innerHeight;
      const ancestors = [];
      let reason:
        | "detached"
        | "inert"
        | "hidden"
        | "display-none"
        | "visibility-hidden"
        | "no-box"
        | undefined;
      if (!node.isConnected) reason = "detached";
      else if (node.closest("[inert]")) reason = "inert";
      else if (node.closest("[hidden]")) reason = "hidden";
      else if (!box.width || !box.height) reason = "no-box";
      for (
        let ancestor: Element | null = node;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none") reason ??= "display-none";
        if (style.visibility !== "visible") reason ??= "visibility-hidden";
        if (ancestor === node) continue;
        const clipsX = /hidden|clip|auto|scroll/.test(style.overflowX);
        const clipsY = /hidden|clip|auto|scroll/.test(style.overflowY);
        if (!clipsX && !clipsY) continue;
        const area = ancestor.getBoundingClientRect();
        const clipLeft = area.left + ancestor.clientLeft;
        const clipTop = area.top + ancestor.clientTop;
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
          right = Math.min(right, clipLeft + ancestor.clientWidth);
        }
        if (clipsY) {
          top = Math.max(top, clipTop);
          bottom = Math.min(bottom, clipTop + ancestor.clientHeight);
        }
      }
      const admission = reason
        ? { state: "excluded" as const, reason }
        : { state: "admitted" as const };
      const bounds = {
        left: box.left - paintExtent,
        right: box.right + paintExtent,
        top: box.top - paintExtent,
        bottom: box.bottom + paintExtent,
      };
      const intersection = {
        left: Math.max(left, bounds.left),
        right: Math.min(right, bounds.right),
        top: Math.max(top, bounds.top),
        bottom: Math.min(bottom, bounds.bottom),
      };
      const visibleArea =
        !reason &&
        intersection.right > intersection.left &&
        intersection.bottom > intersection.top
          ? { state: "positive" as const, bounds: intersection }
          : { state: "empty" as const };
      return {
        ...describe(node),
        rect: box.toJSON(),
        ancestors,
        clip: { left, top, right, bottom },
        admission,
        visibleArea,
        full:
          !reason &&
          bounds.left >= left - 1 &&
          bounds.right <= right + 1 &&
          bounds.top >= top - 1 &&
          bounds.bottom <= bottom + 1,
      };
    };
    const admitted = (node: Element | null | undefined) =>
      !!node && measure(node).admission.state === "admitted";
    const subject = useIdentity
      ? admitted(chip)
        ? chip!
        : admitted(title)
          ? title!
          : element
      : element;
    const rect = element.getBoundingClientRect();
    const measured = [
      element,
      ...(useIdentity && subject !== element ? [subject] : []),
      ...(label ? [label] : []),
    ].map((node) => measure(node));
    const focused = document.activeElement === element;
    const focusIndicator = (() => {
      if (!focused) return { state: "not-focused" as const };
      if (!element.matches(":focus-visible"))
        return { state: "not-focus-visible" as const };
      const surrogate =
        element.matches(".bottom-sheet-detent") &&
        label?.matches(".bottom-sheet-grabber")
          ? label
          : null;
      const node = surrogate ?? element;
      const style = getComputedStyle(node);
      const outline = {
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
        offset: Number.parseFloat(style.outlineOffset),
        color: style.outlineColor,
      };
      if (outline.style === "none" || outline.width <= 0)
        return { state: "no-outline" as const, outline };
      const extent = Math.max(0, outline.width + outline.offset);
      const paint = measure(node, extent);
      return {
        state: "outline" as const,
        subject: surrogate ? ("detent-grabber" as const) : ("control" as const),
        node: describe(node),
        outline,
        bounds: {
          left: paint.rect.left - extent,
          right: paint.rect.right + extent,
          top: paint.rect.top - extent,
          bottom: paint.rect.bottom + extent,
        },
        admission: paint.admission,
        visibleArea: paint.visibleArea,
        full: paint.full,
      };
    })();
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
      hitStack: document.elementsFromPoint(point.x, point.y).map(describe),
      focused,
      focusIndicator,
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
  const geometry = await controlGeometry(body);
  const area = geometry.measured[0].visibleArea;
  const visibleBody = area.state === "positive";
  const fallback = visibleBody
    ? null
    : await controlGeometry(
        page.locator(".bottom-sheet, .inspector").filter({ has: body }),
      );
  const bounds = visibleBody ? area.bounds : fallback?.measured[0].visibleArea;
  const visibleRect =
    bounds && "state" in bounds
      ? bounds.state === "positive"
        ? bounds.bounds
        : null
      : bounds;
  const anchor = {
    point: visibleRect
      ? {
          x: (visibleRect.left + visibleRect.right) / 2,
          y: (visibleRect.top + visibleRect.bottom) / 2,
        }
      : geometry.point,
    body: geometry.rect,
    visibleBody,
    usable: !!visibleRect,
    visibleRect,
    hit: geometry.hit,
  };
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
    const cannotFit = geometry.measured.some(
      (item) => item.rect.height > item.clip.bottom - item.clip.top + 1,
    );
    const expand = page.getByRole("button", {
      name: cannotFit ? /^Expand(?: to (?:half|full) height)?$/ : "Expand",
      exact: true,
    });
    if ((step === 0 || cannotFit) && (await expand.count())) {
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
      .poll(async () => {
        const geometry = await controlGeometry(control);
        return geometry.focusIndicator.state === "outline" &&
          geometry.focusIndicator.subject === "detent-grabber"
          ? geometry.focusIndicator.full
          : geometry.fullyVisible;
      })
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
      const geometry = await controlGeometry(target);
      expect(geometry.focusIndicator, JSON.stringify(geometry)).toMatchObject({
        state: "outline",
        full: true,
      });
      return;
    }
    await page.keyboard.press(tabKey);
    const focusedField = page.locator(
      ".bottom-sheet--compact :is(button, input, select, textarea):focus",
    );
    if (await focusedField.count()) {
      await visibleFocus(
        focusedField,
        receipts,
        "native-tab-intermediate-field",
      );
      const geometry = await controlGeometry(focusedField);
      expect(geometry.focusIndicator, JSON.stringify(geometry)).toMatchObject({
        state: "outline",
        full: true,
      });
    }
  }
  throw new Error("Native Tab traversal did not reach target");
}
