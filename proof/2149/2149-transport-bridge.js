(() => {
  const script = document.currentScript;
  const gate = window.__sharecut2149Gate;
  const run = script?.dataset.run;
  const commandURL = new URL(script?.dataset.command || "", location.href);
  const receiptURL = new URL(script?.dataset.receipt || "", location.href);
  if (!gate || !/^[a-f0-9]{32}$/.test(run || "") ||
      [commandURL, receiptURL].some((u) => u.origin !== location.origin || !u.pathname.startsWith("/assets/"))) {
    throw new Error("2149 invalid private transport configuration");
  }
  const instance = crypto.randomUUID();
  const installed = gate.export().rows[0].at;
  if (!Number.isFinite(installed)) throw new Error("2149 missing original gate clock");
  let epoch = -1;
  let previous = null;
  let commandText = null;
  let rowOffset = 0;
  let stopped = false;
  let polls = 0;
  const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0")).join("");
  const request = async (url) => {
    if (performance.now() - installed >= 120000) throw new Error("2149 original gate lifetime exhausted");
    const response = await fetch(url, { cache: "no-store", redirect: "error", credentials: "same-origin",
      signal: AbortSignal.timeout(1500) });
    if (performance.now() - installed >= 120000) throw new Error("2149 original gate lifetime exhausted");
    if (response.status !== 200 || response.url !== url.href) throw new Error("2149 transport HTTP/redirect mismatch");
    return response;
  };
  const send = async (payload) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (bytes.length > 192000) throw new Error("2149 receipt too large");
    const hash = await digest(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const chunks = encoded.match(/.{1,900}/g) || [""];
    for (let i = 0; i <= chunks.length; i++) {
      const url = new URL(receiptURL);
      url.search = new URLSearchParams({ v: "1", run, e: String(payload.epoch),
        k: i === chunks.length ? "end" : "d", i: String(i), n: String(chunks.length),
        h: hash, l: String(bytes.length), b: i === chunks.length ? "" : chunks[i] });
      await request(url);
    }
    return hash;
  };
  const apply = async (command, text) => {
    if (command.v !== 1 || command.run !== run || command.epoch !== epoch + 1 || command.prev !== previous)
      throw new Error("2149 stale/out-of-order command");
    if (!/^[a-z0-9-]{1,60}$/.test(command.label || "")) throw new Error("2149 invalid label");
    const before = gate.export();
    if (before.condition === "stopped") throw new Error("2149 gate expired/capped");
    if (command.epoch === 0 && command.op !== "export") throw new Error("2149 expected ready export");
    if (["sham", "armed"].includes(command.op)) {
      throw new Error("2149 gesture phases disabled: actual native completion validator unavailable");
    } else if (!["mark", "export", "remove"].includes(command.op)) throw new Error("2149 unknown command");
    gate.mark(command.label);
    const snapshot = command.op === "remove" ? gate.remove() : gate.export();
    const rows = snapshot.rows.slice(rowOffset);
    rowOffset = snapshot.rows.length;
    const navs = document.querySelectorAll('nav.mobile-nav[aria-label="Primary"]');
    const timelines = navs.length === 1 ? navs[0].querySelectorAll('[data-presence-anchor="mobile-nav:timeline"]') : [];
    const payload = { v: 1, run, instance, epoch: command.epoch, prev: previous, op: command.op,
      label: command.label, at: performance.now(), timeOrigin: performance.timeOrigin,
      remaining_ms: 120000 - (performance.now() - installed),
      document_identity: { origin: location.origin, pathname: location.pathname,
        sha256: await digest(new TextEncoder().encode(location.href)) },
      base_identity: { origin: new URL(document.baseURI).origin, pathname: new URL(document.baseURI).pathname,
        sha256: await digest(new TextEncoder().encode(document.baseURI)) },
      condition: snapshot.condition, stopReason: snapshot.stopReason, touchCount: snapshot.touchCount,
      timeline_pressed: timelines.length === 1 ? timelines[0].getAttribute("aria-pressed") : null,
      app_zoom: "unobserved",
      activePointerIds: snapshot.activePointerIds, rows, total_rows: rowOffset,
      metadata: epoch === -1 ? snapshot.metadata : undefined,
      cleanup: command.op === "remove" && !window.__sharecut2149Gate };
    previous = await send(payload);
    epoch = command.epoch;
    commandText = text;
    if (command.op === "remove") stopped = true;
  };
  const poll = async () => {
    if (stopped) return;
    try {
      if (gate.export().condition === "stopped") throw new Error("2149 gate stopped");
      const url = new URL(commandURL);
      url.searchParams.set("poll", String(++polls));
      const response = await request(url);
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json"))
        throw new Error("2149 command MIME mismatch");
      const text = await response.text();
      if (text.length > 8192) throw new Error("2149 command too large");
      const command = JSON.parse(text);
      if (command.epoch === epoch) {
        if (text !== commandText) throw new Error("2149 epoch contents changed");
      } else await apply(command, text);
    } catch (error) {
      stopped = true;
      console.error("2149 transport stopped; no phase advance; original gate timeout remains", error);
    }
    if (!stopped) setTimeout(poll, 150);
  };
  void poll();
})();
