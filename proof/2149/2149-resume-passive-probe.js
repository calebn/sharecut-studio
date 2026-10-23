(() => {
  const key = "__sharecut2149Probe";
  if (window[key]) throw new Error("2149 probe already installed; export and remove it first");
  const rows = [];
  const ids = new WeakMap();
  const eventIds = new WeakMap();
  const listeners = [];
  let nextId = 1;
  let nextEventId = 1;
  let stopped = false;
  let stopReason = null;
  let dropped = 0;
  const id = (node) => {
    if (!node || (typeof node !== "object" && typeof node !== "function")) return null;
    if (!ids.has(node)) ids.set(node, nextId++);
    return ids.get(node);
  };
  const rect = (node) => {
    if (!(node instanceof Element)) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const describe = (node) => {
    if (!(node instanceof Element)) return { id: id(node), kind: node === window ? "window" : node?.nodeName };
    const css = getComputedStyle(node);
    return {
      id: id(node), tag: node.localName, domId: node.id, classes: node.getAttribute("class"),
      label: node.getAttribute("aria-label"), pressed: node.getAttribute("aria-pressed"),
      presenceAnchor: node.getAttribute("data-presence-anchor"),
      connected: node.isConnected, rect: rect(node), touchAction: css.touchAction,
      pointerEvents: css.pointerEvents, transform: css.transform,
      overflowX: css.overflowX, overflowY: css.overflowY,
    };
  };
  const snapshot = () => {
    const nav = document.querySelector(".mobile-nav");
    const timeline = document.querySelector(".timeline-scroll");
    const v = window.visualViewport;
    return {
      at: performance.now(), nav: describe(nav),
      buttons: nav ? [...nav.querySelectorAll("button")].map((b) => ({ ...describe(b), text: b.textContent?.trim() })) : [],
      activeElement: describe(document.activeElement), shell: describe(document.querySelector(".daw-shell")),
      shellClassification: { htmlDataShell: document.documentElement.getAttribute("data-shell"),
        coarsePointer: matchMedia("(pointer: coarse)").matches,
        narrowViewport: matchMedia("(max-width: 767px)").matches },
      viewport: v ? { scale: v.scale, width: v.width, height: v.height, offsetLeft: v.offsetLeft,
        offsetTop: v.offsetTop, pageLeft: v.pageLeft, pageTop: v.pageTop } : null,
      layout: { innerWidth, innerHeight, scrollX, scrollY, clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body?.scrollWidth },
      timeline: timeline ? { ...describe(timeline), scrollLeft: timeline.scrollLeft, scrollWidth: timeline.scrollWidth } : null,
    };
  };
  const push = (row) => {
    if (stopped) return;
    if (rows.length >= 1200) { dropped++; stop("capped"); return; }
    rows.push(row);
    if (rows.length === 1200) stop("capped");
  };
  const contacts = (list, rich) => [...(list || [])].map((t) => ({ identifier: t.identifier,
    clientX: t.clientX, clientY: t.clientY, pageX: t.pageX, pageY: t.pageY,
    screenX: t.screenX, screenY: t.screenY, targetId: id(t.target),
    ...(rich ? { target: describe(t.target), hitAtClientPoint: describe(document.elementFromPoint(t.clientX, t.clientY)) } : {}) }));
  const record = (phase) => (event) => {
    if (stopped) return;
    if (!eventIds.has(event)) eventIds.set(event, nextEventId++);
    const eventId = eventIds.get(event);
    const rich = phase === "capture" && !["touchmove", "pointermove", "gesturechange"].includes(event.type);
    const row = { kind: "event", phase, type: event.type, at: performance.now(),
      eventId,
      eventTimestamp: event.timeStamp, isTrusted: event.isTrusted, cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented, detail: event.detail,
      pointerType: event.pointerType, pointerId: event.pointerId, isPrimary: event.isPrimary,
      clientX: event.clientX, clientY: event.clientY,
      gestureScale: event.scale, gestureRotation: event.rotation, targetId: id(event.target),
      touches: contacts(event.touches, rich), changedTouches: contacts(event.changedTouches, rich),
      ...(rich ? { target: describe(event.target), navButton: describe(event.target instanceof Element ? event.target.closest(".mobile-nav button") : null),
        path: event.composedPath().slice(0, 12).map(describe), snapshot: snapshot() } : {}) };
    push(row);
    if (phase === "capture") queueMicrotask(() => {
      if (stopped) return;
      push({ kind: "capture-microtask", type: event.type,
        eventId, eventTimestamp: event.timeStamp, defaultPrevented: event.defaultPrevented });
    });
  };
  const listen = (target, type, handler, capture = false) => {
    target.addEventListener(type, handler, { capture, passive: true });
    listeners.push(() => target.removeEventListener(type, handler, capture));
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "pointercancel", "click", "dblclick", "gesturestart", "gesturechange", "gestureend"]) {
    listen(document, type, record("capture"), true);
    listen(document, type, record("bubble"));
  }
  if (window.visualViewport) for (const type of ["resize", "scroll"]) {
    listen(window.visualViewport, type, () => {
      if (!stopped) push({ kind: "visualViewport-" + type, snapshot: snapshot() });
    });
  }
  let previousNav = document.querySelector(".mobile-nav");
  const observer = new MutationObserver((mutations) => {
    if (stopped) return;
    const nav = document.querySelector(".mobile-nav");
    const related = mutations.filter((m) => m.target instanceof Element &&
      (m.target.matches(".mobile-nav") || m.target.closest(".mobile-nav")));
    if (nav !== previousNav || related.length) push({ kind: "nav-mutation", previousNavId: id(previousNav),
      mutations: related.slice(0, 12).map((m) => ({ type: m.type, attribute: m.attributeName, target: describe(m.target) })), snapshot: snapshot() });
    previousNav = nav;
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["class", "aria-pressed", "style"] });
  const metadata = { version: 1, installedAt: new Date().toISOString(), userAgent: navigator.userAgent,
    timeOrigin: performance.timeOrigin, note: "Passive observation only; no preventDefault, DOM/style changes or input synthesis" };
  let timer;
  const stop = (reason = "manual") => {
    if (!stopped) { stopped = true; stopReason = reason;
      clearTimeout(timer); observer.disconnect(); listeners.forEach((remove) => remove()); }
    return { metadata, rows, dropped, stopped, stopReason };
  };
  window[key] = {
    mark: (label) => { if (!stopped) push({ kind: "mark", label, snapshot: snapshot() }); },
    export: () => ({ metadata, rows, dropped, stopped, stopReason }), stop,
    remove: () => { const result = stop(); delete window[key]; return result; },
  };
  timer = setTimeout(() => stop("timeout"), 120000);
  push({ kind: "installed", snapshot: snapshot() });
  return metadata;
})();
