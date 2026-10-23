(() => {
  const key = "__sharecut2149Gate";
  if (window[key]) throw new Error("2149 gate already installed");
  if (document.readyState !== "loading" ||
      document.currentScript?.getAttribute("data-qa-2149") !== "prebootstrap-nav-gate" ||
      document.scripts.length !== 1) throw new Error("2149 gate must be the first prebootstrap script");
  const rows = [];
  const eventIds = new WeakMap();
  const nodeIds = new WeakMap();
  const pointerIds = new Set();
  const removers = [];
  let nextEventId = 1;
  let nextNodeId = 1;
  let touchCount = 0;
  let condition = "sham";
  let stopReason = null;
  let timer;
  const node = (element) => {
    if (!(element instanceof Element)) return { kind: element === window ? "window" : element?.nodeName };
    if (!nodeIds.has(element)) nodeIds.set(element, nextNodeId++);
    return { id: nodeIds.get(element), tag: element.localName, domId: element.id,
      classes: element.getAttribute("class"), pressed: element.getAttribute("aria-pressed"),
      anchor: element.getAttribute("data-presence-anchor"), connected: element.isConnected };
  };
  const viewport = () => {
    const v = window.visualViewport;
    return { scale: v?.scale, width: v?.width, height: v?.height,
      offsetLeft: v?.offsetLeft, offsetTop: v?.offsetTop, scrollX, scrollY, innerWidth, innerHeight,
      activeElement: node(document.activeElement) };
  };
  const finish = (reason) => {
    if (condition === "stopped") return;
    condition = "stopped";
    stopReason = reason;
    clearTimeout(timer);
    removers.forEach((remove) => remove());
  };
  const push = (row) => {
    if (condition === "stopped") return;
    rows.push(row);
    if (rows.length === 600) finish("capped");
  };
  const navFor = (event) => {
    const navs = document.querySelectorAll('nav.mobile-nav[aria-label="Primary"]');
    return navs.length === 1 && event.composedPath().includes(navs[0]) ? navs[0] : null;
  };
  const contacts = (list) => [...(list || [])].map((t) => ({ identifier: t.identifier,
    clientX: t.clientX, clientY: t.clientY, pageX: t.pageX, pageY: t.pageY, target: node(t.target) }));
  const observe = (event) => {
    if (condition === "stopped" || !navFor(event)) return;
    const eventId = nextEventId++;
    eventIds.set(event, eventId);
    const trialCondition = condition;
    if (event.type.startsWith("touch")) touchCount = event.touches.length;
    if (event.type === "pointerdown") pointerIds.add(event.pointerId);
    if (event.type === "pointerup" || event.type === "pointercancel") pointerIds.delete(event.pointerId);
    const row = { kind: "first-window-capture", eventId, condition: trialCondition,
      type: event.type, at: performance.now(), eventTimestamp: event.timeStamp,
      isTrusted: event.isTrusted, cancelable: event.cancelable, defaultPrevented: event.defaultPrevented,
      detail: event.detail, pointerId: event.pointerId, pointerType: event.pointerType,
      clientX: event.clientX, clientY: event.clientY, gestureScale: event.scale,
      target: node(event.target), path: event.composedPath().slice(0, 12).map(node),
      touches: contacts(event.touches), changedTouches: contacts(event.changedTouches),
      activePointerIds: [...pointerIds], touchCount, blocked: trialCondition === "armed" };
    if (trialCondition === "armed") event.stopImmediatePropagation();
    push(row);
  };
  const sentinel = (event) => {
    if (condition === "stopped" || !navFor(event)) return;
    push({ kind: "later-window-capture-sentinel", eventId: eventIds.get(event), condition,
      type: event.type, at: performance.now(), isTrusted: event.isTrusted,
      cancelable: event.cancelable, defaultPrevented: event.defaultPrevented });
  };
  const types = ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove",
    "pointerup", "pointercancel", "mousedown", "mouseup", "mousemove", "click", "dblclick",
    "gesturestart", "gesturechange", "gestureend"];
  const listen = (type, callback) => {
    window.addEventListener(type, callback, { capture: true, passive: true });
    removers.push(() => window.removeEventListener(type, callback, true));
  };
  for (const type of types) listen(type, observe);
  for (const type of types) listen(type, sentinel);
  for (const type of ["focus", "focusin", "blur", "focusout"]) listen(type, (event) => {
    if (condition !== "stopped" && navFor(event)) push({ kind: "ungated-focus-observation", condition,
      type, at: performance.now(), eventTimestamp: event.timeStamp, isTrusted: event.isTrusted,
      cancelable: event.cancelable, defaultPrevented: event.defaultPrevented,
      target: node(event.target), path: event.composedPath().slice(0, 12).map(node) });
  });
  const metadata = { version: 1, installedAt: new Date().toISOString(), timeOrigin: performance.timeOrigin,
    readyState: document.readyState, userAgent: navigator.userAgent,
    currentScriptMarker: document.currentScript?.getAttribute("data-qa-2149"),
    scriptsAtInstall: [...document.scripts].map((s) => ({ src: s.src, type: s.type,
      marker: s.getAttribute("data-qa-2149") })),
    gatedTypes: types, ungatedObservedTypes: ["focus", "focusin", "blur", "focusout"],
    warning: "Throwaway diagnostic. Blocks only listed Primary phone nav dispatch while armed. Never prevents default. Focus, scroll and native defaults remain outside the gate. Sentinel proves ordering only for observed dispatch." };
  window[key] = {
    setCondition: (next) => {
      if (condition === "stopped") throw new Error("2149 gate stopped; trial invalid");
      if (!["sham", "armed"].includes(next)) throw new Error("Expected sham or armed");
      if (touchCount || pointerIds.size) throw new Error("Observed contacts not fully released");
      condition = next;
      push({ kind: "condition", condition, at: performance.now(), viewport: viewport() });
    },
    mark: (label) => push({ kind: "mark", label, condition, at: performance.now(), viewport: viewport() }),
    export: () => ({ metadata, condition, stopReason, touchCount, activePointerIds: [...pointerIds], rows }),
    remove: () => { finish("removed"); const result = window[key].export(); delete window[key]; return result; },
  };
  timer = setTimeout(() => finish("timeout"), 120000);
  push({ kind: "installed", condition, at: performance.now(), viewport: viewport() });
})();
