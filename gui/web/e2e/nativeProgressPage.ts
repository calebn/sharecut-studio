import type {
  DomRecord,
  GeometryRecord,
  NATIVE_PROGRESS_LIMITS,
} from "./nativeProgressCore";

export type NativePageEvidence = {
  dom: DomRecord[];
  geometry: GeometryRecord[];
  issues: string[];
  discarded: number;
  callbackCount: number;
  geometryReadCount: number;
  styleReadCount: number;
  documentEpoch: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  unsampledOnFinish: boolean;
};
export type NativePageObserver = { finish(): NativePageEvidence };
declare global {
  interface Window {
    __nativeProgressObserver?: NativePageObserver;
  }
}
export function installNativeProgressPage(
  limits: typeof NATIVE_PROGRESS_LIMITS,
) {
  if (window.__nativeProgressObserver)
    throw new Error("native progress observer already armed");
  const root = document.querySelector(".pipeline-panel");
  if (!root) throw new Error("Pipeline panel not mounted");
  const evidence: NativePageEvidence = {
    dom: [],
    geometry: [],
    issues: [],
    discarded: 0,
    callbackCount: 0,
    geometryReadCount: 0,
    styleReadCount: 0,
    documentEpoch: crypto.randomUUID(),
    startedAtMs: performance.now(),
    finishedAtMs: null,
    unsampledOnFinish: false,
  };
  let active = true;
  let batch = 0;
  let frame = 0;
  let pendingTrigger = "state-change";
  let sequence = 0;
  let pulse: boolean | null = null;
  const tokens = new WeakMap<Element, number>();
  const bars = new Set<number>();
  const note = (reason: string) => {
    if (evidence.issues.length < limits.issues) evidence.issues.push(reason);
    else evidence.discarded++;
  };
  const token = (element: Element) => {
    const old = tokens.get(element);
    if (old !== undefined) return old;
    if (sequence >= limits.nodes) {
      note("element identity map capped");
      return 0;
    }
    const id = ++sequence;
    tokens.set(element, id);
    return id;
  };
  const append = (record: DomRecord) => {
    if (evidence.dom.length < limits.dom) evidence.dom.push(record);
    else evidence.discarded++;
  };
  const record = (
    element: Element,
    kind: DomRecord["kind"],
    attribute: string | null = null,
    oldValue: string | null = null,
  ) => {
    const value = attribute ? element.getAttribute(attribute) : null;
    if ((value?.length ?? 0) > 512 || (oldValue?.length ?? 0) > 512) {
      note("DOM attribute oversized");
      return;
    }
    append({
      batch,
      node: token(element),
      atMs: performance.now(),
      kind,
      attribute,
      oldValue,
      valueAtDelivery: value,
      reconstructedValue: null,
    });
  };
  const geometry = () => {
    frame = 0;
    if (!active) return;
    evidence.callbackCount++;
    if (!root.isConnected) {
      note("Pipeline root detached; document identity ambiguous");
      return;
    }
    const elements = root.querySelectorAll('.pipeline-bar[role="progressbar"]');
    if (elements.length > 1)
      note("multiple progress bars invalidate exclusive binding");
    const bar = elements[0];
    if (!bar) return;
    if (evidence.geometry.length >= limits.geometry) {
      evidence.discarded++;
      return;
    }
    const raw = bar.getAttribute("aria-valuenow");
    const value = raw === null ? NaN : Number(raw);
    const rect = bar.getBoundingClientRect();
    const fill = bar
      .querySelector(".pipeline-bar-fill")
      ?.getBoundingClientRect();
    evidence.geometryReadCount += fill ? 2 : 1;
    const excluded: string[] = [];
    const unknown: string[] = [];
    let ancestorsChecked = 0;
    let styleReadCount = 0;
    const clippingAncestors: GeometryRecord["clippingAncestors"] = [];
    let visibleLeft = Math.max(0, rect.left);
    let visibleRight = Math.min(innerWidth, rect.right);
    let visibleTop = Math.max(0, rect.top);
    let visibleBottom = Math.min(innerHeight, rect.bottom);
    if (rect.height < 4 || rect.width <= 0)
      excluded.push("height-or-width-below-contract");
    if (
      rect.top < 0 ||
      rect.bottom > innerHeight ||
      rect.left < 0 ||
      rect.right > innerWidth
    )
      excluded.push("offscreen");
    if (!fill) excluded.push("no-fill");
    if (document.visibilityState !== "visible")
      excluded.push("document-hidden");
    if (!Number.isFinite(value)) excluded.push("invalid-percent");
    const inspectStyle = (element: Element) => {
      const style = getComputedStyle(element);
      styleReadCount++;
      evidence.styleReadCount++;
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden" ||
        (style.opacity !== "" && Number(style.opacity) === 0)
      )
        excluded.push("CSS-hidden");
      if (
        (style.clipPath && style.clipPath !== "none") ||
        (style.maskImage && style.maskImage !== "none") ||
        (style.clip && style.clip !== "auto")
      )
        unknown.push("nonrectangular-clip-or-mask");
      if (
        (style.transform && style.transform !== "none") ||
        (style.perspective && style.perspective !== "none")
      )
        unknown.push("transformed-clip-coordinate-space");
      return style;
    };
    inspectStyle(bar);
    const fillElement = bar.querySelector(".pipeline-bar-fill");
    if (fillElement) inspectStyle(fillElement);
    let ancestor: Element | null = bar.parentElement;
    while (ancestor && ancestorsChecked < limits.ancestors) {
      ancestorsChecked++;
      const style = inspectStyle(ancestor);
      const paintContained = /(?:^|\s)(paint|strict|content)(?:\s|$)/.test(
        style.contain,
      );
      const clipX =
        paintContained ||
        ["auto", "scroll", "hidden", "clip"].includes(
          style.overflowX || style.overflow,
        );
      const clipY =
        paintContained ||
        ["auto", "scroll", "hidden", "clip"].includes(
          style.overflowY || style.overflow,
        );
      if (clipX || clipY) {
        const bounds = ancestor.getBoundingClientRect();
        evidence.geometryReadCount += 3 + Number(clipX) + Number(clipY);
        const clipLeft = bounds.left + ancestor.clientLeft;
        const clipTop = bounds.top + ancestor.clientTop;
        const clipRight = clipX
          ? clipLeft + ancestor.clientWidth
          : bounds.right;
        const clipBottom = clipY
          ? clipTop + ancestor.clientHeight
          : bounds.bottom;
        clippingAncestors.push({
          depth: ancestorsChecked,
          left: clipLeft,
          top: clipTop,
          right: clipRight,
          bottom: clipBottom,
          clipX,
          clipY,
        });
        if (clipX) {
          visibleLeft = Math.max(visibleLeft, clipLeft);
          visibleRight = Math.min(visibleRight, clipRight);
        }
        if (clipY) {
          visibleTop = Math.max(visibleTop, clipTop);
          visibleBottom = Math.min(visibleBottom, clipBottom);
        }
        if (
          (style.overflowClipMargin &&
            !/^0(?:px)?$/.test(style.overflowClipMargin)) ||
          [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomLeftRadius,
            style.borderBottomRightRadius,
          ].some((radius) => radius && !/^0(?:px)?$/.test(radius))
        )
          unknown.push("nonrectangular-or-expanded-ancestor-clip");
      }
      ancestor = ancestor.parentElement;
    }
    if (ancestor) unknown.push("ancestor-chain-capped");
    if (
      ![
        rect.left,
        rect.right,
        rect.top,
        rect.bottom,
        visibleLeft,
        visibleRight,
        visibleTop,
        visibleBottom,
      ].every(Number.isFinite)
    )
      unknown.push("invalid-rectangle");
    if (
      visibleLeft > rect.left ||
      visibleRight < rect.right ||
      visibleTop > rect.top ||
      visibleBottom < rect.bottom
    )
      excluded.push("rectangularly-clipped");
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop)
      excluded.push("no-rectangle-intersection");
    excluded.push(...new Set(unknown));
    evidence.geometry.push({
      node: token(bar),
      atMs: performance.now(),
      trigger: pendingTrigger,
      percent: Number.isFinite(value) ? value : null,
      width: rect.width,
      fillWidth: fill?.width ?? null,
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      visibleIntersection: {
        left: visibleLeft,
        right: visibleRight,
        top: visibleTop,
        bottom: visibleBottom,
      },
      qualification: unknown.length
        ? "unknown"
        : excluded.length
          ? "excluded"
          : "qualifying-rectangular-layout",
      ancestorsChecked,
      clippingAncestors,
      styleReadCount,
      excluded: [...new Set(excluded)],
    });
  };
  const safeGeometry = () => {
    try {
      geometry();
    } catch (error) {
      note(`geometry observer failure: ${String(error).slice(0, 256)}`);
    }
  };
  const schedule = (trigger: string) => {
    if (!active) return;
    pendingTrigger = trigger;
    if (!frame) frame = requestAnimationFrame(safeGeometry);
  };
  const capturePresence = () => {
    const current = !!root.querySelector('[data-testid="pipeline-pulse"]');
    if (current !== pulse) {
      pulse = current;
      append({
        batch,
        node: token(root),
        atMs: performance.now(),
        kind: "indeterminate",
        attribute: null,
        oldValue: null,
        valueAtDelivery: String(current),
        reconstructedValue: null,
      });
    }
  };
  const addedOrRemoved = (node: Node, kind: "added" | "removed") => {
    if (!(node instanceof Element)) return;
    const matches = node.matches('.pipeline-bar[role="progressbar"]')
      ? [node]
      : Array.from(node.querySelectorAll('.pipeline-bar[role="progressbar"]'));
    for (const bar of matches) {
      if (kind === "added") {
        tokens.delete(bar);
        for (const fill of bar.querySelectorAll(".pipeline-bar-fill"))
          tokens.delete(fill);
      }
      const id = token(bar);
      if (kind === "added") {
        bars.add(id);
        if (bars.size > 1)
          note(
            "bar generation changed; cross-generation attribution ambiguous",
          );
      }
      record(bar, kind, "aria-valuenow");
      schedule("state-change");
    }
    if (
      node.matches(".pipeline-headline") ||
      node.querySelector(".pipeline-headline")
    )
      record(node, "headline");
  };
  const process = (records: MutationRecord[]) => {
    if (!active) return;
    evidence.callbackCount++;
    batch++;
    for (const mutation of records) {
      if (
        mutation.type === "attributes" &&
        mutation.target instanceof Element
      ) {
        const element = mutation.target;
        if (
          element.matches(
            '.pipeline-bar[role="progressbar"], .pipeline-bar-fill',
          )
        ) {
          record(
            element,
            "attribute",
            mutation.attributeName,
            mutation.oldValue,
          );
          schedule("state-change");
        }
      } else if (
        mutation.type === "characterData" &&
        mutation.target.parentElement?.closest(".pipeline-headline")
      ) {
        record(mutation.target.parentElement, "headline");
      } else if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) addedOrRemoved(node, "added");
        for (const node of mutation.removedNodes)
          addedOrRemoved(node, "removed");
        if (
          mutation.target instanceof Element &&
          mutation.target.closest(".pipeline-headline")
        )
          record(mutation.target, "headline");
      }
    }
    capturePresence();
  };
  const safeProcess = (records: MutationRecord[]) => {
    try {
      process(records);
    } catch (error) {
      note(`DOM observer failure: ${String(error).slice(0, 256)}`);
    }
  };
  const observer = new MutationObserver(safeProcess);
  const parentObserver = new MutationObserver(() => {
    if (active && !root.isConnected)
      note("Pipeline root detached; identity unavailable");
  });
  const onScroll = () => schedule("scroll");
  const onResize = () => schedule("resize");
  const onTransition = (event: Event) => {
    if (
      event.target instanceof Element &&
      event.target.matches(".pipeline-bar-fill")
    )
      schedule(event.type);
  };
  capturePresence();
  if (root.querySelector('.pipeline-bar[role="progressbar"]'))
    note("preexisting determinate bar invalidates exclusive binding");
  window.__nativeProgressObserver = {
    finish() {
      if (!active) return evidence;
      const detach = (action: () => void) => {
        try {
          action();
        } catch (error) {
          note(`page cleanup failure: ${String(error).slice(0, 256)}`);
        }
      };
      detach(() => safeProcess(observer.takeRecords()));
      evidence.unsampledOnFinish = frame !== 0;
      active = false;
      evidence.finishedAtMs = performance.now();
      for (const action of [
        () => observer.disconnect(),
        () => parentObserver.disconnect(),
        () => cancelAnimationFrame(frame),
        () => document.removeEventListener("scroll", onScroll, true),
        () => window.removeEventListener("resize", onResize),
        () => root.removeEventListener("transitionend", onTransition),
        () => root.removeEventListener("transitioncancel", onTransition),
      ])
        detach(action);
      if (!root.isConnected) note("Pipeline root detached before finish");
      return evidence;
    },
  };
  try {
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["aria-valuenow", "aria-label", "style"],
    });
    if (root.parentElement)
      parentObserver.observe(root.parentElement, { childList: true });
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    root.addEventListener("transitionend", onTransition);
    root.addEventListener("transitioncancel", onTransition);
  } catch (error) {
    window.__nativeProgressObserver.finish();
    throw error;
  }
}
