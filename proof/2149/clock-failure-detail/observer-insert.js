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
  let chronologyClockFailure = null;
  let chronologyContext = null;
  let chronologyPhase = "installation";
  let chronologyNativeRun = null;
  let chronologyTargetStarted = false;
  const chronologySeen = new Set();
  const chronologyNumbers = () => ({ scale: chronologyViewport?.scale, width: chronologyViewport?.width,
    height: chronologyViewport?.height, offsetLeft: chronologyViewport?.offsetLeft,
    offsetTop: chronologyViewport?.offsetTop, scrollX: chronologyWindow.scrollX, scrollY: chronologyWindow.scrollY });
  const chronologyFail = (reason) => { chronologyError ||= reason; finish("chronology-" + reason); };
  const chronologyClockValue = (value) => {
    const finite = Number.isFinite(value);
    return Object.freeze({ value: finite || typeof value === "string" || typeof value === "boolean" ? value : null,
      finite, type: typeof value,
      tag: finite ? null : typeof value === "number" ? String(value) : value === null ? "null" : typeof value });
  };
  const chronologyClockFail = (site, at, currentOrigin, eventTimestamp, failed, source = null, type = null) => {
    if (!chronologyClockFailure) chronologyClockFailure = Object.freeze({
      site, source, type, context: chronologyContext, phase: chronologyPhase,
      failed: Object.freeze(failed),
      samples: Object.freeze({ now: chronologyClockValue(at), current_origin: chronologyClockValue(currentOrigin),
        captured_origin: chronologyClockValue(chronologyOrigin), last_at: chronologyClockValue(chronologyLastAt),
        event_timestamp: chronologyClockValue(eventTimestamp) }),
    });
    chronologyFail("clock-changed");
  };
  const chronologyStatus = () => {
    const at = performance.now();
    const numbers = chronologyNumbers();
    const visibility = document.visibilityState;
    if (condition !== "stopped") {
      if (!chronologyViewport || !chronologyInstance || !chronologyBundle || !/^[a-f0-9]{32}$/.test(chronologyRun || "") || chronologyLive !== 4)
        chronologyFail("unsupported");
      else if (document !== chronologyDocument || window !== chronologyWindow || window.visualViewport !== chronologyViewport)
        chronologyFail("document-changed");
      else {
        const currentOrigin = performance.timeOrigin;
        if (!Number.isFinite(at) || !Number.isFinite(chronologyOrigin) || currentOrigin !== chronologyOrigin || at < chronologyLastAt)
          chronologyClockFail("status", at, currentOrigin, undefined, {
            now_nonfinite: !Number.isFinite(at), captured_origin_nonfinite: !Number.isFinite(chronologyOrigin),
            origin_changed: currentOrigin !== chronologyOrigin, now_before_last_at: at < chronologyLastAt,
          });
        else if (at - (rows[0]?.at ?? chronologyInstalled) >= 120000) chronologyFail("deadline");
        else if (visibility !== "visible") chronologyFail("not-visible");
        else if (!Object.values(numbers).every(Number.isFinite) || numbers.scale <= 0 || numbers.width <= 0 || numbers.height <= 0)
          chronologyFail("invalid-viewport");
      }
    }
    return { version: 1, transport_run: chronologyRun, gate_instance: chronologyInstance,
      time_origin: chronologyOrigin, installed_at: chronologyInstalled, at,
      script_path: chronologyScriptPath, bundle_sha256: chronologyBundle,
      original_start: rows[0]?.at ?? chronologyInstalled,
      remaining_ms: 120000 - (at - (rows[0]?.at ?? chronologyInstalled)),
      sources: chronologySources.slice(), live_listeners: chronologyLive,
      shared_rows: rows.length, shared_cap: 600, condition, visibility,
      error: chronologyError, clock_failure: chronologyClockFailure, viewport: numbers };
  };
  const chronologyObserve = (source, event) => {
    if (condition === "stopped") return;
    if (source.startsWith("visualViewport:") ? event.target !== chronologyViewport :
        source === "window:resize" ? event.target !== chronologyWindow :
        event.target !== chronologyWindow && event.target !== chronologyDocument) return;
    const at = performance.now();
    const numbers = chronologyNumbers();
    if (at - (rows[0]?.at ?? chronologyInstalled) >= 120000) { chronologyFail("deadline"); return; }
    const currentOrigin = performance.timeOrigin;
    const eventTimestamp = event.timeStamp;
    if (!Number.isFinite(at) || currentOrigin !== chronologyOrigin || at < chronologyLastAt || !Number.isFinite(eventTimestamp)) {
      chronologyClockFail("observer", at, currentOrigin, eventTimestamp, {
        now_nonfinite: !Number.isFinite(at), origin_changed: currentOrigin !== chronologyOrigin,
        now_before_last_at: at < chronologyLastAt, event_timestamp_nonfinite: !Number.isFinite(eventTimestamp),
      }, source, event.type);
      return;
    }
    if (!Object.values(numbers).every(Number.isFinite) || numbers.scale <= 0 || numbers.width <= 0 || numbers.height <= 0) {
      chronologyFail("invalid-viewport"); return;
    }
    chronologyLastAt = at;
    push({ kind: "viewport-chronology", sequence: rows.length, source, type: event.type,
      at, eventTimestamp, timeOrigin: chronologyOrigin, condition,
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
