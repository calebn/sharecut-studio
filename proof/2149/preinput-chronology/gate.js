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
  const chronologyWindow = window;
  const chronologyDocument = document;
  const chronologyViewport = window.visualViewport;
  const chronologyRun = document.currentScript?.getAttribute("data-run");
  const chronologyScriptPath = new URL(document.currentScript.src).pathname;
  const chronologyBundle = /^\/assets\/qa2149-nav-gate-([a-f0-9]{64})\.js$/.exec(chronologyScriptPath)?.[1] || null;
  const chronologyInstance = globalThis.crypto?.randomUUID?.() || null;
  const chronologyOrigin = performance.timeOrigin;
  const chronologyInstalled = performance.now();
  const chronologySources = ["visualViewport:resize", "visualViewport:scroll", "window:resize", "window:scroll"];
  let chronologyLive = 0;
  let chronologyLastAt = chronologyInstalled;
  let chronologyError = null;
  let chronologyContext = null;
  let chronologyPhase = "installation";
  let chronologyNativeRun = null;
  let chronologyTargetStarted = false;
  const chronologySeen = new Set();
  const chronologyNumbers = () => ({ scale: chronologyViewport?.scale, width: chronologyViewport?.width,
    height: chronologyViewport?.height, offsetLeft: chronologyViewport?.offsetLeft,
    offsetTop: chronologyViewport?.offsetTop, scrollX: chronologyWindow.scrollX, scrollY: chronologyWindow.scrollY });
  const chronologyFail = (reason) => { chronologyError ||= reason; finish("chronology-" + reason); };
  const chronologyStatus = () => {
    const at = performance.now();
    const numbers = chronologyNumbers();
    const visibility = document.visibilityState;
    if (condition !== "stopped") {
      if (!chronologyViewport || !chronologyInstance || !chronologyBundle || !/^[a-f0-9]{32}$/.test(chronologyRun || "") || chronologyLive !== 4)
        chronologyFail("unsupported");
      else if (document !== chronologyDocument || window !== chronologyWindow || window.visualViewport !== chronologyViewport)
        chronologyFail("document-changed");
      else if (!Number.isFinite(at) || !Number.isFinite(chronologyOrigin) || performance.timeOrigin !== chronologyOrigin || at < chronologyLastAt)
        chronologyFail("clock-changed");
      else if (at - (rows[0]?.at ?? chronologyInstalled) >= 120000) chronologyFail("deadline");
      else if (visibility !== "visible") chronologyFail("not-visible");
      else if (!Object.values(numbers).every(Number.isFinite) || numbers.scale <= 0 || numbers.width <= 0 || numbers.height <= 0)
        chronologyFail("invalid-viewport");
    }
    return { version: 1, transport_run: chronologyRun, gate_instance: chronologyInstance,
      time_origin: chronologyOrigin, installed_at: chronologyInstalled, at,
      script_path: chronologyScriptPath, bundle_sha256: chronologyBundle,
      original_start: rows[0]?.at ?? chronologyInstalled,
      remaining_ms: 120000 - (at - (rows[0]?.at ?? chronologyInstalled)),
      sources: chronologySources.slice(), live_listeners: chronologyLive,
      shared_rows: rows.length, shared_cap: 600, condition, visibility,
      error: chronologyError, viewport: numbers };
  };
  const chronologyObserve = (source, event) => {
    if (condition === "stopped") return;
    if (source.startsWith("visualViewport:") ? event.target !== chronologyViewport :
        source === "window:resize" ? event.target !== chronologyWindow :
        event.target !== chronologyWindow && event.target !== chronologyDocument) return;
    const at = performance.now();
    const numbers = chronologyNumbers();
    if (at - (rows[0]?.at ?? chronologyInstalled) >= 120000) { chronologyFail("deadline"); return; }
    if (!Number.isFinite(at) || performance.timeOrigin !== chronologyOrigin || at < chronologyLastAt || !Number.isFinite(event.timeStamp)) {
      chronologyFail("clock-changed"); return;
    }
    if (!Object.values(numbers).every(Number.isFinite) || numbers.scale <= 0 || numbers.width <= 0 || numbers.height <= 0) {
      chronologyFail("invalid-viewport"); return;
    }
    chronologyLastAt = at;
    push({ kind: "viewport-chronology", sequence: rows.length, source, type: event.type,
      at, eventTimestamp: event.timeStamp, timeOrigin: chronologyOrigin, condition,
      transport_run: chronologyRun, gate_instance: chronologyInstance,
      context: chronologyContext, phase: chronologyPhase, viewport: numbers });
  };
  const chronologyListen = (target, type, source) => {
    if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") return;
    const listener = (event) => chronologyObserve(source, event);
    target.addEventListener(type, listener, { capture: true, passive: true });
    chronologyLive++;
    removers.push(() => { target.removeEventListener(type, listener, true); chronologyLive--; });
  };
  chronologyListen(chronologyViewport, "resize", chronologySources[0]);
  chronologyListen(chronologyViewport, "scroll", chronologySources[1]);
  chronologyListen(chronologyWindow, "resize", chronologySources[2]);
  chronologyListen(chronologyWindow, "scroll", chronologySources[3]);
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
  metadata.viewportChronology = { version: 1, transport_run: chronologyRun,
    gate_instance: chronologyInstance, time_origin: chronologyOrigin,
    installed_at: chronologyInstalled, sources: chronologySources.slice() };
  const chronologyApi = window[key];
  const chronologyOriginalExport = chronologyApi.export;
  chronologyApi.export = () => {
    const status = chronologyStatus();
    return { ...chronologyOriginalExport(), chronology: status };
  };
  const chronologyOriginalRemove = chronologyApi.remove;
  let chronologyRemoved;
  chronologyApi.remove = () => chronologyRemoved ||= chronologyOriginalRemove();
  chronologyApi.beginChronology = (context) => {
    const keys = ["transport_run", "native_run", "operation_id", "trial_id", "request_sha256", "gate_instance", "label"];
    const exact = context && Object.keys(context).sort().join() === keys.sort().join();
    if (!exact || context.transport_run !== chronologyRun || context.gate_instance !== chronologyInstance ||
        !/^[a-z0-9-]{1,80}$/.test(context.native_run || "") || !/^[a-z0-9-]{1,42}$/.test(context.operation_id || "") ||
        !/^(setup[0-9]*|sham1)$/.test(context.trial_id || "") || !/^[a-f0-9]{64}$/.test(context.request_sha256 || "") ||
        context.label !== "before-native-" + context.operation_id || context.label.length > 60)
      throw new Error("2149 invalid exact chronology context");
    const status = chronologyStatus();
    const identity = context.native_run + "/" + context.operation_id;
    if (condition !== "sham" || status.error || chronologyPhase === "before-native" || chronologySeen.has(identity) ||
        (chronologyNativeRun && context.native_run !== chronologyNativeRun) || chronologyTargetStarted)
      throw new Error("2149 chronology not ready or duplicate operation");
    if (Math.abs(status.viewport.scale - 1) > 1e-6) {
      chronologyFail("nonbaseline-start"); throw new Error("2149 nonbaseline chronology start");
    }
    chronologyNativeRun = context.native_run;
    chronologyTargetStarted = context.trial_id === "sham1";
    chronologySeen.add(identity);
    chronologyContext = Object.freeze({ ...context });
    chronologyPhase = "before-native";
    push({ kind: "chronology-start", label: context.label, context: chronologyContext,
      sequence: rows.length, at: status.at, chronology: status });
    if (condition !== "sham") throw new Error("2149 chronology budget stopped at start");
    return chronologyApi.export();
  };
  chronologyApi.endChronology = (context) => {
    if (chronologyPhase !== "before-native" || !context ||
        Object.keys(context).sort().join() !== Object.keys(chronologyContext).sort().join() ||
        Object.keys(chronologyContext).some((key) => context[key] !== chronologyContext[key]))
      throw new Error("2149 chronology end context mismatch");
    const status = chronologyStatus();
    if (condition !== "sham" || status.error) throw new Error("2149 chronology stopped before end");
    chronologyPhase = "after-observation";
    push({ kind: "chronology-end", label: "after-observation-" + context.operation_id,
      context: chronologyContext, sequence: rows.length, at: status.at, chronology: status });
    return chronologyApi.export();
  };
  timer = setTimeout(() => finish("timeout"), 120000);
  push({ kind: "installed", condition, at: performance.now(), viewport: viewport() });
})();
